/**
 * Replicate + quantify the serial-vs-parallel file-read cost in the DuckDB
 * executor's BUFFER path (the path taken by `R2DataSource` with no
 * `bucketName`, where bytes are shipped into the vFS instead of read via a
 * native `r2://` URI).
 *
 * A filesystem/R2-with-bucketName source exposes `uri()`, so that path never
 * runs and `files.register` is ~0ms. To see what production-without-bucketName
 * pays we force the buffer path (a DataSource with NO `uri()`) and inject a
 * per-read latency standing in for an R2 GET round-trip, then time the OLD
 * serial loop, a parallel read, and the SHIPPED executor against it.
 *
 * Usage:
 *   pnpm --filter @gscdump/engine exec tsx scripts/profile-read-path.mts <parquetDir> \
 *     [--files=14,100] [--latencies=0,20,60]
 *
 *   <parquetDir>  directory of .parquet files to use as the fixture. Defaults to
 *                 $GSCDUMP_PARQUET_DIR, else a local CLI store path if present.
 *   --files       comma-separated file counts to test (default 14,100)
 *   --latencies   comma-separated per-read latencies in ms (default 0,20,60)
 */
import type { DataSource } from '../src/storage'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { createNodeDuckDBHandle, resetNodeDuckDB } from '../src/adapters/duckdb-node'
import { createDuckDBExecutor } from '../src/duckdb'
import { substituteNamedFiles } from '../src/parquet-plan'
import { collectSpans } from '../src/profile'

// Table-agnostic: COUNT(*) still opens + scans every file without assuming any
// particular column exists, so the fixture can be any table's parquet.
const SQL = 'SELECT COUNT(*)::BIGINT AS n FROM read_parquet({{FILES}}, union_by_name = true)'

function parseArgs(argv: string[]): { dir: string, files: number[], latencies: number[] } {
  const positional = argv.find(a => !a.startsWith('--'))
  const flag = (name: string): string | undefined =>
    argv.find(a => a.startsWith(`--${name}=`))?.split('=')[1]
  const nums = (s: string | undefined, fallback: number[]): number[] =>
    s ? s.split(',').map(Number).filter(n => Number.isFinite(n)) : fallback

  const fallbackStore = join(homedir(), '.gscdump/data/u_local/d_harlanzw.com/pages/daily')
  const dir = positional ?? process.env.GSCDUMP_PARQUET_DIR ?? fallbackStore
  return {
    dir,
    files: nums(flag('files'), [14, 100]),
    latencies: nums(flag('latencies'), [0, 20, 60]),
  }
}

const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))

/** Load up to N real parquet files into memory so disk read isn't in the loop. */
function loadFixture(dir: string, n: number): Map<string, Uint8Array> {
  const files = readdirSync(dir).filter(f => f.endsWith('.parquet')).slice(0, n)
  const map = new Map<string, Uint8Array>()
  for (const f of files)
    map.set(f, new Uint8Array(readFileSync(join(dir, f))))
  return map
}

/** A buffer-path DataSource (NO uri) whose every read costs `latencyMs`. */
function latentSource(bytes: Map<string, Uint8Array>, latencyMs: number): DataSource {
  return {
    async read(key) {
      if (latencyMs > 0)
        await sleep(latencyMs)
      const b = bytes.get(key)
      if (!b)
        throw new Error(`missing ${key}`)
      return b
    },
    async write() { throw new Error('read-only fixture') },
    async delete() {},
    async list() { return [] },
    // deliberately no `uri` → forces the serial buffer path
  }
}

/** SERIAL: read+register one file at a time — the OLD executor loop. */
async function serial(db: ReturnType<typeof createNodeDuckDBHandle>, ds: DataSource, keys: string[]): Promise<number> {
  const t0 = performance.now()
  const registered: string[] = []
  for (const key of keys) {
    const b = await ds.read(key)
    await db.registerFileBuffer(key, b)
    registered.push(key)
  }
  const ms = performance.now() - t0
  await db.dropFiles(registered)
  return ms
}

/** PARALLEL: read all files at once, then register — the shipped approach. */
async function parallel(db: ReturnType<typeof createNodeDuckDBHandle>, ds: DataSource, keys: string[]): Promise<number> {
  const t0 = performance.now()
  const buffers = await Promise.all(keys.map(k => ds.read(k)))
  for (let i = 0; i < keys.length; i++)
    await db.registerFileBuffer(keys[i]!, buffers[i]!)
  const ms = performance.now() - t0
  await db.dropFiles(keys)
  return ms
}

async function queryRun(db: ReturnType<typeof createNodeDuckDBHandle>, ds: DataSource, keys: string[]): Promise<number> {
  for (const key of keys)
    await db.registerFileBuffer(key, await ds.read(key))
  const sql = substituteNamedFiles(SQL, { FILES: keys })
  const t0 = performance.now()
  await db.query(sql)
  const ms = performance.now() - t0
  await db.dropFiles(keys)
  return ms
}

/** The SHIPPED executor's files.register span against the latency source. */
async function executorRegister(ds: DataSource, keys: string[]): Promise<number> {
  const handle = createNodeDuckDBHandle()
  const executor = createDuckDBExecutor({ getDuckDB: async () => handle })
  const { profiler, spans } = collectSpans()
  await executor.execute({
    sql: SQL,
    params: [],
    fileKeys: { FILES: keys },
    dataSource: ds,
    table: 'pages',
    profiler,
  })
  return spans.find(s => s.name === 'files.register')?.ms ?? Number.NaN
}

const { dir, files, latencies } = parseArgs(process.argv.slice(2))
if (!existsSync(dir)) {
  console.error(`parquet dir not found: ${dir}`)
  console.error('pass a directory of .parquet files as the first arg, or set GSCDUMP_PARQUET_DIR')
  process.exit(1)
}
const onDisk = readdirSync(dir).filter(f => f.endsWith('.parquet')).length
// cartesian of file-counts × latencies, skipping counts the fixture can't fill
const scenarios = files
  .flatMap(f => latencies.map(latency => ({ files: f, latency })))
  .sort((a, b) => a.files - b.files || a.latency - b.latency)

console.log(`fixture: ${dir} (${onDisk} parquet files on disk)`)
console.log(`\n  files  latency   serial    parallel   speedup   executor   query.run`)
console.log(`  -----  -------   -------   --------   -------   --------   ---------`)
for (const sc of scenarios) {
  const fixture = loadFixture(dir, sc.files)
  const keys = [...fixture.keys()]
  if (keys.length < sc.files) {
    console.log(`  (only ${keys.length} files on disk, skipping ${sc.files})`)
    continue
  }
  const ds = latentSource(fixture, sc.latency)
  const db = createNodeDuckDBHandle()
  // warm the connection so the first scenario isn't penalised
  await db.query('SELECT 1')
  const sMs = await serial(db, ds, keys)
  const pMs = await parallel(db, ds, keys)
  const eMs = await executorRegister(ds, keys) // the shipped createDuckDBExecutor
  const qMs = await queryRun(db, ds, keys)
  const speedup = (sMs / pMs).toFixed(1)
  console.log(
    `  ${String(sc.files).padStart(5)}  ${String(`${sc.latency}ms`).padStart(7)}   `
    + `${`${sMs.toFixed(0)}ms`.padStart(7)}   ${`${pMs.toFixed(0)}ms`.padStart(8)}   `
    + `${`${speedup}x`.padStart(7)}   ${`${eMs.toFixed(0)}ms`.padStart(8)}   ${`${qMs.toFixed(0)}ms`.padStart(9)}`,
  )
}
resetNodeDuckDB()

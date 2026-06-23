/**
 * End-to-end storage + query benchmark for the DuckDB/Parquet read path.
 *
 * Where `profile-read-path.mts` isolates the buffer-read register span with a
 * synthetic latency, this drives the SHIPPED codec + executor against a REAL
 * on-disk store and reports the three numbers the optimization goal cares
 * about, per table:
 *
 *   - storage: raw daily bytes + file count vs the single compacted file the
 *     shipped `codec.compactRows` produces (so it measures exactly what
 *     prod compaction writes, ORDER BY clusterKey and all).
 *   - query latency: a top-N aggregate and a point lookup, run via the real
 *     `executor.execute` against (a) every daily file and (b) the one compacted
 *     file, with the profiler's `files.register` / `query.run` spans broken out.
 *   - memory: process RSS delta across the run.
 *
 * The fixture is the local CLI store (`~/.gscdump/data`), which is laid out as
 * one tiny parquet file per day per table — the exact shape that makes the
 * many-files read path expensive, so the before/after is honest.
 *
 * Usage:
 *   pnpm --filter @gscdump/engine exec tsx scripts/benchmark-store.mts \
 *     [rootDir] [--user=u_local] [--site=d_nuxtseo.com] \
 *     [--tables=pages,page_queries,keywords,countries]
 *
 *   rootDir   store root holding `<user>/<site>/<table>/daily/*.parquet`.
 *             Defaults to $GSCDUMP_DATA_DIR, else `~/.gscdump/data`.
 */
import type { CodecCtx, TableName } from '../src/storage'
import { existsSync, rmSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { createNodeDuckDBHandle, resetNodeDuckDB } from '../src/adapters/duckdb-node'
import { createFilesystemDataSource } from '../src/adapters/filesystem'
import { createDuckDBCodec, createDuckDBExecutor } from '../src/duckdb'
import { collectSpans } from '../src/profile'
import { TABLE_METADATA } from '../src/schema'

/**
 * On-disk store directory → engine `TableName`. The local CLI store keeps
 * legacy dimension-named directories (`keywords`, `page_keywords`, `devices`)
 * that map onto the engine's canonical table names, which drive the schema
 * (clusterKey, dedup) the compaction codec needs.
 */
const DIR_TO_TABLE: Record<string, TableName> = {
  pages: 'pages',
  page_keywords: 'page_queries',
  keywords: 'queries',
  countries: 'countries',
  devices: 'dates',
  page_queries: 'page_queries',
  queries: 'queries',
}

interface Args {
  rootDir: string
  user: string
  site: string
  dirs: string[]
}

function parseArgs(argv: string[]): Args {
  const positional = argv.find(a => !a.startsWith('--'))
  const flag = (name: string): string | undefined =>
    argv.find(a => a.startsWith(`--${name}=`))?.split('=')[1]
  const rootDir = positional ?? process.env.GSCDUMP_DATA_DIR ?? join(homedir(), '.gscdump/data')
  const defaultDirs = ['pages', 'page_keywords', 'keywords', 'countries']
  return {
    rootDir,
    user: flag('user') ?? 'u_local',
    site: flag('site') ?? 'd_nuxtseo.com',
    dirs: flag('tables')?.split(',') ?? defaultDirs,
  }
}

function fmtBytes(n: number): string {
  return n >= 1e6 ? `${(n / 1e6).toFixed(2)}MB` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}KB` : `${n}B`
}

/** Median wall-time (ms) of `runs` executions of `fn`, after one warm-up. */
async function median(runs: number, fn: () => Promise<void>): Promise<number> {
  await fn() // warm
  const times: number[] = []
  for (let i = 0; i < runs; i++) {
    const t0 = performance.now()
    await fn()
    times.push(performance.now() - t0)
  }
  times.sort((a, b) => a - b)
  return times[Math.floor(times.length / 2)]!
}

const { rootDir, user, site, dirs } = parseArgs(process.argv.slice(2))
if (!existsSync(rootDir)) {
  console.error(`store root not found: ${rootDir}`)
  process.exit(1)
}

const ds = createFilesystemDataSource({ rootDir })
const handle = createNodeDuckDBHandle()
const factory = { getDuckDB: async () => handle }
const codec = createDuckDBCodec(factory)
const executor = createDuckDBExecutor(factory)

const rss0 = process.memoryUsage().rss
await handle.query('SELECT 1') // warm the connection

console.log(`store:  ${rootDir}`)
console.log(`tenant: ${user}/${site}`)
console.log(
  `\n  table           files     raw   compacted   saved   topN(many→one)   point(many→one)`,
)
console.log(
  `  --------------  -----  ------   ---------   -----   --------------   ---------------`,
)

for (const dir of dirs) {
  const table = DIR_TO_TABLE[dir]
  if (!table) {
    console.log(`  ${dir.padEnd(14)}  (no engine table mapping, skipping)`)
    continue
  }
  const ctx: CodecCtx = { table }
  const prefix = `${user}/${site}/${dir}/daily`
  const keys = (await ds.list(prefix)).filter(k => k.endsWith('.parquet'))
  if (keys.length === 0) {
    console.log(`  ${dir.padEnd(14)}  (no daily parquet under ${prefix}, skipping)`)
    continue
  }

  const rawBytes = keys.reduce((n, k) => n + statSync(join(rootDir, k)).size, 0)

  // Real shipped compaction → one file. Measures exactly what prod writes.
  const outKey = `${user}/${site}/${dir}/_bench/compact.parquet`
  const { bytes: compactBytes } = await codec.compactRows(ctx, keys, outKey, ds)
  const saved = 1 - compactBytes / rawBytes

  // clusterKey[0] is the dimension-first column (url/query/country/…) — the one
  // a dashboard groups + filters on, and the one compaction now clusters by.
  const dim = TABLE_METADATA[table].clusterKey[0] ?? 'date'
  const topNSql = `SELECT "${dim}" AS d, SUM(clicks) AS c FROM read_parquet({{FILES}}, union_by_name = true) GROUP BY d ORDER BY c DESC LIMIT 50`

  // Hottest dim value for the point lookup, read from the compacted file.
  const hotRows = await handle.query(
    `SELECT "${dim}" AS d FROM read_parquet('${ds.uri!(outKey)}') GROUP BY d ORDER BY SUM(clicks) DESC LIMIT 1`,
  ) as Array<{ d: unknown }>
  const hot = String(hotRows[0]?.d ?? '')
  const pointSql = `SELECT SUM(clicks) AS c FROM read_parquet({{FILES}}, union_by_name = true) WHERE "${dim}" = $1`

  const runQuery = (sql: string, fileKeys: string[], params: unknown[]) => async (): Promise<void> => {
    await executor.execute({ sql, params, fileKeys: { FILES: fileKeys }, dataSource: ds, table })
  }

  const topMany = await median(5, runQuery(topNSql, keys, []))
  const topOne = await median(5, runQuery(topNSql, [outKey], []))
  const ptMany = await median(5, runQuery(pointSql, keys, [hot]))
  const ptOne = await median(5, runQuery(pointSql, [outKey], [hot]))

  console.log(
    `  ${dir.padEnd(14)}  ${String(keys.length).padStart(5)}  `
    + `${fmtBytes(rawBytes).padStart(6)}   ${fmtBytes(compactBytes).padStart(9)}   `
    + `${`${(saved * 100).toFixed(0)}%`.padStart(5)}   `
    + `${`${topMany.toFixed(1)}→${topOne.toFixed(1)}ms`.padStart(14)}   `
    + `${`${ptMany.toFixed(1)}→${ptOne.toFixed(1)}ms`.padStart(15)}`,
  )

  // Remove the whole scratch dir, not just the file, so the run leaves the
  // store exactly as it found it.
  rmSync(join(rootDir, `${user}/${site}/${dir}/_bench`), { recursive: true, force: true })
}

// One profiled run on the first table to show the span breakdown.
const probeDir = dirs[0]!
const probeTable = DIR_TO_TABLE[probeDir]
const probePrefix = `${user}/${site}/${probeDir}/daily`
const probeKeys = probeTable ? (await ds.list(probePrefix)).filter(k => k.endsWith('.parquet')) : []
if (probeTable && probeKeys.length > 0) {
  const dim = TABLE_METADATA[probeTable].clusterKey[0] ?? 'date'
  const sql = `SELECT "${dim}" AS d, SUM(clicks) AS c FROM read_parquet({{FILES}}, union_by_name = true) GROUP BY d ORDER BY c DESC LIMIT 50`
  const { profiler, spans } = collectSpans()
  await executor.execute({ sql, params: [], fileKeys: { FILES: probeKeys }, dataSource: ds, table: probeTable, profiler })
  console.log(`\n  span breakdown — ${probeDir} top-N over ${probeKeys.length} daily files:`)
  for (const s of spans)
    console.log(`    ${s.name.padEnd(16)} ${s.ms.toFixed(1)}ms${s.meta ? `  ${JSON.stringify(s.meta)}` : ''}`)
}

const rssMB = (process.memoryUsage().rss - rss0) / 1e6
console.log(`\n  RSS delta: ${rssMB.toFixed(0)}MB`)
resetNodeDuckDB()

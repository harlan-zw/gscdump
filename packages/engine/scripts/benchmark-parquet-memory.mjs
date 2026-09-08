import { strictEqual } from 'node:assert'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { cpus } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { createHyparquetCodec, decodeParquetToRows, encodeRowsToParquet } from '@gscdump/engine/hyparquet'

// Build the Engine before each revision.
// Prepare once, then run both revisions against the same files:
// node packages/engine/scripts/benchmark-parquet-memory.mjs prepare /tmp/parquet-memory
// node packages/engine/scripts/benchmark-parquet-memory.mjs run /tmp/parquet-memory
// Each sample gets a fresh process. Fixture generation and output validation
// happen outside the measured operation. maxRSS includes the Node runtime.
const cases = ['decode-small', 'decode-large', 'compact-daily', 'compact-overlap']
const rowsPerDay = 50_000
const dayCount = 8
const totalRows = rowsPerDay * dayCount

function fixtureRow(index, corrected = false) {
  return {
    date: `2026-04-${String(1 + Math.floor(index / rowsPerDay)).padStart(2, '0')}`,
    url: `https://example.com/docs/page/${index % 10_000}`,
    query: `search query ${index % rowsPerDay}`,
    clicks: corrected ? 999 : index % 31,
    impressions: 100 + index % 1000,
    sum_position: index % 997 + 0.5,
  }
}

function child(args) {
  const result = spawnSync(process.execPath, [
    '--expose-gc',
    '--max-old-space-size=2048',
    fileURLToPath(import.meta.url),
    ...args,
  ], { encoding: 'utf8', maxBuffer: 1024 * 1024 })
  if (result.error)
    throw result.error
  if (result.status !== 0)
    throw new Error(`Benchmark process failed: ${result.stderr}`)
  return result.stdout.trim()
}

const [command, directory, caseName] = process.argv.slice(2)
if (!directory)
  throw new Error('Pass prepare or run, followed by a fixture directory')

if (command === 'prepare') {
  await mkdir(directory, { recursive: true })
  for (let day = 0; day < dayCount; day++) {
    const rows = Array.from({ length: rowsPerDay }, (_, i) => fixtureRow(day * rowsPerDay + i))
    await writeFile(join(directory, `day-${day}.parquet`), encodeRowsToParquet('page_queries', rows))
  }
  await writeFile(join(directory, 'small.parquet'), encodeRowsToParquet('page_queries', Array.from({ length: 1000 }, (_, i) => fixtureRow(i))))
  await writeFile(join(directory, 'large.parquet'), encodeRowsToParquet('page_queries', Array.from({ length: totalRows }, (_, i) => fixtureRow(i))))
  await writeFile(join(directory, 'correction.parquet'), encodeRowsToParquet('page_queries', Array.from({ length: rowsPerDay }, (_, i) => fixtureRow(i, true))))
}
else if (command === 'sample') {
  if (!cases.includes(caseName))
    throw new Error(`Unknown benchmark case: ${caseName}`)
  const source = {
    read: key => readFile(join(directory, key)),
    write: (key, bytes) => writeFile(join(directory, key), bytes),
    async delete(keys) {
      for (const key of keys)
        await rm(join(directory, key))
    },
    async list() { throw new Error('Benchmark does not list files') },
  }
  const compact = caseName.startsWith('compact')
  const expectedRows = caseName === 'decode-small' ? 1000 : totalRows
  const input = compact ? undefined : await source.read(caseName === 'decode-small' ? 'small.parquet' : 'large.parquet')
  const codec = createHyparquetCodec()
  const outputKey = `output-${process.pid}.parquet`
  globalThis.gc()
  const baseline = process.memoryUsage()
  const started = performance.now()
  const result = compact
    ? await codec.compactRows({ table: 'page_queries' }, caseName === 'compact-daily'
        ? Array.from({ length: dayCount }, (_, i) => `day-${i}.parquet`)
        : ['large.parquet', 'correction.parquet'], outputKey, source)
    : await decodeParquetToRows(input)
  const elapsedMs = performance.now() - started
  const peakRssMiB = process.resourceUsage().maxRSS / 1024
  globalThis.gc()
  const retainedHeapMiB = (process.memoryUsage().heapUsed - baseline.heapUsed) / 1024 ** 2
  const rowCount = Array.isArray(result) ? result.length : result.rowCount
  strictEqual(rowCount, expectedRows)
  // Hash every output field after capturing memory and time. Compare hashes
  // across revisions. Compaction uses the deterministic encoded file directly.
  const hash = createHash('sha256')
  if (Array.isArray(result)) {
    for (const row of result)
      hash.update(JSON.stringify(row, (_key, value) => typeof value === 'bigint' ? String(value) : value))
  }
  else {
    hash.update(await source.read(outputKey))
    await source.delete([outputKey])
  }
  console.log(JSON.stringify({ case: caseName, rowCount, elapsedMs, peakRssMiB, retainedHeapMiB, baselineRssMiB: baseline.rss / 1024 ** 2, sha256: hash.digest('hex') }))
}
else if (command === 'run') {
  console.log(JSON.stringify({ node: process.version, cpu: cpus()[0]?.model, rowsPerDay, dayCount, samples: 5 }))
  for (const name of cases) {
    for (let sample = 0; sample < 5; sample++)
      console.log(child(['sample', directory, name]))
  }
}
else {
  throw new Error(`Unknown benchmark command: ${command}`)
}

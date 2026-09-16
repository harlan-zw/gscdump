import { strictEqual } from 'node:assert'
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import process from 'node:process'
import { pathToFileURL } from 'node:url'

// Decodes one Parquet file of 200,000 rows and reports the wall clock of the
// decode alone. Fixture generation and output hashing sit outside the measured
// span. Lifted from packages/engine/scripts/benchmark-parquet-memory.mjs.
const rowCount = 200_000

function argument(name) {
  const index = process.argv.indexOf(`--${name}`)
  const value = index === -1 ? undefined : process.argv[index + 1]
  if (value === undefined)
    throw new Error(`Pass --${name}`)
  return value
}

function fixtureRow(index) {
  return {
    date: `2026-04-${String(1 + Math.floor(index / 50_000)).padStart(2, '0')}`,
    url: `https://example.com/docs/page/${index % 10_000}`,
    query: `search query ${index % 50_000}`,
    clicks: index % 31,
    impressions: 100 + index % 1000,
    sum_position: index % 997 + 0.5,
  }
}

const command = process.argv[2]
const root = argument('root')
const fixtures = argument('fixtures')
const fixture = join(fixtures, 'decode-parquet.parquet')
// Each side resolves its own export map, so a revision that moves the built
// file is still measured, and a revision that drops the export fails loudly.
const manifest = JSON.parse(readFileSync(join(root, 'packages/engine/package.json'), 'utf8'))
const entry = manifest.exports['./hyparquet']?.import
if (entry === undefined)
  throw new Error('This revision of @gscdump/engine exports no ./hyparquet')
const engine = await import(pathToFileURL(join(root, 'packages/engine', entry)).href)

if (command === 'prepare') {
  const rows = Array.from({ length: rowCount }, (_, index) => fixtureRow(index))
  writeFileSync(fixture, engine.encodeRowsToParquet('page_queries', rows))
  console.log(JSON.stringify({ value: rowCount }))
}
else if (command === 'sample') {
  const input = readFileSync(fixture)
  globalThis.gc()
  const started = performance.now()
  const rows = await engine.decodeParquetToRows(input)
  const elapsedMs = performance.now() - started
  strictEqual(rows.length, rowCount)
  const hash = createHash('sha256')
  for (const row of rows)
    hash.update(JSON.stringify(row, (_key, value) => typeof value === 'bigint' ? String(value) : value))
  console.log(JSON.stringify({ value: elapsedMs, checksum: hash.digest('hex') }))
}
else {
  throw new Error(`Unknown command: ${command}`)
}

import { deepStrictEqual } from 'node:assert'
import { createRequire } from 'node:module'
import { cpus } from 'node:os'
import process from 'node:process'
// @ts-expect-error blocking bindings have no published declaration
import { createDuckDB, NODE_RUNTIME, VoidLogger } from '@duckdb/duckdb-wasm/dist/duckdb-node-blocking.cjs'
import { arrowToRows } from '../src/arrow-utils'

const require = createRequire(import.meta.url)
const db = await createDuckDB({
  mvp: { mainModule: require.resolve('@duckdb/duckdb-wasm/dist/duckdb-mvp.wasm') },
  eh: { mainModule: require.resolve('@duckdb/duckdb-wasm/dist/duckdb-eh.wasm') },
}, new VoidLogger(), NODE_RUNTIME)
await db.instantiate()
const conn = db.connect()

function measure(fn: () => unknown) {
  for (let i = 0; i < 3; i++)
    fn()
  const samples = Array.from({ length: 9 }, () => {
    const start = performance.now()
    fn()
    return performance.now() - start
  }).sort((a, b) => a - b)
  return { medianMs: samples[4], minMs: samples[0], maxMs: samples[8] }
}

console.log(JSON.stringify({ node: process.version, cpu: cpus()[0]?.model, duckdb: arrowToRows(conn.query('SELECT version() AS version')) }))
try {
  for (const size of [50, 10_000, 100_000]) {
    const sql = `SELECT 'https://example.com/page/' || (i % 5000) AS url,
      'search query ' || (i % 10000) AS query, DATE '2026-04-01' + CAST(i % 28 AS INTEGER) AS date,
      i AS clicks, i * 10 AS impressions, i * 15.5 AS sum_position,
      CASE WHEN i % 7 = 0 THEN NULL ELSE 'desktop' END AS device
      FROM range(${size}) t(i)`
    const table = conn.query(sql)
    const expected = table.toArray().map((row: { toJSON: () => unknown }) => row.toJSON())
    deepStrictEqual(arrowToRows(table), expected)
    console.log(JSON.stringify({ rows: size, conversion: measure(() => arrowToRows(table)), query: measure(() => arrowToRows(conn.query(sql))) }))
  }
}
finally {
  conn.close()
  db.reset()
}

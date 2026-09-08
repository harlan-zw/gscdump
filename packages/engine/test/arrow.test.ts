import { createRequire } from 'node:module'
// @ts-expect-error blocking bindings have no published declaration
import { createDuckDB, NODE_RUNTIME, VoidLogger } from '@duckdb/duckdb-wasm/dist/duckdb-node-blocking.cjs'
import { arrowToRows } from '@gscdump/engine/arrow'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
let db: Awaited<ReturnType<typeof createDuckDB>>
let conn: ReturnType<typeof db.connect>

beforeAll(async () => {
  db = await createDuckDB({
    mvp: { mainModule: require.resolve('@duckdb/duckdb-wasm/dist/duckdb-mvp.wasm') },
    eh: { mainModule: require.resolve('@duckdb/duckdb-wasm/dist/duckdb-eh.wasm') },
  }, new VoidLogger(), NODE_RUNTIME)
  await db.instantiate()
  conn = db.connect()
})

afterAll(() => {
  conn?.close()
  db?.reset()
})

describe('arrowToRows', () => {
  it.each([0, 1, 10_000])('preserves values across Arrow batches with %i rows', (size) => {
    const table = conn.query(`SELECT i AS clicks,
      CASE WHEN i % 7 = 0 THEN NULL ELSE 'café 搜索 ' || i END AS query,
      DATE '2026-04-01' + CAST(i % 28 AS INTEGER) AS date,
      CAST(i / 10.0 AS DOUBLE) AS position, i % 2 = 0 AS active
      FROM range(${size}) t(i)`)
    const expected = table.toArray().map((row: { toJSON: () => unknown }) => row.toJSON())
    expect(arrowToRows(table)).toEqual(expected)
    if (size > 0)
      expect(arrowToRows(table)[0]).toEqual({ clicks: 0n, query: null, date: Date.UTC(2026, 3, 1), position: 0, active: true })
  })

  it('preserves sliced vectors and nullable nested values', () => {
    const table = conn.query(`SELECT i,
      CASE WHEN i % 2 = 0 THEN NULL ELSE [i, NULL, i + 1] END AS items,
      {'query': 'term ' || i, 'clicks': i} AS metrics,
      CAST(i AS DECIMAL(18, 2)) AS revenue
      FROM range(10000) t(i)`).slice(2047, 4099)
    // Nested Arrow vectors can hold different backing slices with equal values.
    const materialize = (row: Record<string, any>) => ({
      ...row,
      items: row.items === null ? null : Array.from(row.items),
      metrics: row.metrics.toJSON(),
    })
    const expected = table.toArray().map((row: { toJSON: () => Record<string, unknown> }) => materialize(row.toJSON()))
    expect(arrowToRows(table).map(materialize)).toEqual(expected)
  })

  it('uses the last value for duplicate column names', () => {
    expect(arrowToRows(conn.query('SELECT 1 AS clicks, 2 AS clicks'))).toEqual([{ clicks: 2 }])
  })

  it('preserves row arrays and table wrappers', () => {
    const rows = [{ clicks: 3n, query: null }]
    expect(arrowToRows(rows)).toEqual(rows)
    expect(arrowToRows({ toArray: () => rows })).toEqual(rows)
    expect(arrowToRows({ toArray: () => [{ toJSON: () => rows[0] }] })).toEqual(rows)
    expect(arrowToRows(null)).toEqual([])
  })
})

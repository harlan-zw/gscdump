import { afterAll, describe, expect, it } from 'vitest'
import {
  createNodeDuckDBHandle,
  resetNodeDuckDB,
} from '../../src/analytics/adapters/duckdb-node'
import {
  createDuckDBCodec,
  createDuckDBExecutor,
} from '../../src/analytics/duckdb'

afterAll(() => {
  resetNodeDuckDB()
})

describe('duckDB (Node blocking) smoke', () => {
  it('runs a trivial SELECT and returns rows', async () => {
    const handle = createNodeDuckDBHandle()
    const rows = await handle.query('SELECT 1 AS x UNION ALL SELECT 2')
    expect(rows).toEqual([{ x: 1 }, { x: 2 }])
  })

  it('roundtrips rows through parquet via the codec', async () => {
    const handle = createNodeDuckDBHandle()
    const codec = createDuckDBCodec({ getDuckDB: async () => handle })

    const input = [
      { url: '/', date: '2026-04-10', clicks: 5, impressions: 100, sum_position: 500.0 },
      { url: '/about', date: '2026-04-10', clicks: 2, impressions: 50, sum_position: 150.0 },
    ]

    const bytes = await codec.encode('pages', input)
    expect(bytes.byteLength).toBeGreaterThan(50)

    const decoded = await codec.decode(bytes)
    expect(decoded).toHaveLength(2)
    const sorted = [...decoded].sort((a, b) => String(a.url).localeCompare(String(b.url)))
    expect(sorted[0].url).toBe('/')
    expect(Number(sorted[0].clicks)).toBe(5)
    expect(Number(sorted[1].impressions)).toBe(50)
  })

  it('executes a parameterized parquet SELECT via the executor', async () => {
    const handle = createNodeDuckDBHandle()
    const codec = createDuckDBCodec({ getDuckDB: async () => handle })
    const executor = createDuckDBExecutor({ getDuckDB: async () => handle })

    const input = [
      { url: '/a', date: '2026-04-10', clicks: 10, impressions: 100, sum_position: 500 },
      { url: '/b', date: '2026-04-10', clicks: 20, impressions: 200, sum_position: 1000 },
    ]
    const bytes = await codec.encode('pages', input)

    const rows = await executor.execute({
      sql: 'SELECT url, clicks FROM read_parquet([\'test1.parquet\']) WHERE date >= \'2026-04-01\' ORDER BY clicks DESC',
      params: [],
      files: [{ key: 'test1.parquet', bytes }],
      table: 'pages',
    })

    expect(rows).toHaveLength(2)
    expect(rows[0].url).toBe('/b')
    expect(Number(rows[0].clicks)).toBe(20)
  })

  it('decodes an empty parquet produced by encode([]) without error', async () => {
    const handle = createNodeDuckDBHandle()
    const codec = createDuckDBCodec({ getDuckDB: async () => handle })

    const bytes = await codec.encode('pages', [])
    const decoded = await codec.decode(bytes)
    expect(decoded).toEqual([])
  })
})

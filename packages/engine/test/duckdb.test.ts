import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'
import {
  createNodeDuckDBHandle,
  resetNodeDuckDB,
} from '../src/adapters/duckdb-node'
import { createFilesystemDataSource } from '../src/adapters/filesystem'
import {
  createDuckDBCodec,
  createDuckDBExecutor,
} from '../src/duckdb'
import { createInMemoryDataSource } from './helpers/in-memory'

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
    const dataSource = createInMemoryDataSource()

    const input = [
      { url: '/', date: '2026-04-10', clicks: 5, impressions: 100, sum_position: 500.0 },
      { url: '/about', date: '2026-04-10', clicks: 2, impressions: 50, sum_position: 150.0 },
    ]

    const written = await codec.writeRows({ table: 'pages' }, input, 'roundtrip.parquet', dataSource)
    expect(written.bytes).toBeGreaterThan(50)
    expect(written.rowCount).toBe(2)

    const decoded = await codec.readRows({ table: 'pages' }, 'roundtrip.parquet', dataSource)
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
    const dataSource = createInMemoryDataSource()

    const input = [
      { url: '/a', date: '2026-04-10', clicks: 10, impressions: 100, sum_position: 500 },
      { url: '/b', date: '2026-04-10', clicks: 20, impressions: 200, sum_position: 1000 },
    ]
    await codec.writeRows({ table: 'pages' }, input, 'test1.parquet', dataSource)

    const result = await executor.execute({
      sql: 'SELECT url, clicks FROM read_parquet({{FILES}}) WHERE date >= \'2026-04-01\' ORDER BY clicks DESC',
      params: [],
      fileKeys: { FILES: ['test1.parquet'] },
      dataSource,
      table: 'pages',
    })

    expect(result.rows).toHaveLength(2)
    expect(result.rows[0].url).toBe('/b')
    expect(Number(result.rows[0].clicks)).toBe(20)
  })

  it('executor: empty FILES placeholder produces a schema-correct zero-row result (not a Binder Error)', async () => {
    const handle = createNodeDuckDBHandle()
    const executor = createDuckDBExecutor({ getDuckDB: async () => handle })
    const dataSource = createInMemoryDataSource()

    // No parquets registered → fileKeys.FILES is []. Without the rewrite
    // this would produce `read_parquet([], ...)` and fail at the binder.
    const result = await executor.execute({
      sql: 'SELECT url, clicks FROM read_parquet({{FILES}}, union_by_name = true)',
      params: [],
      fileKeys: { FILES: [] },
      dataSource,
      table: 'pages',
    })
    expect(result.rows).toEqual([])
    // SQL was rewritten to reference an empty-schema subquery, not read_parquet.
    expect(result.sql).not.toContain('read_parquet')
  })

  it('executor: empty FILES_PREV with populated FILES still works (movers/decay fresh-run case)', async () => {
    const handle = createNodeDuckDBHandle()
    const codec = createDuckDBCodec({ getDuckDB: async () => handle })
    const executor = createDuckDBExecutor({ getDuckDB: async () => handle })
    const dataSource = createInMemoryDataSource()

    await codec.writeRows({ table: 'pages' }, [
      { url: '/a', date: '2026-04-10', clicks: 5, impressions: 50, sum_position: 150 },
    ], 'cur.parquet', dataSource)

    // Shape mirrors the analyzers: LEFT JOIN prev vs cur. Prev is empty so
    // the LEFT JOIN keeps every cur row unmatched.
    const result = await executor.execute({
      sql: `
        WITH cur AS (
          SELECT url, SUM(clicks)::INT AS clicks
          FROM read_parquet({{FILES}}, union_by_name = true)
          GROUP BY url
        ),
        prev AS (
          SELECT url, SUM(clicks)::INT AS clicks
          FROM read_parquet({{FILES_PREV}}, union_by_name = true)
          GROUP BY url
        )
        SELECT c.url, c.clicks, COALESCE(p.clicks, 0) AS prev_clicks
        FROM cur c LEFT JOIN prev p ON c.url = p.url
      `,
      params: [],
      fileKeys: { FILES: ['cur.parquet'], FILES_PREV: [] },
      dataSource,
      table: 'pages',
    })
    expect(result.rows).toHaveLength(1)
    expect(result.rows[0].url).toBe('/a')
    expect(Number(result.rows[0].clicks)).toBe(5)
    expect(Number(result.rows[0].prev_clicks)).toBe(0)
  })

  it('decodes an empty parquet produced by writeRows([]) without error', async () => {
    const handle = createNodeDuckDBHandle()
    const codec = createDuckDBCodec({ getDuckDB: async () => handle })
    const dataSource = createInMemoryDataSource()

    await codec.writeRows({ table: 'pages' }, [], 'empty.parquet', dataSource)
    const decoded = await codec.readRows({ table: 'pages' }, 'empty.parquet', dataSource)
    expect(decoded).toEqual([])
  })

  it('codec.compactRows streams multiple parquet inputs into one merged output', async () => {
    const handle = createNodeDuckDBHandle()
    const codec = createDuckDBCodec({ getDuckDB: async () => handle })
    const dataSource = createInMemoryDataSource()

    await codec.writeRows({ table: 'pages' }, [
      { url: '/a', date: '2026-04-10', clicks: 1, impressions: 10, sum_position: 50 },
    ], 'a.parquet', dataSource)
    await codec.writeRows({ table: 'pages' }, [
      { url: '/b', date: '2026-04-11', clicks: 2, impressions: 20, sum_position: 100 },
      { url: '/c', date: '2026-04-12', clicks: 3, impressions: 30, sum_position: 150 },
    ], 'b.parquet', dataSource)

    const merged = await codec.compactRows(
      { table: 'pages' },
      ['a.parquet', 'b.parquet'],
      'merged.parquet',
      dataSource,
    )
    expect(merged.rowCount).toBe(3)

    const decoded = await codec.readRows({ table: 'pages' }, 'merged.parquet', dataSource)
    const urls = decoded.map(r => r.url).sort()
    expect(urls).toEqual(['/a', '/b', '/c'])
  })

  it('compactRows uses the pure-DuckDB URI path when all keys are URI-resolvable (no dataSource.read calls)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'gscdump-duckdb-uri-'))
    try {
      const handle = createNodeDuckDBHandle()
      const codec = createDuckDBCodec({ getDuckDB: async () => handle })
      const dataSource = createFilesystemDataSource({ rootDir: dir })

      await codec.writeRows({ table: 'pages' }, [
        { url: '/a', date: '2026-04-10', clicks: 1, impressions: 10, sum_position: 50 },
      ], 'a.parquet', dataSource)
      await codec.writeRows({ table: 'pages' }, [
        { url: '/b', date: '2026-04-11', clicks: 2, impressions: 20, sum_position: 100 },
      ], 'b.parquet', dataSource)

      const readSpy = vi.spyOn(dataSource, 'read')
      const merged = await codec.compactRows(
        { table: 'pages' },
        ['a.parquet', 'b.parquet'],
        'merged.parquet',
        dataSource,
      )
      expect(readSpy).not.toHaveBeenCalled()
      expect(merged.rowCount).toBe(2)
      expect(merged.bytes).toBeGreaterThan(0)

      const decoded = await codec.readRows({ table: 'pages' }, 'merged.parquet', dataSource)
      expect(decoded.map(r => r.url).sort()).toEqual(['/a', '/b'])
    }
    finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

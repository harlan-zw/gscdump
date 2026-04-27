/**
 * gscdump/analytics/hyparquet — ParquetCodec round-trip tests against an
 * in-memory DataSource. Verifies: write → read preserves rows for every
 * schema; empty-rows emits a schema-bearing file; compact concatenates;
 * readRows override delegates.
 */

import type { DataSource, Row, TableName } from '../src/index'
import { describe, expect, it } from 'vitest'
import {
  createHyparquetCodec,
  decodeParquetToRows,
  encodeRowsToParquet,
  encodeRowsToParquetFlex,
} from '../src/adapters/hyparquet'
import { allTables } from '../src/index'

function memDataSource(): DataSource & { store: Map<string, Uint8Array> } {
  const store = new Map<string, Uint8Array>()
  return {
    store,
    async read(key) {
      const v = store.get(key)
      if (!v)
        throw new Error(`missing key ${key}`)
      return v
    },
    async write(key, bytes) {
      store.set(key, bytes)
    },
    async delete(keys) {
      for (const k of keys) store.delete(k)
    },
    async list(prefix) {
      return [...store.keys()].filter(k => k.startsWith(prefix)).sort()
    },
  }
}

const FIXTURES: Record<TableName, Row[]> = {
  pages: [
    { url: '/a', date: '2025-01-01', clicks: 10, impressions: 100, sum_position: 523.4 },
    { url: '/b', date: '2025-01-01', clicks: 0, impressions: 3, sum_position: 18 },
  ],
  keywords: [
    { query: 'foo', query_canonical: 'foo', date: '2025-01-01', clicks: 5, impressions: 50, sum_position: 21.5 },
    { query: 'bar', query_canonical: null, date: '2025-01-02', clicks: 1, impressions: 2, sum_position: 4 },
  ],
  countries: [
    { country: 'usa', date: '2025-01-01', clicks: 7, impressions: 70, sum_position: 14 },
  ],
  devices: [
    { device: 'mobile', date: '2025-01-01', clicks: 3, impressions: 30, sum_position: 9 },
  ],
  page_keywords: [
    { url: '/a', query: 'foo', query_canonical: 'foo', date: '2025-01-01', clicks: 2, impressions: 20, sum_position: 40 },
  ],
  search_appearance: [
    { searchAppearance: 'AMP_TOP_STORIES', date: '2025-01-01', clicks: 4, impressions: 40, sum_position: 16 },
  ],
}

describe('hyparquet codec', () => {
  for (const table of allTables()) {
    it(`round-trips ${table}`, async () => {
      const codec = createHyparquetCodec()
      const ds = memDataSource()
      const rows = FIXTURES[table]
      const key = `${table}/daily__v1.parquet`

      const writeRes = await codec.writeRows({ table }, rows, key, ds)
      expect(writeRes.rowCount).toBe(rows.length)
      expect(writeRes.bytes).toBeGreaterThan(0)
      expect(ds.store.get(key)?.byteLength).toBe(writeRes.bytes)

      const readBack = await codec.readRows({ table }, key, ds)
      expect(readBack).toHaveLength(rows.length)
      for (let i = 0; i < rows.length; i++) {
        for (const col of Object.keys(rows[i]!))
          expect(readBack[i]![col]).toEqual(rows[i]![col])
      }
    })
  }

  it('empty rows still emit a schema-bearing file', async () => {
    const codec = createHyparquetCodec()
    const ds = memDataSource()
    const key = 'pages/empty.parquet'
    const res = await codec.writeRows({ table: 'pages' }, [], key, ds)
    expect(res.rowCount).toBe(0)
    expect(res.bytes).toBeGreaterThan(0)
    const rows = await codec.readRows({ table: 'pages' }, key, ds)
    expect(rows).toEqual([])
  })

  it('compacts multiple input shards into one', async () => {
    const codec = createHyparquetCodec()
    const ds = memDataSource()
    const a = [{ url: '/x', date: '2025-01-01', clicks: 1, impressions: 10, sum_position: 5 }]
    const b = [{ url: '/y', date: '2025-01-02', clicks: 2, impressions: 20, sum_position: 10 }]
    await codec.writeRows({ table: 'pages' }, a, 'a.parquet', ds)
    await codec.writeRows({ table: 'pages' }, b, 'b.parquet', ds)

    const res = await codec.compactRows({ table: 'pages' }, ['a.parquet', 'b.parquet'], 'out.parquet', ds)
    expect(res.rowCount).toBe(2)
    const merged = await codec.readRows({ table: 'pages' }, 'out.parquet', ds)
    expect(merged).toHaveLength(2)
    expect(merged.map(r => r.url).sort()).toEqual(['/x', '/y'])
  })

  it('compact with zero inputs still produces a schema-bearing output', async () => {
    const codec = createHyparquetCodec()
    const ds = memDataSource()
    const res = await codec.compactRows({ table: 'keywords' }, [], 'empty.parquet', ds)
    expect(res.rowCount).toBe(0)
    expect(res.bytes).toBeGreaterThan(0)
  })

  it('readRows override delegates instead of decoding locally', async () => {
    let called = 0
    const codec = createHyparquetCodec({
      async readRows() {
        called++
        return [{ url: '/stub', date: '2025-01-01', clicks: 0, impressions: 0, sum_position: 0 }]
      },
    })
    const ds = memDataSource()
    await codec.writeRows({ table: 'pages' }, [], 'k.parquet', ds)
    const rows = await codec.readRows({ table: 'pages' }, 'k.parquet', ds)
    expect(called).toBe(1)
    expect(rows[0]!.url).toBe('/stub')
  })

  it('exports raw encode/decode helpers for ad-hoc use', async () => {
    const bytes = encodeRowsToParquet('devices', [
      { device: 'desktop', date: '2025-01-01', clicks: 1, impressions: 2, sum_position: 3 },
    ])
    const rows = await decodeParquetToRows(bytes)
    expect(rows[0]!.device).toBe('desktop')
  })

  it('encodeRowsToParquetFlex round-trips an arbitrary column set', async () => {
    const bytes = encodeRowsToParquetFlex(
      [
        { url: '/a', clicks: 100, impressions: 1000, sum_position: 55.5 },
        { url: '/b', clicks: 50, impressions: 500, sum_position: 22.0 },
        { url: '/c', clicks: 10, impressions: 100, sum_position: 3.0 },
      ],
      {
        columns: [
          { name: 'url', type: 'VARCHAR', nullable: false },
          { name: 'clicks', type: 'BIGINT', nullable: false },
          { name: 'impressions', type: 'BIGINT', nullable: false },
          { name: 'sum_position', type: 'DOUBLE', nullable: false },
        ],
        sortKey: ['clicks'],
      },
    )
    const rows = await decodeParquetToRows(bytes)
    expect(rows).toHaveLength(3)
    expect(rows.map(r => r.url)).toEqual(['/c', '/b', '/a'])
    expect(Number(rows[0]!.clicks)).toBe(10)
  })

  it('encodeRowsToParquetFlex tolerates nullable columns + empty rows', async () => {
    const bytes = encodeRowsToParquetFlex([], {
      columns: [
        { name: 'country', type: 'VARCHAR', nullable: false },
        { name: 'clicks', type: 'BIGINT', nullable: true },
      ],
    })
    const rows = await decodeParquetToRows(bytes)
    expect(rows).toEqual([])

    const bytes2 = encodeRowsToParquetFlex(
      [{ country: 'usa', clicks: null }, { country: 'gbr', clicks: 42 }],
      {
        columns: [
          { name: 'country', type: 'VARCHAR', nullable: false },
          { name: 'clicks', type: 'BIGINT', nullable: true },
        ],
      },
    )
    const rows2 = await decodeParquetToRows(bytes2)
    expect(rows2).toHaveLength(2)
    expect(rows2[0]!.clicks).toBeNull()
    expect(Number(rows2[1]!.clicks)).toBe(42)
  })
})

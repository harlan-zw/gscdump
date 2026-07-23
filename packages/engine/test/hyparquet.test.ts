/**
 * gscdump/analytics/hyparquet — ParquetCodec round-trip tests against an
 * in-memory DataSource. Verifies: write → read preserves rows for every
 * schema; empty-rows emits a schema-bearing file; compact concatenates;
 * readRows override delegates.
 */

import type { DataSource, Row, TableName } from '../src/index'
import { parquetMetadata } from 'hyparquet'
import { describe, expect, it } from 'vitest'
import {
  createHyparquetCodec,
  decodeParquetToRows,
  encodeRowsToParquet,
  encodeRowsToParquetFlex,
} from '../src/adapters/hyparquet'
import { allTables, naturalKeyColumns } from '../src/schema'

// The codec writes rows in `clusterKey` (dimension-first) order, not input
// order — so round-trip comparisons must be order-agnostic. Sort both sides
// by natural key before a positional compare.
function byNaturalKey(table: TableName, rows: readonly Row[]): Row[] {
  const key = naturalKeyColumns(table)
  return rows.slice().sort((a, b) => {
    for (const col of key) {
      const av = `${a[col] ?? ''}`
      const bv = `${b[col] ?? ''}`
      if (av !== bv)
        return av < bv ? -1 : 1
    }
    return 0
  })
}

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
  queries: [
    { query: 'foo', date: '2025-01-01', clicks: 5, impressions: 50, sum_position: 21.5 },
    { query: 'bar', date: '2025-01-02', clicks: 1, impressions: 2, sum_position: 4 },
  ],
  countries: [
    { country: 'usa', date: '2025-01-01', clicks: 7, impressions: 70, sum_position: 14 },
  ],
  dates: [
    {
      date: '2025-01-01',
      clicks: 30,
      impressions: 300,
      sum_position: 600,
      anonymized_impressions_pct: 0.2,
      clicks_desktop: 20,
      clicks_mobile: 10,
      clicks_tablet: 0,
      impressions_desktop: 200,
      impressions_mobile: 100,
      impressions_tablet: 0,
      sum_position_desktop: 400,
      sum_position_mobile: 200,
      sum_position_tablet: 0,
    },
  ],
  page_queries: [
    { url: '/a', query: 'foo', date: '2025-01-01', clicks: 2, impressions: 20, sum_position: 40 },
  ],
  search_appearance: [
    { searchAppearance: 'AMP_TOP_STORIES', date: '2025-01-01', clicks: 4, impressions: 40, sum_position: 16 },
  ],
  search_appearance_pages: [
    { searchAppearance: 'AMP_TOP_STORIES', url: '/a', date: '2025-01-01', clicks: 4, impressions: 40, sum_position: 16 },
  ],
  search_appearance_queries: [
    { searchAppearance: 'AMP_TOP_STORIES', query: 'foo', date: '2025-01-01', clicks: 4, impressions: 40, sum_position: 16 },
  ],
  search_appearance_page_queries: [
    { searchAppearance: 'AMP_TOP_STORIES', url: '/a', query: 'foo', date: '2025-01-01', clicks: 4, impressions: 40, sum_position: 16 },
  ],
  hourly_pages: [
    { url: '/a', hour: 8, date: '2025-01-01', clicks: 2, impressions: 12, sum_position: 18 },
    { url: '/a', hour: 9, date: '2025-01-01', clicks: 1, impressions: 6, sum_position: 9 },
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
      const expected = byNaturalKey(table, rows)
      const actual = byNaturalKey(table, readBack)
      for (let i = 0; i < expected.length; i++) {
        for (const col of Object.keys(expected[i]!))
          expect(actual[i]![col]).toEqual(expected[i]![col])
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

  it('overlaps compaction reads up to the configured memory bound', async () => {
    const codec = createHyparquetCodec({ compactionReadConcurrency: 2 })
    const base = memDataSource()
    for (let i = 0; i < 3; i++) {
      base.store.set(`in-${i}.parquet`, encodeRowsToParquet('pages', [
        { url: `/p-${i}`, date: '2025-01-01', clicks: i, impressions: 1, sum_position: 1 },
      ]))
    }
    let active = 0
    let maxActive = 0
    let release!: () => void
    let reachedLimit!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const atLimit = new Promise<void>((resolve) => {
      reachedLimit = resolve
    })
    const ds: DataSource = {
      ...base,
      async read(key) {
        active++
        maxActive = Math.max(maxActive, active)
        if (active === 2)
          reachedLimit()
        await gate
        try {
          return await base.read(key)
        }
        finally {
          active--
        }
      },
    }

    const pending = codec.compactRows(
      { table: 'pages' },
      ['in-0.parquet', 'in-1.parquet', 'in-2.parquet'],
      'out.parquet',
      ds,
    )
    await atLimit
    expect(maxActive).toBe(2)
    release()
    await expect(pending).resolves.toMatchObject({ rowCount: 3 })
    expect(maxActive).toBe(2)
  })

  // Regression: the 2026-04 monthly-compaction corruption merged a complete
  // month back onto its own daily inputs, so every (date, dimension) row
  // landed twice. compactRows must collapse natural-key collisions instead of
  // summing them — otherwise impressions double on every overlap.
  it('compactRows collapses duplicate natural keys instead of doubling them', async () => {
    const codec = createHyparquetCodec()
    const ds = memDataSource()
    const rows = [
      { url: '/x', date: '2025-01-01', clicks: 1, impressions: 10, sum_position: 5 },
      { url: '/y', date: '2025-01-02', clicks: 2, impressions: 20, sum_position: 10 },
    ]
    // Two input files carrying byte-identical rows — the corruption shape.
    await codec.writeRows({ table: 'pages' }, rows, 'a.parquet', ds)
    await codec.writeRows({ table: 'pages' }, rows, 'b.parquet', ds)

    const res = await codec.compactRows({ table: 'pages' }, ['a.parquet', 'b.parquet'], 'out.parquet', ds)
    expect(res.rowCount).toBe(2)
    const merged = await codec.readRows({ table: 'pages' }, 'out.parquet', ds)
    expect(merged).toHaveLength(2)
    expect(merged.map(r => r.url).sort()).toEqual(['/x', '/y'])
    expect(merged.reduce((n, r) => n + Number(r.impressions), 0)).toBe(30)
  })

  it('compact with zero inputs still produces a schema-bearing output', async () => {
    const codec = createHyparquetCodec()
    const ds = memDataSource()
    const res = await codec.compactRows({ table: 'queries' }, [], 'empty.parquet', ds)
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

  it('encodes the date column as a native parquet DATE (INT32), not a UTF8 string', () => {
    const bytes = encodeRowsToParquet('pages', [
      { url: '/a', date: '2025-01-01', clicks: 1, impressions: 2, sum_position: 3 },
    ])
    const buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
    const meta = parquetMetadata(buf as ArrayBuffer)
    const dateEl = meta.schema.find(s => s.name === 'date')
    expect(dateEl?.type).toBe('INT32')
    expect(dateEl?.converted_type).toBe('DATE')
  })

  it('round-trips a native DATE column back to an ISO YYYY-MM-DD string', async () => {
    const bytes = encodeRowsToParquet('pages', [
      { url: '/a', date: '2025-03-14', clicks: 1, impressions: 2, sum_position: 3 },
    ])
    const rows = await decodeParquetToRows(bytes)
    expect(rows[0]!.date).toBe('2025-03-14')
  })

  it('accepts a JS Date for a DATE column and round-trips it as an ISO string', async () => {
    const bytes = encodeRowsToParquet('pages', [
      { url: '/a', date: new Date('2025-07-09T00:00:00Z'), clicks: 1, impressions: 2, sum_position: 3 },
    ])
    const rows = await decodeParquetToRows(bytes)
    expect(rows[0]!.date).toBe('2025-07-09')
  })

  it('exports raw encode/decode helpers for ad-hoc use', async () => {
    const bytes = encodeRowsToParquet('countries', [
      { country: 'usa', date: '2025-01-01', clicks: 1, impressions: 2, sum_position: 3 },
    ])
    const rows = await decodeParquetToRows(bytes)
    expect(rows[0]!.country).toBe('usa')
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

describe('decodeParquetToRows — pushed-down filter', () => {
  // Mirrors the sitemap-urls index: many feedpaths share one parquet, and a
  // reader only wants one feedpath's rows without materialising the whole file.
  const columns = [
    { name: 'feedpath_hash', type: 'VARCHAR', nullable: false },
    { name: 'loc', type: 'VARCHAR', nullable: false },
  ] as const
  const rows: Row[] = [
    { feedpath_hash: 'aaa', loc: 'https://x/1' },
    { feedpath_hash: 'bbb', loc: 'https://x/2' },
    { feedpath_hash: 'aaa', loc: 'https://x/3' },
    { feedpath_hash: 'ccc', loc: 'https://x/4' },
    { feedpath_hash: 'bbb', loc: 'https://x/5' },
  ]

  it('returns only rows matching the filter', async () => {
    const bytes = encodeRowsToParquetFlex(rows, { columns: [...columns], sortKey: ['feedpath_hash'] })
    const got = await decodeParquetToRows(bytes, { filter: { feedpath_hash: { $eq: 'aaa' } } })
    expect(got.map(r => r.loc).sort()).toEqual(['https://x/1', 'https://x/3'])
  })

  it('returns an empty array when nothing matches', async () => {
    const bytes = encodeRowsToParquetFlex(rows, { columns: [...columns], sortKey: ['feedpath_hash'] })
    expect(await decodeParquetToRows(bytes, { filter: { feedpath_hash: { $eq: 'zzz' } } })).toEqual([])
  })

  it('returns every row when no filter is given (back-compat)', async () => {
    const bytes = encodeRowsToParquetFlex(rows, { columns: [...columns], sortKey: ['feedpath_hash'] })
    expect(await decodeParquetToRows(bytes)).toHaveLength(5)
  })

  it('projects only the requested columns', async () => {
    const bytes = encodeRowsToParquetFlex(rows, { columns: [...columns], sortKey: ['feedpath_hash'] })
    const got = await decodeParquetToRows(bytes, { columns: ['loc'] })
    expect(got).toHaveLength(5)
    for (const r of got) {
      expect(Object.keys(r)).toEqual(['loc'])
      expect(typeof r.loc).toBe('string')
    }
  })

  it('combines projection with a pushed-down filter', async () => {
    const bytes = encodeRowsToParquetFlex(rows, { columns: [...columns], sortKey: ['feedpath_hash'] })
    const got = await decodeParquetToRows(bytes, {
      columns: ['loc'],
      filter: { feedpath_hash: { $eq: 'aaa' } },
    })
    expect(got.map(r => r.loc).sort()).toEqual(['https://x/1', 'https://x/3'])
    for (const r of got) expect(Object.keys(r)).toEqual(['loc'])
  })

  it('decodes a bounded row slice without materialising the complete file', async () => {
    const bytes = encodeRowsToParquetFlex(rows, { columns: [...columns] })
    const got = await decodeParquetToRows(bytes, { rowStart: 1, rowEnd: 3 })
    expect(got).toEqual(rows.slice(1, 3))
  })
})

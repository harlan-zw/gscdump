// Integration test for engine.queryOptimized — single-scan rows + totalCount +
// totals via DuckDB window functions (COUNT(*) OVER (), SUM(metric) OVER ()).
// Mirrors engine-comparison-extras.test.ts setup: filesystem dataSource +
// manifest, real node DuckDB, parquet adapter.

import type { BuilderState } from 'gscdump/query'
import type { Row } from '../src/index'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  createNodeDuckDBHandle,
  resetNodeDuckDB,
} from '../src/adapters/duckdb-node'
import {
  createFilesystemDataSource,
  createFilesystemManifestStore,
} from '../src/adapters/filesystem'
import {
  createDuckDBCodec,
  createDuckDBExecutor,
  createStorageEngine,
} from '../src/index'

afterAll(() => {
  resetNodeDuckDB()
})

function pageRow(url: string, date: string, clicks: number, impressions: number): Row {
  // sum_position chosen to make average position = 5 + index-ish, deterministic
  return { url, date, clicks, impressions, sum_position: impressions * 5 }
}

function dateFilter(start: string, end: string): BuilderState['filter'] {
  return {
    _filters: [{
      dimension: 'date',
      operator: 'between',
      expression: start,
      expression2: end,
    }],
  } as any
}

describe('engine.queryOptimized', () => {
  let dir: string
  beforeEach(async () => {
    resetNodeDuckDB()
    dir = await mkdtemp(join(tmpdir(), 'gscdump-opt-'))
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  async function setup() {
    const handle = createNodeDuckDBHandle()
    const factory = { getDuckDB: async () => handle }
    const codec = createDuckDBCodec(factory)
    const executor = createDuckDBExecutor(factory)
    const dataSource = createFilesystemDataSource({ rootDir: dir })
    const manifestStore = createFilesystemManifestStore({ path: join(dir, 'manifest.json') })
    const engine = createStorageEngine({ dataSource, manifestStore, codec, executor })
    return { engine }
  }

  // Five unique pages, single day. Clicks/impressions chosen so each metric
  // is independently distinguishable.
  const day = '2026-04-15'
  const fixture = [
    { url: '/a', clicks: 50, impressions: 500 },
    { url: '/b', clicks: 40, impressions: 400 },
    { url: '/c', clicks: 30, impressions: 300 },
    { url: '/d', clicks: 20, impressions: 200 },
    { url: '/e', clicks: 10, impressions: 100 },
  ]

  async function seedPages(engine: Awaited<ReturnType<typeof setup>>['engine']) {
    await engine.writeDay(
      { userId: 'u1', siteId: 's1', table: 'pages', date: day },
      fixture.map(f => pageRow(f.url, day, f.clicks, f.impressions)),
    )
  }

  function expectedTotals() {
    const clicks = fixture.reduce((s, r) => s + r.clicks, 0)
    const impressions = fixture.reduce((s, r) => s + r.impressions, 0)
    const sumPos = fixture.reduce((s, r) => s + r.impressions * 5, 0)
    return {
      clicks,
      impressions,
      ctr: clicks / impressions,
      position: sumPos / impressions + 1,
    }
  }

  it('truncated page returns rowLimit rows, totalCount across all groups, totals across all rows', async () => {
    const { engine } = await setup()
    await seedPages(engine)

    const state: BuilderState = {
      dimensions: ['page'],
      metrics: ['clicks', 'impressions', 'ctr', 'position'],
      filter: dateFilter('2026-04-01', '2026-04-30'),
      rowLimit: 2,
      orderBy: { column: 'impressions', dir: 'desc' },
    }

    const result = await engine.queryOptimized({ userId: 'u1', siteId: 's1' }, state)
    expect(result.rows).toHaveLength(2)
    expect(result.totalCount).toBe(5)

    const exp = expectedTotals()
    expect(result.totals.clicks).toBe(exp.clicks)
    expect(result.totals.impressions).toBe(exp.impressions)
    expect(result.totals.ctr).toBeCloseTo(exp.ctr, 5)
    expect(result.totals.position).toBeCloseTo(exp.position, 5)

    // Rows are ordered by impressions desc and contain the top two URLs.
    expect((result.rows[0] as any).page).toBe('/a')
    expect((result.rows[1] as any).page).toBe('/b')

    // Window-function totals MUST be stripped from rows.
    for (const r of result.rows) {
      const keys = Object.keys(r)
      expect(keys).not.toContain('totalCount')
      expect(keys).not.toContain('totalClicks')
      expect(keys).not.toContain('totalImpressions')
      expect(keys).not.toContain('totalCtr')
      expect(keys).not.toContain('totalPosition')
    }
  })

  it('untruncated page returns all rows with same totalCount and totals', async () => {
    const { engine } = await setup()
    await seedPages(engine)

    const state: BuilderState = {
      dimensions: ['page'],
      metrics: ['clicks', 'impressions', 'ctr', 'position'],
      filter: dateFilter('2026-04-01', '2026-04-30'),
      rowLimit: 10,
      orderBy: { column: 'impressions', dir: 'desc' },
    }

    const result = await engine.queryOptimized({ userId: 'u1', siteId: 's1' }, state)
    expect(result.rows).toHaveLength(5)
    expect(result.totalCount).toBe(5)
    const exp = expectedTotals()
    expect(result.totals.clicks).toBe(exp.clicks)
    expect(result.totals.impressions).toBe(exp.impressions)
  })

  it('empty result yields rows=[], totalCount=0, totals=0 (no crash on undefined firstRow)', async () => {
    const { engine } = await setup()
    await seedPages(engine)

    const state: BuilderState = {
      dimensions: ['page'],
      metrics: ['clicks', 'impressions', 'ctr', 'position'],
      // Date window outside the fixture day.
      filter: dateFilter('2025-01-01', '2025-01-31'),
      rowLimit: 100,
    }

    const result = await engine.queryOptimized({ userId: 'u1', siteId: 's1' }, state)
    expect(result.rows).toEqual([])
    expect(result.totalCount).toBe(0)
    expect(result.totals).toEqual({ clicks: 0, impressions: 0, ctr: 0, position: 0 })
  })

  it('per-metric totals match independent recomputation from fixture', async () => {
    const { engine } = await setup()
    await seedPages(engine)

    const state: BuilderState = {
      dimensions: ['page'],
      metrics: ['clicks', 'impressions', 'ctr', 'position'],
      filter: dateFilter('2026-04-01', '2026-04-30'),
      rowLimit: 100,
    }
    const result = await engine.queryOptimized({ userId: 'u1', siteId: 's1' }, state)

    const expectedClicks = 50 + 40 + 30 + 20 + 10 // 150
    const expectedImpressions = 500 + 400 + 300 + 200 + 100 // 1500
    const expectedSumPos = expectedImpressions * 5 // each row sum_position = impressions * 5
    expect(result.totals.clicks).toBe(expectedClicks)
    expect(result.totals.impressions).toBe(expectedImpressions)
    expect(result.totals.ctr).toBeCloseTo(expectedClicks / expectedImpressions, 5)
    expect(result.totals.position).toBeCloseTo(expectedSumPos / expectedImpressions + 1, 5)
  })

  // Sanity: each table resolves to valid SQL the parquet adapter + DuckDB
  // accepts. Catches column-mismatch failures (e.g. missing sum_position).
  describe('all metric tables resolve', () => {
    const cases: Array<{
      table: 'pages' | 'keywords' | 'countries' | 'devices' | 'page_keywords'
      dimensions: BuilderState['dimensions']
      row: Row
    }> = [
      { table: 'pages', dimensions: ['page'], row: { url: '/x', date: day, clicks: 1, impressions: 10, sum_position: 50 } },
      { table: 'keywords', dimensions: ['query'], row: { query: 'foo', date: day, clicks: 1, impressions: 10, sum_position: 50 } },
      { table: 'countries', dimensions: ['country'], row: { country: 'usa', date: day, clicks: 1, impressions: 10, sum_position: 50 } },
      { table: 'devices', dimensions: ['device'], row: { device: 'DESKTOP', date: day, clicks: 1, impressions: 10, sum_position: 50 } },
      { table: 'page_keywords', dimensions: ['page', 'query'], row: { url: '/x', query: 'foo', date: day, clicks: 1, impressions: 10, sum_position: 50 } },
    ]

    for (const c of cases) {
      it(`resolves valid SQL for ${c.table}`, async () => {
        const { engine } = await setup()
        await engine.writeDay(
          { userId: 'u1', siteId: 's1', table: c.table, date: day },
          [c.row],
        )
        const state: BuilderState = {
          dimensions: c.dimensions,
          metrics: ['clicks', 'impressions', 'ctr', 'position'],
          filter: dateFilter('2026-04-01', '2026-04-30'),
          rowLimit: 10,
        }
        const result = await engine.queryOptimized({ userId: 'u1', siteId: 's1' }, state)
        expect(result.rows).toHaveLength(1)
        expect(result.totalCount).toBe(1)
        expect(result.totals.clicks).toBe(1)
        expect(result.totals.impressions).toBe(10)
        expect(result.totals.ctr).toBeCloseTo(0.1, 5)
        expect(result.totals.position).toBeCloseTo(50 / 10 + 1, 5)
      })
    }
  })
})

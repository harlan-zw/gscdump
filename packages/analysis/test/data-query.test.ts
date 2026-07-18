/**
 * data-query + data-detail — browser-only analyzers that delegate to the
 * upstream resolver. Tested against a real Node DuckDB instance with in-
 * memory tables shaped like the parquet views the browser attaches.
 *
 * We skip the parquet layer entirely: the analyzers emit SQL against bare
 * table refs (`"keywords"`, `"pages"`, ...) which DuckDB resolves against
 * its default `main` schema. That matches exactly how useBrowserAnalyzer
 * registers its `CREATE VIEW main.pages AS SELECT * FROM read_parquet(...)`
 * views in the app — if the SQL is correct here, it's correct there.
 */

import type { AnalyzerRunner } from '@gscdump/analysis'

import { analyzeInBrowser } from '@gscdump/analysis'
import { defaultAnalyzerRegistry } from '@gscdump/analysis/registry'
import {
  createNodeDuckDBHandle,
  resetNodeDuckDB,
} from '@gscdump/engine/node'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

afterAll(() => {
  resetNodeDuckDB()
})

interface Row { [k: string]: unknown }

const handle = createNodeDuckDBHandle()
const runner: AnalyzerRunner = {
  async query(sql: string, params?: unknown[]) {
    return handle.query(sql, params) as Promise<Row[]>
  },
}

async function reset(): Promise<void> {
  await handle.query(`DROP TABLE IF EXISTS queries`)
  await handle.query(`DROP TABLE IF EXISTS pages`)
  await handle.query(`DROP TABLE IF EXISTS page_queries`)
  await handle.query(`DROP TABLE IF EXISTS countries`)
  await handle.query(`DROP TABLE IF EXISTS dates`)
}

interface KwRow {
  query: string
  query_canonical?: string | null
  date: string
  clicks: number
  impressions: number
  sum_position: number
}

async function createKeywords(rows: KwRow[]): Promise<void> {
  await handle.query(
    `CREATE TABLE queries (
      query VARCHAR NOT NULL,
      query_canonical VARCHAR,
      date DATE NOT NULL,
      clicks INTEGER NOT NULL,
      impressions INTEGER NOT NULL,
      sum_position DOUBLE NOT NULL
    )`,
  )
  for (const r of rows) {
    await handle.query(
      `INSERT INTO queries VALUES (?, ?, ?, ?, ?, ?)`,
      [r.query, r.query_canonical ?? null, r.date, r.clicks, r.impressions, r.sum_position],
    )
  }
}

describe('data-query', () => {
  beforeAll(async () => {
    await reset()
    await createKeywords([
      { query: 'alpha', date: '2026-04-10', clicks: 10, impressions: 100, sum_position: 200 },
      { query: 'beta', date: '2026-04-10', clicks: 20, impressions: 200, sum_position: 600 },
      { query: 'alpha', date: '2026-04-11', clicks: 15, impressions: 150, sum_position: 300 },
      { query: 'gamma', date: '2026-04-11', clicks: 5, impressions: 500, sum_position: 5000 },
      // Previous-period rows for comparison tests
      { query: 'alpha', date: '2026-04-01', clicks: 3, impressions: 60, sum_position: 120 },
      { query: 'dropped', date: '2026-04-01', clicks: 8, impressions: 80, sum_position: 160 },
    ])
  })

  it('optimized path aggregates per dimension and returns window-totals', async () => {
    const out = await analyzeInBrowser(runner, { schema: 'main' }, {
      type: 'data-query',
      q: {
        dimensions: ['query'],
        filter: { _filters: [
          { dimension: 'date', operator: 'gte', expression: '2026-04-10' },
          { dimension: 'date', operator: 'lte', expression: '2026-04-11' },
        ] },
      },
    }, defaultAnalyzerRegistry)

    const rows = out.results as Array<{ query: string, clicks: number, impressions: number }>
    // alpha (2 rows → 25 clicks, 250 impressions), beta (20/200), gamma (5/500)
    expect(rows).toHaveLength(3)
    const byQuery = Object.fromEntries(rows.map(r => [r.query, r]))
    expect(byQuery.alpha.clicks).toBe(25)
    expect(byQuery.alpha.impressions).toBe(250)
    expect(byQuery.beta.clicks).toBe(20)
    expect(byQuery.gamma.clicks).toBe(5)

    const meta = out.meta as { totalCount: number, totals: { clicks: number, impressions: number } }
    expect(meta.totalCount).toBe(3)
    expect(meta.totals.clicks).toBe(50) // 25 + 20 + 5
    expect(meta.totals.impressions).toBe(950)

    // Window-totals scratch columns are stripped before the shape returns.
    expect(rows[0]).not.toHaveProperty('totalClicks')
    expect(rows[0]).not.toHaveProperty('sum_position')
  })

  it('comparison path joins current + previous and applies the filter', async () => {
    const out = await analyzeInBrowser(runner, { schema: 'main' }, {
      type: 'data-query',
      q: {
        dimensions: ['query'],
        filter: { _filters: [
          { dimension: 'date', operator: 'gte', expression: '2026-04-10' },
          { dimension: 'date', operator: 'lte', expression: '2026-04-11' },
        ] },
      },
      qc: {
        dimensions: ['query'],
        filter: { _filters: [
          { dimension: 'date', operator: 'gte', expression: '2026-04-01' },
          { dimension: 'date', operator: 'lte', expression: '2026-04-01' },
        ] },
      },
      // 'new' filter: keywords in current window with no previous impressions.
      comparisonFilter: 'new',
    }, defaultAnalyzerRegistry)

    // 'new' keeps rows where previous is NULL or 0. beta and gamma qualify
    // (no 2026-04-01 row); alpha has prior impressions so it's excluded.
    const rows = out.results as Array<{ query: string, prevImpressions: number }>
    const names = rows.map(r => r.query).sort()
    expect(names).toEqual(['beta', 'gamma'])
    for (const r of rows)
      expect(r.prevImpressions).toBe(0)
  })

  it('orderBy + rowLimit honored through the optimized path', async () => {
    const out = await analyzeInBrowser(runner, { schema: 'main' }, {
      type: 'data-query',
      q: {
        dimensions: ['query'],
        filter: { _filters: [
          { dimension: 'date', operator: 'gte', expression: '2026-04-10' },
          { dimension: 'date', operator: 'lte', expression: '2026-04-11' },
        ] },
        orderBy: { column: 'impressions', dir: 'desc' },
        rowLimit: 2,
      },
    }, defaultAnalyzerRegistry)
    const rows = out.results as Array<{ query: string }>
    // impressions desc: gamma 500, alpha 250, beta 200 → top 2 is gamma + alpha
    expect(rows.map(r => r.query)).toEqual(['gamma', 'alpha'])
  })
})

describe('data-detail', () => {
  beforeAll(async () => {
    await reset()
    await createKeywords([
      // Intentional gap on 2026-04-09 — padTimeseries should fill it.
      { query: 'alpha', date: '2026-04-08', clicks: 10, impressions: 100, sum_position: 200 },
      { query: 'alpha', date: '2026-04-10', clicks: 20, impressions: 200, sum_position: 600 },
      // Previous-period row for prevTotals.
      { query: 'alpha', date: '2026-04-01', clicks: 5, impressions: 50, sum_position: 100 },
    ])
  })

  it('returns daily timeseries padded across the requested window', async () => {
    const out = await analyzeInBrowser(runner, { schema: 'main' }, {
      type: 'data-detail',
      q: {
        dimensions: ['date'],
        filter: { _filters: [
          { dimension: 'query', operator: 'equals', expression: 'alpha' },
          { dimension: 'date', operator: 'gte', expression: '2026-04-08' },
          { dimension: 'date', operator: 'lte', expression: '2026-04-10' },
        ] },
      },
    }, defaultAnalyzerRegistry)

    const daily = out.results as Array<{ date: string, clicks: number, impressions: number }>
    // 3 days, one gap filled. padTimeseries emits date as a Date object only
    // for missing rows; for present rows it passes through whatever DuckDB
    // returned (Date). Normalize to YYYY-MM-DD for comparison.
    const asIso = (d: unknown): string => d instanceof Date
      ? d.toISOString().slice(0, 10)
      : String(d).slice(0, 10)
    const dates = daily.map(d => asIso(d.date)).sort()
    expect(dates).toEqual(['2026-04-08', '2026-04-09', '2026-04-10'])
    const gap = daily.find(d => asIso(d.date) === '2026-04-09')!
    expect(gap.clicks).toBe(0)
    expect(gap.impressions).toBe(0)

    const meta = out.meta as { totals: { clicks: number, impressions: number } }
    expect(meta.totals.clicks).toBe(30)
    expect(meta.totals.impressions).toBe(300)
    expect(daily[0]).not.toHaveProperty('totalCount')
    expect(daily[0]).not.toHaveProperty('totalClicks')
    expect(daily[0]).not.toHaveProperty('sum_position')
  })

  it('prevTotals present when qc supplied', async () => {
    const out = await analyzeInBrowser(runner, { schema: 'main' }, {
      type: 'data-detail',
      q: {
        dimensions: ['date'],
        filter: { _filters: [
          { dimension: 'query', operator: 'equals', expression: 'alpha' },
          { dimension: 'date', operator: 'gte', expression: '2026-04-08' },
          { dimension: 'date', operator: 'lte', expression: '2026-04-10' },
        ] },
      },
      qc: {
        dimensions: ['date'],
        filter: { _filters: [
          { dimension: 'query', operator: 'equals', expression: 'alpha' },
          { dimension: 'date', operator: 'gte', expression: '2026-04-01' },
          { dimension: 'date', operator: 'lte', expression: '2026-04-01' },
        ] },
      },
    }, defaultAnalyzerRegistry)
    const meta = out.meta as { previousTotals?: { clicks: number, impressions: number } }
    expect(meta.previousTotals).toBeDefined()
    expect(meta.previousTotals!.clicks).toBe(5)
    expect(meta.previousTotals!.impressions).toBe(50)
  })
})

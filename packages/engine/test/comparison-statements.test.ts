// A comparison list reads rows, their count, and the totals of both windows.
// These tests run the compiled statements on DuckDB over Iceberg-shaped tables
// and check the two-statement read against the four statements it replaces.

import type { BuilderState } from 'gscdump/query'
import type { ComparisonFilter, ComparisonOrderBy } from '../src/resolver'
import { and, between, contains, date, eq, gsc, gte, impressions, query } from 'gscdump/query'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createNodeDuckDBHandle, resetNodeDuckDB } from '../src/adapters/duckdb-node'
import {
  buildComparisonTotalsSql,
  buildTotalsSql,
  createIcebergResolverAdapter,
  resolveComparisonSQL,
  resolveComparisonSQLOptimized,
  splitComparisonTotalsRow,
} from '../src/resolver'

const SITE = 42
const SEARCH_TYPE = 1
const adapter = createIcebergResolverAdapter({ partitionKeyEncoding: 'int' })
const options = { adapter, siteId: SITE, searchType: SEARCH_TYPE, minimumImpressions: 1 }
const db = createNodeDuckDBHandle()

type Row = Record<string, unknown>

async function run(statement: { sql: string, params: unknown[] }): Promise<Row[]> {
  return db.query(statement.sql, statement.params)
}

function totalsState(state: BuilderState): BuilderState {
  return { ...state, dimensions: [], orderBy: undefined, startRow: undefined, rowLimit: 1 }
}

function metrics(row: Row | undefined): Record<string, number> {
  return {
    clicks: Number(row?.clicks ?? 0),
    impressions: Number(row?.impressions ?? 0),
    ctr: Number(row?.ctr ?? 0),
    position: Number(row?.position ?? 0),
  }
}

interface ComparisonRead {
  rows: Row[]
  totalCount: number
  totals: Record<string, number>
  previousTotals: Record<string, number>
  statements: number
}

interface Mover { filter?: ComparisonFilter, orderBy?: ComparisonOrderBy }

// The four statements a comparison list sent before this change.
async function readSeparately(current: BuilderState, previous: BuilderState, mover: Mover = {}): Promise<ComparisonRead> {
  const rows = resolveComparisonSQL(current, previous, options, mover.filter, mover.orderBy)
  const statements = [
    rows,
    { sql: rows.countSql, params: rows.countParams },
    buildTotalsSql(totalsState(current), options),
    buildTotalsSql(totalsState(previous), options),
  ]
  const [rawRows, count, totals, previousTotals] = await Promise.all(statements.map(run))
  return {
    rows: rawRows!,
    totalCount: Number(count![0]?.total ?? 0),
    totals: metrics(totals![0]),
    previousTotals: metrics(previousTotals![0]),
    statements: statements.length,
  }
}

async function readTogether(current: BuilderState, previous: BuilderState, mover: Mover = {}): Promise<ComparisonRead> {
  const rows = resolveComparisonSQLOptimized(current, previous, options, mover.filter, mover.orderBy)
  const totals = buildComparisonTotalsSql(totalsState(current), totalsState(previous), options)
  if (totals._tag !== 'Combined')
    throw new Error(`expected one totals statement, got ${totals._tag}`)
  const [rawRows, totalsRows] = await Promise.all([run(rows), run(totals)])
  const split = splitComparisonTotalsRow(totalsRows[0])
  return {
    rows: rawRows.map(({ totalCount: _totalCount, ...row }) => row),
    totalCount: Number(rawRows[0]?.totalCount ?? 0),
    totals: metrics(split.current),
    previousTotals: metrics(split.previous),
    statements: 2,
  }
}

function expectSameRead(actual: ComparisonRead, expected: ComparisonRead): void {
  expect(actual.rows).toEqual(expected.rows)
  expect(actual.totalCount).toBe(expected.totalCount)
  for (const key of ['totals', 'previousTotals'] as const) {
    expect(actual[key].clicks).toBe(expected[key].clicks)
    expect(actual[key].impressions).toBe(expected[key].impressions)
    expect(actual[key].ctr).toBeCloseTo(expected[key].ctr, 12)
    expect(actual[key].position).toBeCloseTo(expected[key].position, 12)
  }
}

function window(start: string, end: string, rowLimit = 10): BuilderState {
  return { ...gsc.select(query).where(between(date, start, end)).limit(rowLimit).getState(), metrics: ['clicks', 'impressions', 'ctr', 'position'] }
}

function withFilter(state: BuilderState, filter: NonNullable<BuilderState['filter']>): BuilderState {
  return { ...state, filter: and(state.filter!, filter) }
}

const CURRENT = window('2026-03-08', '2026-03-14')
const PREVIOUS = window('2026-03-01', '2026-03-07')

beforeAll(async () => {
  const fact = 'site_id INTEGER, search_type INTEGER, date DATE, clicks INTEGER, impressions INTEGER, sum_position DOUBLE'
  await db.query(`CREATE OR REPLACE TABLE dates (${fact})`)
  await db.query(`CREATE OR REPLACE TABLE queries (query VARCHAR, ${fact})`)
  // Site totals include anonymized traffic, so they exceed the query rows.
  // Days 03-04 to 03-07 and 03-11 to 03-14 have no data at all.
  const dates: Array<[string, number, number, number]> = [
    ['2026-02-03', 50, 500, 1500],
    ['2026-02-20', 900, 9000, 9000],
    ['2026-03-01', 20, 200, 600],
    ['2026-03-02', 22, 220, 440],
    ['2026-03-03', 18, 180, 900],
    ['2026-03-08', 30, 300, 300],
    ['2026-03-09', 32, 320, 640],
    ['2026-03-10', 28, 280, 840],
  ]
  for (const [day, clicks, impressionCount, sumPosition] of dates)
    await db.query('INSERT INTO dates VALUES ($1, $2, $3, $4, $5, $6)', [SITE, SEARCH_TYPE, day, clicks, impressionCount, sumPosition])
  const queries: Array<[string, string, number, number, number]> = [
    ['nuxt seo', '2026-02-03', 9, 90, 180],
    ['nuxt seo', '2026-03-01', 5, 50, 100],
    ['nuxt seo', '2026-03-02', 6, 60, 120],
    ['nuxt sitemap', '2026-03-01', 4, 40, 160],
    ['old guide', '2026-03-02', 3, 30, 300],
    ['old guide', '2026-03-03', 1, 10, 100],
    ['zero impressions', '2026-03-03', 0, 0, 0],
    ['nuxt seo', '2026-03-08', 9, 90, 90],
    ['nuxt seo', '2026-03-09', 8, 80, 160],
    ['nuxt sitemap', '2026-03-09', 1, 20, 100],
    ['new launch', '2026-03-10', 7, 70, 70],
    ['tied entry', '2026-03-10', 7, 70, 140],
  ]
  for (const [text, day, clicks, impressionCount, sumPosition] of queries)
    await db.query('INSERT INTO queries VALUES ($1, $2, $3, $4, $5, $6, $7)', [text, SITE, SEARCH_TYPE, day, clicks, impressionCount, sumPosition])
  // Another Site and another search type must never reach the totals.
  await db.query('INSERT INTO dates VALUES ($1, $2, $3, 1000, 1000, 1000), ($4, $5, $6, 1000, 1000, 1000)', [SITE + 1, SEARCH_TYPE, '2026-03-09', SITE, SEARCH_TYPE + 1, '2026-03-02'])
  await db.query('INSERT INTO queries VALUES (\'nuxt seo\', $1, $2, $3, 1000, 1000, 1000)', [SITE + 1, SEARCH_TYPE, '2026-03-09'])
})

afterAll(() => {
  resetNodeDuckDB()
})

describe('comparison list in two statements', () => {
  it('returns the same rows, count, and totals for both windows as the four separate statements', async () => {
    const together = await readTogether(CURRENT, PREVIOUS)
    expectSameRead(together, await readSeparately(CURRENT, PREVIOUS))
    expect(together.statements).toBe(2)
    expect(together.totalCount).toBe(6)
    // Totals come from the dates table, so they keep anonymized traffic.
    expect(together.totals).toMatchObject({ clicks: 90, impressions: 900, position: 1780 / 900 + 1 })
    expect(together.totals.ctr).toBeCloseTo(0.1, 12)
    expect(together.previousTotals).toMatchObject({ clicks: 60, impressions: 600, position: 1940 / 600 + 1 })
    expect(together.rows[0]).toMatchObject({ query: 'nuxt seo', clicks: 17, prevClicks: 11 })
    expect(together.rows.find(row => row.query === 'old guide')).toMatchObject({ clicks: 0, prevClicks: 4 })
  })

  it.each(['new', 'lost', 'improving', 'declining'] as const)('counts every %s row before the row cap', async (filter) => {
    const current = window('2026-03-08', '2026-03-14', 1)
    const previous = window('2026-03-01', '2026-03-07', 1)
    const together = await readTogether(current, previous, { filter })
    expectSameRead(together, await readSeparately(current, previous, { filter }))
  })

  it('counts every mover when a click change order caps the page', async () => {
    const orderBy = { column: 'clicksChange', dir: 'asc' } as const
    const current = window('2026-03-08', '2026-03-14', 1)
    const previous = window('2026-03-01', '2026-03-07', 1)
    const together = await readTogether(current, previous, { orderBy })
    expectSameRead(together, await readSeparately(current, previous, { orderBy }))
    expect(together.rows).toEqual([expect.objectContaining({ query: 'old guide', clicksChange: -4 })])
    expect(together.totalCount).toBe(6)
  })

  it('keeps days between two distant windows out of both totals', async () => {
    const previous = window('2026-02-01', '2026-02-07')
    const together = await readTogether(CURRENT, previous)
    expectSameRead(together, await readSeparately(CURRENT, previous))
    expect(together.previousTotals).toMatchObject({ clicks: 50, impressions: 500 })
    expect(together.totals).toMatchObject({ clicks: 90, impressions: 900 })
  })

  it('counts the shared days of overlapping windows in both totals', async () => {
    const current = window('2026-03-03', '2026-03-09')
    const previous = window('2026-03-01', '2026-03-08')
    const together = await readTogether(current, previous)
    expectSameRead(together, await readSeparately(current, previous))
    expect(together.totals).toMatchObject({ clicks: 80, impressions: 800 })
    expect(together.previousTotals).toMatchObject({ clicks: 90, impressions: 900 })
  })

  it('returns zero previous totals when the previous window has no data', async () => {
    const previous = window('2026-01-01', '2026-01-07')
    const together = await readTogether(CURRENT, previous)
    expectSameRead(together, await readSeparately(CURRENT, previous))
    expect(together.previousTotals).toEqual({ clicks: 0, impressions: 0, ctr: 0, position: 0 })
  })

  it('returns no rows, a zero count, and zero totals when neither window has data', async () => {
    const current = window('2025-01-08', '2025-01-14')
    const previous = window('2025-01-01', '2025-01-07')
    const together = await readTogether(current, previous)
    expectSameRead(together, await readSeparately(current, previous))
    expect(together).toMatchObject({ rows: [], totalCount: 0 })
    expect(together.totals).toEqual({ clicks: 0, impressions: 0, ctr: 0, position: 0 })
  })

  it('applies a shared dimension filter to rows and to the totals of both windows', async () => {
    const filter = contains(query, 'nuxt')
    const current = withFilter(CURRENT, filter)
    const previous = withFilter(PREVIOUS, filter)
    const together = await readTogether(current, previous)
    expectSameRead(together, await readSeparately(current, previous))
    expect(together.totals).toMatchObject({ clicks: 18, impressions: 190 })
    expect(together.previousTotals).toMatchObject({ clicks: 15, impressions: 150 })
  })

  it('shows a lost row with zero current totals when the filter matches only the previous window', async () => {
    const current = withFilter(CURRENT, eq(query, 'old guide'))
    const previous = withFilter(PREVIOUS, eq(query, 'old guide'))
    const together = await readTogether(current, previous)
    expectSameRead(together, await readSeparately(current, previous))
    expect(together.rows).toEqual([expect.objectContaining({ query: 'old guide', clicks: 0, prevClicks: 4 })])
    expect(together.totalCount).toBe(1)
    expect(together.totals).toEqual({ clicks: 0, impressions: 0, ctr: 0, position: 0 })
    expect(together.previousTotals).toMatchObject({ clicks: 4, impressions: 40 })
  })

  it('keeps a metric filter on rows only, never on the totals', async () => {
    const current = withFilter(CURRENT, gte(impressions, 80))
    const together = await readTogether(current, PREVIOUS)
    expectSameRead(together, await readSeparately(current, PREVIOUS))
    expect(together.totals).toMatchObject({ clicks: 90, impressions: 900 })
  })
})

describe('buildComparisonTotalsSql', () => {
  it('sends one statement when both windows share their filters', () => {
    const filter = contains(query, 'nuxt')
    const totals = buildComparisonTotalsSql(totalsState(withFilter(CURRENT, filter)), totalsState(withFilter(PREVIOUS, filter)), options)
    expect(totals._tag).toBe('Combined')
  })

  it('keeps two statements when the windows filter different rows, and each keeps its own filter', async () => {
    const current = totalsState(withFilter(CURRENT, contains(query, 'nuxt')))
    const previous = totalsState(withFilter(PREVIOUS, contains(query, 'guide')))
    const totals = buildComparisonTotalsSql(current, previous, options)
    if (totals._tag !== 'Separate')
      throw new Error(`expected two totals statements, got ${totals._tag}`)
    const [currentRows, previousRows] = await Promise.all([run(totals.current), run(totals.previous)])
    expect(metrics(currentRows[0])).toMatchObject({ clicks: 18, impressions: 190 })
    expect(metrics(previousRows[0])).toMatchObject({ clicks: 4, impressions: 40 })
  })

  it('keeps two statements when the windows read different tables', () => {
    const current = totalsState(withFilter(CURRENT, contains(query, 'nuxt')))
    expect(buildComparisonTotalsSql(current, totalsState(PREVIOUS), options)._tag).toBe('Separate')
    // Without any filter, only the table tells the windows apart.
    const unguarded = { ...options, minimumImpressions: undefined }
    expect(buildComparisonTotalsSql({ ...totalsState(CURRENT), dimensions: ['query'] }, totalsState(PREVIOUS), unguarded)._tag).toBe('Separate')
  })

  it('splits a combined totals row into the current and previous metrics', () => {
    expect(splitComparisonTotalsRow({ clicks: 3, impressions: 30, ctr: 0.1, position: 2, prevClicks: 1, prevImpressions: 20, prevCtr: 0.05, prevPosition: 4 })).toEqual({
      current: { clicks: 3, impressions: 30, ctr: 0.1, position: 2 },
      previous: { clicks: 1, impressions: 20, ctr: 0.05, position: 4 },
    })
    expect(splitComparisonTotalsRow(undefined)).toEqual({ current: {}, previous: {} })
  })
})

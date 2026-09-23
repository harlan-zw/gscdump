import type { Row, TableName } from '@gscdump/engine/contracts'
import type { BuilderState } from 'gscdump/query'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createDuckDBCodec, createDuckDBExecutor, createStorageEngine } from '@gscdump/engine'
import { runAnalyzerFromSource } from '@gscdump/engine/analyzer'
import { createFilesystemDataSource, createFilesystemManifestStore } from '@gscdump/engine/filesystem'
import { createNodeDuckDBHandle, resetNodeDuckDB } from '@gscdump/engine/node'
import { runAnalyzerWithEngine } from '@gscdump/engine/source'
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import { analyzeMovers } from '../src/analyzers/movers'
import { defaultAnalyzerRegistry } from '../src/default-registry'
import { createInMemoryQuerySource } from '../src/source'

afterAll(() => {
  resetNodeDuckDB()
})

interface MoverRow {
  keyword: string
  page: string | null
  direction: string
  recentClicks: number
  baselineClicks: number
  recentPosition: number | null
  clicksChange: number
}

const COMPARISON = {
  startDate: '2026-04-10',
  endDate: '2026-04-16',
  prevStartDate: '2026-04-03',
  prevEndDate: '2026-04-09',
}

function isCurrent(state: BuilderState): boolean {
  return JSON.stringify(state.filter).includes(COMPARISON.startDate)
}

/** Rows source that serves `current` / `previous` rows and records every state it sees. */
function periodSource(current: Record<string, unknown>[], previous: Record<string, unknown>[]) {
  const states: BuilderState[] = []
  const source = createInMemoryQuerySource({
    queryRows(state) {
      states.push(state)
      const rows = isCurrent(state) ? current : previous
      return state.rowLimit ? rows.slice(0, state.rowLimit) : rows
    },
  })
  return { source, states }
}

describe('movers joins on (query, page)', () => {
  // Grill repro: one query on two pages. Joining on query alone reported
  // /a as "rising" against the /b baseline.
  const current = [
    { query: 'nuxt seo', page: 'https://x.com/a', clicks: 673, impressions: 5000, ctr: 0.13, position: 3 },
    { query: 'nuxt seo', page: 'https://x.com/b', clicks: 10, impressions: 400, ctr: 0.025, position: 12 },
  ]
  const previous = [
    { query: 'nuxt seo', page: 'https://x.com/a', clicks: 1955, impressions: 8000, ctr: 0.24, position: 2 },
    { query: 'nuxt seo', page: 'https://x.com/b', clicks: 5, impressions: 300, ctr: 0.016, position: 14 },
  ]

  it('compares each page against its own baseline', async () => {
    const { source } = periodSource(current, previous)
    const out = await runAnalyzerFromSource(source, { type: 'movers', ...COMPARISON }, defaultAnalyzerRegistry)
    const rows = out.results as unknown as MoverRow[]
    const a = rows.find(r => r.page === 'https://x.com/a')
    const b = rows.find(r => r.page === 'https://x.com/b')
    expect(a).toMatchObject({ direction: 'declining', recentClicks: 673, baselineClicks: 1955, clicksChange: -1282 })
    expect(b).toMatchObject({ direction: 'rising', recentClicks: 10, baselineClicks: 5 })
  })
})

describe('movers reports lost queries', () => {
  // Grill repro: `gone` vanished from the current period; `fell` dropped
  // below minImpressions. Both were invisible when movers started from the
  // current period only.
  const current = [{ query: 'fell', page: '/a', clicks: 1, impressions: 40, ctr: 0.025, position: 30 }]
  const previous = [
    { query: 'gone', page: '/g', clicks: 500, impressions: 5000, ctr: 0.1, position: 2 },
    { query: 'fell', page: '/a', clicks: 400, impressions: 6000, ctr: 0.066, position: 3 },
  ]

  it('marks a vanished pair and a pair below the floor as declining', () => {
    const result = analyzeMovers({ current, previous })
    expect(result.declining.map(r => r.keyword)).toEqual(['gone', 'fell'])
    const gone = result.declining.find(r => r.keyword === 'gone')!
    expect(gone.recentClicks).toBe(0)
    expect(gone.recentPosition).toBeNull()
    expect(gone.positionChange).toBeNull()
  })

  it('sorts by absolute click delta by default, and by percent on request', () => {
    const rows = [
      { query: 'big', page: '/b', clicks: 100, impressions: 1000, ctr: 0.1, position: 3 },
      { query: 'small', page: '/s', clicks: 3, impressions: 100, ctr: 0.03, position: 8 },
    ]
    const prior = [
      { query: 'big', page: '/b', clicks: 50, impressions: 1000, ctr: 0.05, position: 3 },
      { query: 'small', page: '/s', clicks: 1, impressions: 100, ctr: 0.01, position: 8 },
    ]
    expect(analyzeMovers({ current: rows, previous: prior }).rising.map(r => r.keyword)).toEqual(['big', 'small'])
    expect(analyzeMovers({ current: rows, previous: prior }, { sortBy: 'clicksDeltaPercent' }).rising.map(r => r.keyword)).toEqual(['small', 'big'])
  })
})

describe('fetch budget is separate from the output limit', () => {
  const rows = Array.from({ length: 12 }, (_, i) => ({
    query: `q${i}`,
    page: `/p${i}`,
    clicks: 1,
    impressions: 500 + i,
    ctr: 0.002,
    position: 8,
  }))

  it('fetches the default budget and reports the full match count', async () => {
    const { source, states } = periodSource(rows, [])
    const out = await runAnalyzerFromSource(source, { type: 'striking-distance', ...COMPARISON, limit: 5 }, defaultAnalyzerRegistry)
    expect(states.map(s => s.rowLimit)).toEqual([25_000])
    expect(out.results).toHaveLength(5)
    expect(out.meta.total).toBe(12)
    expect(out.meta.coverage).toEqual({ kind: 'complete' })
  })

  it('uses an opt-in fetch budget, clamped to the maximum', async () => {
    const { source, states } = periodSource(rows, [])
    await runAnalyzerFromSource(source, { type: 'striking-distance', ...COMPARISON, fetchBudget: 60_000 }, defaultAnalyzerRegistry)
    await runAnalyzerFromSource(source, { type: 'striking-distance', ...COMPARISON, fetchBudget: 1_000_000 }, defaultAnalyzerRegistry)
    expect(states.map(s => s.rowLimit)).toEqual([60_000, 100_000])
  })
})

describe('truncated fetches are reported', () => {
  // Grill repro: decay with a truncated current fetch dropped /b from the
  // current period, so /b looked like it lost all clicks.
  const previous = [{ page: '/a', clicks: 200, impressions: 2000, ctr: 0.1, position: 2 }, { page: '/b', clicks: 100, impressions: 1000, ctr: 0.1, position: 3 }]
  const current = [{ page: '/a', clicks: 190, impressions: 2000, ctr: 0.095, position: 2 }, { page: '/b', clicks: 90, impressions: 1000, ctr: 0.09, position: 3 }]

  it('marks decay truncated when a period fills its fetch budget', async () => {
    const { source } = periodSource(current, previous)
    const out = await runAnalyzerFromSource(source, { type: 'decay', ...COMPARISON, fetchBudget: 1 }, defaultAnalyzerRegistry)
    expect(out.meta.coverage).toEqual({ kind: 'truncated', fetched: 1 })
  })

  it('reports complete coverage and no false decay with the default budget', async () => {
    const { source } = periodSource(current, previous)
    const out = await runAnalyzerFromSource(source, { type: 'decay', ...COMPARISON }, defaultAnalyzerRegistry)
    expect(out.meta.coverage).toEqual({ kind: 'complete' })
    expect(out.results).toEqual([])
  })
})

describe('local (SQL) analyzers', () => {
  let dir: string
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'gscdump-correctness-'))
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  async function engineWith(seeds: { table: TableName, date: string, rows: Row[] }[]) {
    const handle = createNodeDuckDBHandle()
    const factory = { getDuckDB: async () => handle }
    const engine = createStorageEngine({
      dataSource: createFilesystemDataSource({ rootDir: dir }),
      manifestStore: createFilesystemManifestStore({ path: join(dir, 'manifest.json') }),
      codec: createDuckDBCodec(factory),
      executor: createDuckDBExecutor(factory),
    })
    for (const s of seeds)
      await engine.writeDay({ userId: 'u', siteId: 's', table: s.table, date: s.date }, s.rows)
    return (params: Parameters<typeof runAnalyzerWithEngine>[2]) =>
      runAnalyzerWithEngine({ engine }, { userId: 'u', siteId: 's' }, params, defaultAnalyzerRegistry)
  }

  it('movers reports a vanished pair as declining', async () => {
    const run = await engineWith([
      { table: 'page_queries', date: '2026-04-10', rows: [
        { url: '/', query: 'kept', date: '2026-04-10', clicks: 100, impressions: 1000, sum_position: 2000 },
      ] },
      { table: 'page_queries', date: '2026-04-03', rows: [
        { url: '/', query: 'kept', date: '2026-04-03', clicks: 100, impressions: 1000, sum_position: 2000 },
        { url: '/gone', query: 'gone', date: '2026-04-03', clicks: 500, impressions: 5000, sum_position: 5000 },
      ] },
    ])
    const out = await run({ type: 'movers', ...COMPARISON })
    const gone = (out.results as unknown as MoverRow[]).find(r => r.keyword === 'gone')
    expect(gone).toMatchObject({ direction: 'declining', recentClicks: 0, baselineClicks: 500, recentPosition: null })
    expect(out.meta.declining).toBe(1)
  }, 30_000)

  it('brand computes its summary over every row, not the returned page', async () => {
    const run = await engineWith([
      { table: 'page_queries', date: '2026-04-10', rows: [
        { url: '/', query: 'acme shoes', date: '2026-04-10', clicks: 100, impressions: 1000, sum_position: 2000 },
        { url: '/', query: 'running shoes', date: '2026-04-10', clicks: 60, impressions: 1000, sum_position: 5000 },
        { url: '/', query: 'trail shoes', date: '2026-04-10', clicks: 40, impressions: 1000, sum_position: 5000 },
      ] },
    ])
    const out = await run({ type: 'brand', startDate: '2026-04-10', endDate: '2026-04-10', brandTerms: ['acme'], limit: 1 })
    expect(out.results).toHaveLength(1)
    expect(out.meta.total).toBe(3)
    expect(out.meta.summary).toMatchObject({ brandClicks: 100, nonBrandClicks: 100, brandShare: 0.5 })
  }, 30_000)
})

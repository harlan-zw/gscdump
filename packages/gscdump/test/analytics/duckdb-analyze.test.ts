import type { Row, TableName } from '../../src/analytics'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  AnalyzerUnsupportedError,
  analyzeWithDuckDB,
  createDuckDBCodec,
  createDuckDBExecutor,
  createStorageEngine,
} from '../../src/analytics'
import {
  createNodeDuckDBHandle,
  resetNodeDuckDB,
} from '../../src/analytics/adapters/duckdb-node'
import {
  createFilesystemDataSource,
  createFilesystemManifestStore,
} from '../../src/analytics/adapters/filesystem'

afterAll(() => {
  resetNodeDuckDB()
})

interface Seed {
  table: TableName
  date: string
  rows: Row[]
}

async function setup(dir: string) {
  const handle = createNodeDuckDBHandle()
  const factory = { getDuckDB: async () => handle }
  const codec = createDuckDBCodec(factory)
  const executor = createDuckDBExecutor(factory)
  const dataSource = createFilesystemDataSource({ rootDir: dir })
  const manifestStore = createFilesystemManifestStore({ path: join(dir, 'manifest.json') })
  const engine = createStorageEngine({ dataSource, manifestStore, codec, executor })
  return { engine, dataSource, manifestStore, factory }
}

async function seed(engine: ReturnType<typeof createStorageEngine>, userId: string, siteId: string, seeds: Seed[]): Promise<void> {
  for (const s of seeds) {
    await engine.writeDay({ userId, siteId, table: s.table, date: s.date }, s.rows)
  }
}

const USER = 'u1'
const SITE = 's1'

describe('analyzeWithDuckDB', () => {
  let dir: string
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'gscdump-dba-'))
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('striking-distance filters by position/impressions/ctr', async () => {
    const env = await setup(dir)
    await seed(env.engine, USER, SITE, [
      {
        table: 'page_keywords',
        date: '2026-04-10',
        rows: [
          // Candidate: position ~6, impressions 500, low ctr
          { url: '/g', query: 'near miss', date: '2026-04-10', clicks: 2, impressions: 500, sum_position: 2500 },
          // Excluded by position (~2)
          { url: '/h', query: 'strong', date: '2026-04-10', clicks: 100, impressions: 500, sum_position: 500 },
          // Excluded by impressions
          { url: '/x', query: 'too small', date: '2026-04-10', clicks: 1, impressions: 10, sum_position: 50 },
        ],
      },
    ])

    const out = await analyzeWithDuckDB(
      { factory: env.factory, dataSource: env.dataSource, manifestStore: env.manifestStore },
      { userId: USER, siteId: SITE },
      { type: 'striking-distance', startDate: '2026-04-10', endDate: '2026-04-10' },
    )
    expect(out.meta.source).toBe('local')
    expect(out.results).toHaveLength(1)
    expect((out.results[0] as { keyword: string }).keyword).toBe('near miss')
    expect((out.results[0] as { potentialClicks: number }).potentialClicks).toBeGreaterThan(0)
  }, 30_000)

  it('opportunity scores and ranks candidates', async () => {
    const env = await setup(dir)
    await seed(env.engine, USER, SITE, [
      {
        table: 'page_keywords',
        date: '2026-04-10',
        rows: [
          // Position ~11, high impressions, low ctr: strong opportunity
          { url: '/a', query: 'big opportunity', date: '2026-04-10', clicks: 5, impressions: 10000, sum_position: 100000 },
          // Below minImpressions (100 default)
          { url: '/b', query: 'tiny', date: '2026-04-10', clicks: 1, impressions: 50, sum_position: 250 },
        ],
      },
    ])

    const out = await analyzeWithDuckDB(
      { factory: env.factory, dataSource: env.dataSource, manifestStore: env.manifestStore },
      { userId: USER, siteId: SITE },
      { type: 'opportunity', startDate: '2026-04-10', endDate: '2026-04-10' },
    )
    expect(out.results).toHaveLength(1)
    const r = out.results[0] as { keyword: string, opportunityScore: number, factors: Record<string, number> }
    expect(r.keyword).toBe('big opportunity')
    expect(r.opportunityScore).toBeGreaterThan(0)
    expect(r.factors.positionScore).toBeGreaterThan(0)
  }, 30_000)

  it('brand segments keywords and builds summary', async () => {
    const env = await setup(dir)
    await seed(env.engine, USER, SITE, [
      {
        table: 'page_keywords',
        date: '2026-04-10',
        rows: [
          { url: '/', query: 'acme shoes', date: '2026-04-10', clicks: 10, impressions: 200, sum_position: 200 },
          { url: '/', query: 'acme running', date: '2026-04-10', clicks: 8, impressions: 150, sum_position: 200 },
          { url: '/', query: 'running shoes', date: '2026-04-10', clicks: 5, impressions: 100, sum_position: 300 },
        ],
      },
    ])

    const out = await analyzeWithDuckDB(
      { factory: env.factory, dataSource: env.dataSource, manifestStore: env.manifestStore },
      { userId: USER, siteId: SITE },
      { type: 'brand', brandTerms: ['acme'], startDate: '2026-04-10', endDate: '2026-04-10' },
    )
    const rows = out.results as Array<{ query: string, segment: string }>
    expect(rows.filter(r => r.segment === 'brand')).toHaveLength(2)
    expect(rows.filter(r => r.segment === 'non-brand')).toHaveLength(1)
    const summary = (out.meta as any).summary
    expect(summary.brandClicks).toBe(18)
    expect(summary.nonBrandClicks).toBe(5)
    expect(summary.brandShare).toBeCloseTo(18 / 23, 4)
  }, 30_000)

  it('clustering groups intent prefixes', async () => {
    const env = await setup(dir)
    await seed(env.engine, USER, SITE, [
      {
        table: 'keywords',
        date: '2026-04-10',
        rows: [
          { query: 'how to bake bread', date: '2026-04-10', clicks: 10, impressions: 200, sum_position: 600 },
          { query: 'how to make pasta', date: '2026-04-10', clicks: 15, impressions: 300, sum_position: 900 },
          { query: 'best running shoes', date: '2026-04-10', clicks: 20, impressions: 400, sum_position: 1200 },
          { query: 'best cookware sets', date: '2026-04-10', clicks: 25, impressions: 500, sum_position: 1500 },
          { query: 'random thing', date: '2026-04-10', clicks: 3, impressions: 100, sum_position: 500 },
        ],
      },
    ])

    const out = await analyzeWithDuckDB(
      { factory: env.factory, dataSource: env.dataSource, manifestStore: env.manifestStore },
      { userId: USER, siteId: SITE },
      { type: 'clustering', startDate: '2026-04-10', endDate: '2026-04-10' },
    )
    const clusters = out.results as Array<{ clusterName: string, clusterType: string, keywordCount: number }>
    const names = clusters.map(c => c.clusterName).sort()
    expect(names).toContain('how to')
    expect(names).toContain('best')
    const howTo = clusters.find(c => c.clusterName === 'how to')!
    expect(howTo.clusterType).toBe('intent')
    expect(howTo.keywordCount).toBe(2)
  }, 30_000)

  it('concentration computes Gini/HHI/top-N', async () => {
    const env = await setup(dir)
    await seed(env.engine, USER, SITE, [
      {
        table: 'pages',
        date: '2026-04-10',
        rows: [
          { url: '/a', date: '2026-04-10', clicks: 1000, impressions: 5000, sum_position: 5000 },
          { url: '/b', date: '2026-04-10', clicks: 10, impressions: 100, sum_position: 200 },
          { url: '/c', date: '2026-04-10', clicks: 5, impressions: 50, sum_position: 100 },
        ],
      },
    ])

    const out = await analyzeWithDuckDB(
      { factory: env.factory, dataSource: env.dataSource, manifestStore: env.manifestStore },
      { userId: USER, siteId: SITE },
      { type: 'concentration', dimension: 'pages', topN: 2, startDate: '2026-04-10', endDate: '2026-04-10' },
    )
    expect(out.results).toHaveLength(1)
    const r = out.results[0] as {
      totalClicks: number
      totalItems: number
      hhi: number
      riskLevel: string
      topNItems: Array<{ key: string, clicks: number, share: number }>
      giniCoefficient: number
    }
    expect(r.totalItems).toBe(3)
    expect(r.totalClicks).toBe(1015)
    expect(r.topNItems).toHaveLength(2)
    expect(r.topNItems[0].key).toBe('/a')
    // Heavy skew toward /a → high risk
    expect(r.hhi).toBeGreaterThan(2500)
    expect(r.riskLevel).toBe('high')
    expect(r.giniCoefficient).toBeGreaterThan(0.5)
  }, 30_000)

  it('seasonality aggregates by month and flags peaks/troughs', async () => {
    const env = await setup(dir)
    // Pick dates in three different months with divergent traffic
    const daysJan = ['2026-01-05', '2026-01-15', '2026-01-25']
    const daysFeb = ['2026-02-05', '2026-02-15', '2026-02-25']
    const daysMar = ['2026-03-05', '2026-03-15', '2026-03-25']
    const seeds: Seed[] = []
    for (const d of daysJan) {
      seeds.push({
        table: 'pages',
        date: d,
        rows: [{ url: '/', date: d, clicks: 100, impressions: 1000, sum_position: 1000 }],
      })
    }
    for (const d of daysFeb) {
      seeds.push({
        table: 'pages',
        date: d,
        rows: [{ url: '/', date: d, clicks: 10, impressions: 100, sum_position: 100 }],
      })
    }
    for (const d of daysMar) {
      seeds.push({
        table: 'pages',
        date: d,
        rows: [{ url: '/', date: d, clicks: 100, impressions: 1000, sum_position: 1000 }],
      })
    }
    await seed(env.engine, USER, SITE, seeds)

    const out = await analyzeWithDuckDB(
      { factory: env.factory, dataSource: env.dataSource, manifestStore: env.manifestStore },
      { userId: USER, siteId: SITE },
      { type: 'seasonality', startDate: '2026-01-01', endDate: '2026-03-31' },
    )
    const rows = out.results as Array<{ month: string, isPeak: boolean, isTrough: boolean }>
    expect(rows).toHaveLength(3)
    const feb = rows.find(r => r.month === '2026-02')!
    expect(feb.isTrough).toBe(true)
    expect((out.meta as any).insufficientData).toBe(true)
    expect((out.meta as any).troughMonths).toContain('02')
  }, 30_000)

  it('movers compares two periods and labels rising/declining', async () => {
    const env = await setup(dir)
    await seed(env.engine, USER, SITE, [
      {
        table: 'page_keywords',
        date: '2026-04-10',
        rows: [
          { url: '/', query: 'rising term', date: '2026-04-10', clicks: 100, impressions: 1000, sum_position: 3000 },
          { url: '/', query: 'declining term', date: '2026-04-10', clicks: 10, impressions: 200, sum_position: 1000 },
        ],
      },
      {
        table: 'page_keywords',
        date: '2026-04-03',
        rows: [
          { url: '/', query: 'rising term', date: '2026-04-03', clicks: 10, impressions: 100, sum_position: 500 },
          { url: '/', query: 'declining term', date: '2026-04-03', clicks: 100, impressions: 1000, sum_position: 5000 },
        ],
      },
    ])

    const out = await analyzeWithDuckDB(
      { factory: env.factory, dataSource: env.dataSource, manifestStore: env.manifestStore },
      { userId: USER, siteId: SITE },
      {
        type: 'movers',
        startDate: '2026-04-10',
        endDate: '2026-04-10',
        prevStartDate: '2026-04-03',
        prevEndDate: '2026-04-03',
      },
    )
    const rows = out.results as Array<{ keyword: string, direction: string, series: Array<{ week: string, clicks: number }> }>
    const rising = rows.find(r => r.keyword === 'rising term')
    const declining = rows.find(r => r.keyword === 'declining term')
    expect(rising?.direction).toBe('rising')
    expect(declining?.direction).toBe('declining')
    expect((out.meta as any).rising).toBe(1)
    expect((out.meta as any).declining).toBe(1)
    // Each entity gets a weekly series spanning both periods.
    expect(rising?.series.length).toBeGreaterThan(0)
    expect(rising?.series[0]).toHaveProperty('week')
    expect(rising?.series[0]).toHaveProperty('clicks')
  }, 30_000)

  it('decay flags pages that lost traffic beyond threshold', async () => {
    const env = await setup(dir)
    await seed(env.engine, USER, SITE, [
      {
        table: 'pages',
        date: '2026-04-10',
        rows: [
          { url: '/decaying', date: '2026-04-10', clicks: 10, impressions: 100, sum_position: 500 },
          { url: '/stable', date: '2026-04-10', clicks: 50, impressions: 500, sum_position: 500 },
        ],
      },
      {
        table: 'pages',
        date: '2026-04-03',
        rows: [
          { url: '/decaying', date: '2026-04-03', clicks: 100, impressions: 1000, sum_position: 3000 },
          { url: '/stable', date: '2026-04-03', clicks: 50, impressions: 500, sum_position: 500 },
        ],
      },
    ])

    const out = await analyzeWithDuckDB(
      { factory: env.factory, dataSource: env.dataSource, manifestStore: env.manifestStore },
      { userId: USER, siteId: SITE },
      {
        type: 'decay',
        startDate: '2026-04-10',
        endDate: '2026-04-10',
        prevStartDate: '2026-04-03',
        prevEndDate: '2026-04-03',
      },
    )
    expect(out.results).toHaveLength(1)
    const r = out.results[0] as { page: string, lostClicks: number, declinePercent: number, series: Array<{ week: string, clicks: number }> }
    expect(r.page).toBe('/decaying')
    expect(r.lostClicks).toBe(90)
    expect(r.declinePercent).toBeCloseTo(0.9, 4)
    expect(r.series.length).toBeGreaterThan(0)
    expect(r.series[0]).toHaveProperty('week')
    expect(r.series[0]).toHaveProperty('clicks')
  }, 30_000)

  it('trends buckets by week and classifies growth/decline', async () => {
    const env = await setup(dir)
    // Build 8 weeks of data for 3 pages with distinct trajectories:
    //   /growing    : climbs linearly
    //   /declining  : drops linearly
    //   /steady     : flat
    const seeds: Seed[] = []
    const weekStarts = [
      '2026-02-09',
      '2026-02-16',
      '2026-02-23',
      '2026-03-02',
      '2026-03-09',
      '2026-03-16',
      '2026-03-23',
      '2026-03-30',
    ]
    weekStarts.forEach((date, i) => {
      seeds.push({
        table: 'pages',
        date,
        rows: [
          { url: '/growing', date, clicks: 10 * (i + 1), impressions: 100 * (i + 1), sum_position: 100 * (i + 1) },
          { url: '/declining', date, clicks: 10 * (8 - i), impressions: 100 * (8 - i), sum_position: 100 * (8 - i) },
          { url: '/steady', date, clicks: 20, impressions: 200, sum_position: 200 },
        ],
      })
    })
    await seed(env.engine, USER, SITE, seeds)

    const out = await analyzeWithDuckDB(
      { factory: env.factory, dataSource: env.dataSource, manifestStore: env.manifestStore },
      { userId: USER, siteId: SITE },
      { type: 'trends', weeks: 8, startDate: '2026-02-09', endDate: '2026-04-05', minImpressions: 100, minWeeksWithData: 2 },
    )
    const rows = out.results as Array<{ page: string, trend: string, series: unknown[], growthRatio: number }>
    const growing = rows.find(r => r.page === '/growing')
    const declining = rows.find(r => r.page === '/declining')
    const steady = rows.find(r => r.page === '/steady')

    expect(growing).toBeDefined()
    expect(declining).toBeDefined()
    expect(steady).toBeDefined()

    expect(['accelerating', 'growing']).toContain(growing!.trend)
    expect(['declining', 'cratering']).toContain(declining!.trend)
    expect(steady!.trend).toBe('steady')

    // 8 weeks of data, each page should have 8 bucketed series entries
    expect(growing!.series).toHaveLength(8)
    expect(growing!.growthRatio).toBeGreaterThan(1.5)
    expect(declining!.growthRatio).toBeLessThan(0.5)

    const meta = out.meta as { dimension: string, weeks: number, counts: Record<string, number> }
    expect(meta.dimension).toBe('pages')
    expect(meta.weeks).toBe(8)
    expect(meta.counts.steady).toBe(1)
  }, 30_000)

  it('trends supports keywords dimension', async () => {
    const env = await setup(dir)
    const weekStarts = ['2026-03-02', '2026-03-09', '2026-03-16', '2026-03-23']
    const seeds: Seed[] = weekStarts.map((date, i) => ({
      table: 'keywords' as const,
      date,
      rows: [{ query: 'ascending term', date, clicks: 10 * (i + 1), impressions: 100 * (i + 1), sum_position: 100 * (i + 1) }],
    }))
    await seed(env.engine, USER, SITE, seeds)

    const out = await analyzeWithDuckDB(
      { factory: env.factory, dataSource: env.dataSource, manifestStore: env.manifestStore },
      { userId: USER, siteId: SITE },
      { type: 'trends', dimension: 'keywords', weeks: 4, startDate: '2026-03-02', endDate: '2026-03-29', minImpressions: 100, minWeeksWithData: 2 },
    )
    const rows = out.results as Array<{ query: string, trend: string }>
    expect(rows[0].query).toBe('ascending term')
    expect(['accelerating', 'growing']).toContain(rows[0].trend)
  }, 30_000)

  it('throws AnalyzerUnsupportedError for cannibalization/zero-click', async () => {
    const env = await setup(dir)
    await expect(
      analyzeWithDuckDB(
        { factory: env.factory, dataSource: env.dataSource, manifestStore: env.manifestStore },
        { userId: USER, siteId: SITE },
        { type: 'cannibalization' },
      ),
    ).rejects.toThrow(AnalyzerUnsupportedError)
    await expect(
      analyzeWithDuckDB(
        { factory: env.factory, dataSource: env.dataSource, manifestStore: env.manifestStore },
        { userId: USER, siteId: SITE },
        { type: 'zero-click' },
      ),
    ).rejects.toThrow(AnalyzerUnsupportedError)
  }, 30_000)
})

import type { Row, TableName } from '@gscdump/engine/contracts'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createDuckDBCodec,
  createDuckDBExecutor,
  createStorageEngine,
} from '@gscdump/engine'
import {
  createFilesystemDataSource,
  createFilesystemManifestStore,
} from '@gscdump/engine/filesystem'
import {
  createNodeDuckDBHandle,
  resetNodeDuckDB,
} from '@gscdump/engine/node'
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import { defaultAnalyzerRegistry } from '../src/default-registry'
import { runAnalyzerWithEngine as rawRunAnalyzerWithEngine } from '@gscdump/engine/source'

function runAnalyzerWithEngine(
  deps: Parameters<typeof rawRunAnalyzerWithEngine>[0],
  ctx: Parameters<typeof rawRunAnalyzerWithEngine>[1],
  params: Parameters<typeof rawRunAnalyzerWithEngine>[2],
): ReturnType<typeof rawRunAnalyzerWithEngine> {
  return rawRunAnalyzerWithEngine(deps, ctx, params, defaultAnalyzerRegistry)
}

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
  return { engine }
}

async function seed(engine: ReturnType<typeof createStorageEngine>, userId: string, siteId: string, seeds: Seed[]): Promise<void> {
  for (const s of seeds) {
    await engine.writeDay({ userId, siteId, table: s.table, date: s.date }, s.rows)
  }
}

const USER = 'u1'
const SITE = 's1'

describe('runAnalyzerWithEngine', () => {
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

    const out = await runAnalyzerWithEngine(
      { engine: env.engine },
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

    const out = await runAnalyzerWithEngine(
      { engine: env.engine },
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

    const out = await runAnalyzerWithEngine(
      { engine: env.engine },
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

    const out = await runAnalyzerWithEngine(
      { engine: env.engine },
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

    const out = await runAnalyzerWithEngine(
      { engine: env.engine },
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

    const out = await runAnalyzerWithEngine(
      { engine: env.engine },
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

    const out = await runAnalyzerWithEngine(
      { engine: env.engine },
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

    const out = await runAnalyzerWithEngine(
      { engine: env.engine },
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

    const out = await runAnalyzerWithEngine(
      { engine: env.engine },
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

    const out = await runAnalyzerWithEngine(
      { engine: env.engine },
      { userId: USER, siteId: SITE },
      { type: 'trends', dimension: 'keywords', weeks: 4, startDate: '2026-03-02', endDate: '2026-03-29', minImpressions: 100, minWeeksWithData: 2 },
    )
    const rows = out.results as Array<{ query: string, trend: string }>
    expect(rows[0].query).toBe('ascending term')
    expect(['accelerating', 'growing']).toContain(rows[0].trend)
  }, 30_000)

  it('ctr-anomaly flags rolling CTR breaches while position holds', async () => {
    const env = await setup(dir)

    // Build a 30-day series for (query, url) = (watch me fall, /victim):
    //   days 1–20: healthy ~8% CTR at position ~3
    //   days 21–30: CTR collapses to ~1% while position stays at ~3
    // That's the SERP-feature-theft signature the analyzer targets.
    const seeds: Seed[] = []
    const startDay = new Date('2026-03-01')
    for (let i = 0; i < 30; i++) {
      const d = new Date(startDay)
      d.setUTCDate(startDay.getUTCDate() + i)
      const dateStr = d.toISOString().split('T')[0]
      const healthy = i < 20
      const impressions = 1000
      const clicks = healthy ? 80 : 10
      seeds.push({
        table: 'page_keywords',
        date: dateStr,
        rows: [
          // target entity
          { url: '/victim', query: 'watch me fall', date: dateStr, clicks, impressions, sum_position: 3 * impressions },
          // noise: a stable entity that should NOT be flagged
          { url: '/stable', query: 'always fine', date: dateStr, clicks: 50, impressions: 500, sum_position: 5 * 500 },
        ],
      })
    }
    await seed(env.engine, USER, SITE, seeds)

    const out = await runAnalyzerWithEngine(
      { engine: env.engine },
      { userId: USER, siteId: SITE },
      { type: 'ctr-anomaly', startDate: '2026-03-01', endDate: '2026-03-30' },
    )

    const rows = out.results as Array<{
      keyword: string
      page: string
      breachDaysDown: number
      clicksLost: number
      maxZ: number
      series: Array<{ date: string, breach: boolean, z: number }>
    }>

    const victim = rows.find(r => r.keyword === 'watch me fall')
    expect(victim).toBeDefined()
    expect(victim!.page).toBe('/victim')
    expect(victim!.breachDaysDown).toBeGreaterThanOrEqual(2)
    expect(victim!.clicksLost).toBeGreaterThan(0)
    expect(victim!.maxZ).toBeGreaterThan(2)
    // The /stable entity must not appear (no envelope breach).
    expect(rows.find(r => r.keyword === 'always fine')).toBeUndefined()
    // Breach markers land in the second half of the window.
    const breachDates = victim!.series.filter(s => s.breach).map(s => s.date)
    expect(breachDates.every(d => d >= '2026-03-15')).toBe(true)

    const meta = out.meta as { totalClicksLost: number, zThreshold: number }
    expect(meta.totalClicksLost).toBeGreaterThan(0)
    expect(meta.zThreshold).toBe(2)
  }, 30_000)

  it('position-volatility ranks pages by per-day stddev + DoD shift', async () => {
    const env = await setup(dir)

    // /stable: ~5 queries at tight position 3±0.2, no DoD shift → low vol
    // /chaos:  5 queries spread 1..20 every day, oscillating means → high vol
    const seeds: Seed[] = []
    const start = new Date('2026-03-01')
    for (let i = 0; i < 10; i++) {
      const d = new Date(start)
      d.setUTCDate(start.getUTCDate() + i)
      const dateStr = d.toISOString().split('T')[0]
      const rows: Row[] = []
      for (let q = 0; q < 5; q++) {
        rows.push({
          url: '/stable',
          query: `stable-${q}`,
          date: dateStr,
          clicks: 5,
          impressions: 100,
          sum_position: 3 * 100,
        })
        // /chaos spreads positions 1-20 and oscillates day over day
        const basePos = i % 2 === 0 ? 2 + q * 2 : 18 - q * 2
        rows.push({
          url: '/chaos',
          query: `chaos-${q}`,
          date: dateStr,
          clicks: 1,
          impressions: 100,
          sum_position: basePos * 100,
        })
      }
      seeds.push({ table: 'page_keywords', date: dateStr, rows })
    }
    await seed(env.engine, USER, SITE, seeds)

    const out = await runAnalyzerWithEngine(
      { engine: env.engine },
      { userId: USER, siteId: SITE },
      { type: 'position-volatility', startDate: '2026-03-01', endDate: '2026-03-10', minWeeksWithData: 5 },
    )
    const pages = out.results as Array<{ page: string, avgVolatility: number, days: unknown[] }>
    expect(pages).toHaveLength(2)
    expect(pages[0]!.page).toBe('/chaos')
    expect(pages[0]!.avgVolatility).toBeGreaterThan(pages[1]!.avgVolatility)
    const meta = out.meta as { dates: string[], maxVolatility: number }
    expect(meta.dates.length).toBeGreaterThanOrEqual(5)
    expect(meta.maxVolatility).toBeGreaterThan(0)
  }, 30_000)

  it('long-tail fits power-law slopes and classifies fingerprints', async () => {
    const env = await setup(dir)

    // /broad: flat distribution across many queries (flat-tail authority)
    // /thin:  one huge head + a few tail queries (head-heavy)
    const rowsAll: Row[] = []
    for (let q = 0; q < 20; q++) {
      rowsAll.push({
        url: '/broad',
        query: `broad-${q}`,
        date: '2026-04-10',
        clicks: 10,
        impressions: 100 - q, // gentle decay
        sum_position: 5 * (100 - q),
      })
    }
    // /thin: rank 1 has 10000 impressions, ranks 2..15 drop to ~10
    rowsAll.push({ url: '/thin', query: 'thin-head', date: '2026-04-10', clicks: 500, impressions: 10000, sum_position: 10000 })
    for (let q = 1; q < 15; q++) {
      rowsAll.push({
        url: '/thin',
        query: `thin-${q}`,
        date: '2026-04-10',
        clicks: 1,
        impressions: Math.max(5, Math.round(10000 / (q * q * q))),
        sum_position: 5 * Math.max(5, Math.round(10000 / (q * q * q))),
      })
    }
    await seed(env.engine, USER, SITE, [{ table: 'page_keywords', date: '2026-04-10', rows: rowsAll }])

    const out = await runAnalyzerWithEngine(
      { engine: env.engine },
      { userId: USER, siteId: SITE },
      { type: 'long-tail', startDate: '2026-04-10', endDate: '2026-04-10' },
    )
    const results = out.results as Array<{
      page: string
      slope: number
      fingerprint: string
      r2: number
      points: Array<{ rank: number, impressions: number }>
    }>
    const broad = results.find(r => r.page === '/broad')
    const thin = results.find(r => r.page === '/thin')
    expect(broad).toBeDefined()
    expect(thin).toBeDefined()
    // Thin has a much steeper negative slope than broad.
    expect(thin!.slope).toBeLessThan(broad!.slope)
    expect(thin!.fingerprint).toBe('head-heavy')
    expect(broad!.points.length).toBeGreaterThan(0)
  }, 30_000)

  it('intent-atlas clusters queries by their top-2 token cooccurrence', async () => {
    const env = await setup(dir)
    // Three "vue components" queries (different prefixes) + three "nuxt seo"
    // queries should resolve into two distinct clusters keyed by their top
    // tokens.
    const rows: Row[] = []
    const dates = ['2026-04-01', '2026-04-02', '2026-04-03']
    for (const d of dates) {
      rows.push(
        { query: 'best vue components', date: d, clicks: 5, impressions: 200, sum_position: 5 * 200 },
        { query: 'vue components library', date: d, clicks: 3, impressions: 150, sum_position: 4 * 150 },
        { query: 'top components for vue beginners', date: d, clicks: 2, impressions: 100, sum_position: 6 * 100 },
        { query: 'nuxt seo guide', date: d, clicks: 4, impressions: 180, sum_position: 3 * 180 },
        { query: 'how to nuxt seo setup', date: d, clicks: 6, impressions: 220, sum_position: 4 * 220 },
        { query: 'nuxt seo module', date: d, clicks: 8, impressions: 300, sum_position: 2 * 300 },
      )
    }
    for (const d of dates) {
      await env.engine.writeDay(
        { userId: USER, siteId: SITE, table: 'keywords', date: d },
        rows.filter(r => r.date === d),
      )
    }

    const out = await runAnalyzerWithEngine(
      { engine: env.engine },
      { userId: USER, siteId: SITE },
      { type: 'intent-atlas', startDate: '2026-04-01', endDate: '2026-04-03', minImpressions: 100, minClusterSize: 2 },
    )
    const clusters = out.results as Array<{
      clusterKey: string
      keywordCount: number
      keywords: Array<{ query: string }>
    }>
    expect(clusters.length).toBeGreaterThanOrEqual(2)
    const keys = clusters.map(c => c.clusterKey)
    expect(keys.some(k => k.includes('components') && k.includes('vue'))).toBe(true)
    expect(keys.some(k => k.includes('nuxt') && k.includes('seo'))).toBe(true)
  }, 30_000)

  it('query-migration matches lost queries to fuzzy gainers via levenshtein', async () => {
    const env = await setup(dir)
    // Previous period: /old ranks for "react server components" + "react hooks intro"
    // Current period:  /new ranks for "react server component" (1 edit) + "react hook intro" (1 edit)
    // Expected: one migration edge /old → /new with 2 absorbed queries.
    await seed(env.engine, USER, SITE, [
      {
        table: 'page_keywords',
        date: '2026-03-15',
        rows: [
          { url: '/old', query: 'react server components', date: '2026-03-15', clicks: 10, impressions: 500, sum_position: 4 * 500 },
          { url: '/old', query: 'react hooks intro', date: '2026-03-15', clicks: 5, impressions: 300, sum_position: 5 * 300 },
        ],
      },
      {
        table: 'page_keywords',
        date: '2026-04-15',
        rows: [
          { url: '/new', query: 'react server component', date: '2026-04-15', clicks: 12, impressions: 480, sum_position: 3 * 480 },
          { url: '/new', query: 'react hook intro', date: '2026-04-15', clicks: 6, impressions: 280, sum_position: 4 * 280 },
        ],
      },
    ])

    const out = await runAnalyzerWithEngine(
      { engine: env.engine },
      { userId: USER, siteId: SITE },
      {
        type: 'query-migration',
        startDate: '2026-04-15',
        endDate: '2026-04-15',
        prevStartDate: '2026-03-15',
        prevEndDate: '2026-03-15',
        minImpressions: 50,
      },
    )
    const edges = out.results as Array<{
      sourcePage: string
      targetPage: string
      queryCount: number
      fuzzyCount: number
      examples: Array<{ sourceQuery: string, targetQuery: string, matchType: string }>
    }>
    expect(edges).toHaveLength(1)
    expect(edges[0]!.sourcePage).toBe('/old')
    expect(edges[0]!.targetPage).toBe('/new')
    expect(edges[0]!.queryCount).toBe(2)
    expect(edges[0]!.fuzzyCount).toBe(2)
    const meta = out.meta as { nodes: unknown[], totalAbsorbed: number }
    expect(meta.nodes).toHaveLength(2)
    expect(meta.totalAbsorbed).toBeGreaterThan(0)
  }, 30_000)

  it('cannibalization detects multi-URL competition with severity and graph', async () => {
    const env = await setup(dir)
    await seed(env.engine, USER, SITE, [
      {
        table: 'page_keywords',
        date: '2026-04-10',
        rows: [
          // "best widget" cannibalized across 3 URLs — /widgets dominates impressions
          // but its CTR is hurt by /widgets/review + /blog/widgets stealing SERP slots.
          { url: '/widgets', query: 'best widget', date: '2026-04-10', clicks: 50, impressions: 1000, sum_position: 3000 },
          { url: '/widgets/review', query: 'best widget', date: '2026-04-10', clicks: 10, impressions: 800, sum_position: 6400 },
          { url: '/blog/widgets', query: 'best widget', date: '2026-04-10', clicks: 2, impressions: 600, sum_position: 7200 },
          // "solo term" has a single URL → not cannibalized, filtered out.
          { url: '/solo', query: 'solo term', date: '2026-04-10', clicks: 100, impressions: 1000, sum_position: 2000 },
          // Below minImpressions — excluded.
          { url: '/tiny', query: 'tiny term', date: '2026-04-10', clicks: 1, impressions: 10, sum_position: 100 },
        ],
      },
    ])

    const out = await runAnalyzerWithEngine(
      { engine: env.engine },
      { userId: USER, siteId: SITE },
      { type: 'cannibalization', startDate: '2026-04-10', endDate: '2026-04-10' },
    )

    const rows = out.results as Array<{
      keyword: string
      competitorCount: number
      competitors: Array<{ url: string, rank: number }>
      fragmentation: number
      stolenClicks: number
      severity: number
    }>

    expect(rows).toHaveLength(1)
    expect(rows[0]!.keyword).toBe('best widget')
    expect(rows[0]!.competitorCount).toBe(3)
    expect(rows[0]!.competitors[0]!.rank).toBe(1)
    expect(rows[0]!.competitors[0]!.url).toBe('/widgets')
    expect(rows[0]!.fragmentation).toBeGreaterThan(0)
    expect(rows[0]!.stolenClicks).toBeGreaterThan(0)
    expect(rows[0]!.severity).toBeGreaterThan(0)

    const meta = out.meta as { graph: { nodes: unknown[], edges: unknown[] } }
    expect(meta.graph.nodes).toHaveLength(3)
    // 3 URLs competing → C(3,2) = 3 edges.
    expect(meta.graph.edges).toHaveLength(3)
  }, 30_000)

  it('bayesian-ctr flags outliers via empirical-Bayes shrinkage', async () => {
    const env = await setup(dir)

    // 30 healthy queries at position ~5 with ~10% CTR form the Beta prior for
    // bucket=5. Two outliers at the same position: one massively under-CTR
    // and one massively over-CTR, each with enough impressions that their
    // posterior barely moves toward the prior mean.
    const rows: Row[] = []
    for (let i = 0; i < 30; i++) {
      rows.push({
        url: `/healthy-${i}`,
        query: `healthy-q-${i}`,
        date: '2026-04-10',
        clicks: 100,
        impressions: 1000,
        sum_position: 5 * 1000,
      })
    }
    // Underperformer: 500 imp, 5 clicks (1% ctr) — far below the ~10% prior.
    rows.push({
      url: '/loser',
      query: 'underperformer',
      date: '2026-04-10',
      clicks: 5,
      impressions: 500,
      sum_position: 5 * 500,
    })
    // Overperformer: 500 imp, 150 clicks (30% ctr) — well above the prior.
    rows.push({
      url: '/winner',
      query: 'overperformer',
      date: '2026-04-10',
      clicks: 150,
      impressions: 500,
      sum_position: 5 * 500,
    })

    await seed(env.engine, USER, SITE, [
      { table: 'page_keywords', date: '2026-04-10', rows },
    ])

    const out = await runAnalyzerWithEngine(
      { engine: env.engine },
      { userId: USER, siteId: SITE },
      { type: 'bayesian-ctr', startDate: '2026-04-10', endDate: '2026-04-10' },
    )

    const results = out.results as Array<{
      keyword: string
      page: string
      observedCtr: number
      posteriorMean: number
      ciLow: number
      ciHigh: number
      significance: number
      classification: 'overperforming' | 'underperforming' | 'expected'
      bucket: number
      priorAlpha: number
      priorBeta: number
      shrinkageDelta: number
      expectedClicksDelta: number
    }>

    // Outliers should dominate the significance ranking.
    const top2 = results.slice(0, 2).map(r => r.keyword).sort()
    expect(top2).toEqual(['overperformer', 'underperformer'])

    const loser = results.find(r => r.keyword === 'underperformer')!
    const winner = results.find(r => r.keyword === 'overperformer')!

    expect(loser.classification).toBe('underperforming')
    expect(winner.classification).toBe('overperforming')

    // Observed CTRs fall outside their respective CIs.
    expect(loser.observedCtr).toBeLessThan(loser.ciLow)
    expect(winner.observedCtr).toBeGreaterThan(winner.ciHigh)

    // Prior was fit from the bucket (should be clamped ≥ 0.5 and non-degenerate).
    expect(loser.priorAlpha).toBeGreaterThanOrEqual(0.5)
    expect(loser.priorBeta).toBeGreaterThanOrEqual(0.5)
    expect(loser.bucket).toBe(6)

    // Shrinkage pulls the underperformer's posterior above observed (positive delta)
    // and the overperformer's posterior below observed (negative delta).
    expect(loser.shrinkageDelta).toBeGreaterThan(0)
    expect(winner.shrinkageDelta).toBeLessThan(0)

    const meta = out.meta as { underperforming: number, overperforming: number }
    expect(meta.underperforming).toBeGreaterThanOrEqual(1)
    expect(meta.overperforming).toBeGreaterThanOrEqual(1)
  }, 30_000)

  it('stl-decompose surfaces weekly seasonality and a late bump in residuals', async () => {
    const env = await setup(dir)

    // 45-day series for (seasonal tide, /cycle): strong weekly pattern
    // (100 + 20*sin(2pi*dow/7)) with a +30 bump during the final week.
    const seeds: Seed[] = []
    const start = new Date('2026-02-15')
    const lastWeekStart = new Date('2026-03-25')
    for (let i = 0; i < 45; i++) {
      const d = new Date(start)
      d.setUTCDate(start.getUTCDate() + i)
      const dateStr = d.toISOString().split('T')[0]
      const dow = d.getUTCDay()
      const isLastWeek = d.getTime() >= lastWeekStart.getTime()
      const impressions = Math.round(100 + 20 * Math.sin((2 * Math.PI * dow) / 7) + (isLastWeek ? 30 : 0))
      seeds.push({
        table: 'page_keywords',
        date: dateStr,
        rows: [
          { url: '/cycle', query: 'seasonal tide', date: dateStr, clicks: 10, impressions, sum_position: 5 * impressions },
        ],
      })
    }
    await seed(env.engine, USER, SITE, seeds)

    const out = await runAnalyzerWithEngine(
      { engine: env.engine },
      { userId: USER, siteId: SITE },
      { type: 'stl-decompose', startDate: '2026-02-15', endDate: '2026-03-31' },
    )

    const rows = out.results as Array<{
      keyword: string
      page: string
      seasonalStrength: number
      trendStrength: number
      residualAnomalies: number
      series: Array<{ date: string, observed: number, trend: number | null, seasonal: number | null, residual: number | null, anomaly: boolean }>
    }>

    const entity = rows.find(r => r.keyword === 'seasonal tide')
    expect(entity).toBeDefined()
    expect(entity!.page).toBe('/cycle')
    expect(entity!.seasonalStrength).toBeGreaterThan(0.3)
    expect(entity!.series.length).toBe(45)
    // The last-week bump should show up: at least one residual anomaly in the
    // final week, not in the first two weeks.
    const anomalies = entity!.series.filter(s => s.anomaly).map(s => s.date)
    expect(anomalies.length).toBeGreaterThan(0)
    expect(anomalies.some(d => d >= '2026-03-25')).toBe(true)
  }, 30_000)

  it('change-point locates a regime shift via Gaussian log-likelihood ratio', async () => {
    const env = await setup(dir)

    // 30-day series for (regime shift, /pivot): position stable ~5 for days
    // 1–15 then jumps to ~10 for days 16–30.
    const seeds: Seed[] = []
    const start = new Date('2026-03-01')
    for (let i = 0; i < 30; i++) {
      const d = new Date(start)
      d.setUTCDate(start.getUTCDate() + i)
      const dateStr = d.toISOString().split('T')[0]
      // Slight deterministic wobble (±0.05) so STDDEV > 0 and LLR is finite.
      const wobble = ((i % 5) - 2) * 0.02
      const pos = i < 15 ? 5 + wobble : 10 + wobble
      const impressions = 200
      // sum_position uses GSC's 0-indexed convention (position = sum/impr + 1).
      const sumPosition = (pos - 1) * impressions
      seeds.push({
        table: 'page_keywords',
        date: dateStr,
        rows: [
          { url: '/pivot', query: 'regime shift', date: dateStr, clicks: 5, impressions, sum_position: sumPosition },
        ],
      })
    }
    await seed(env.engine, USER, SITE, seeds)

    const out = await runAnalyzerWithEngine(
      { engine: env.engine },
      { userId: USER, siteId: SITE },
      { type: 'change-point', startDate: '2026-03-01', endDate: '2026-03-30' },
    )

    const rows = out.results as Array<{
      keyword: string
      page: string
      changeDate: string
      llr: number
      leftMean: number
      rightMean: number
      direction: 'improved' | 'worsened'
      series: Array<{ date: string, value: number }>
    }>

    const entity = rows.find(r => r.keyword === 'regime shift')
    expect(entity).toBeDefined()
    expect(entity!.page).toBe('/pivot')
    expect(entity!.changeDate >= '2026-03-15' && entity!.changeDate <= '2026-03-17').toBe(true)
    expect(entity!.llr).toBeGreaterThan(20)
    // Position went from ~5 to ~10: position-up = worsened ranking.
    expect(entity!.direction).toBe('worsened')
    expect(entity!.leftMean).toBeLessThan(entity!.rightMean)
    expect(entity!.series.length).toBe(30)
  }, 30_000)

  it('survival computes Kaplan-Meier curves for top-10 tenure', async () => {
    const env = await setup(dir)

    // 60-day series for 3 queries on /docs/guide:
    //  - "evergreen"    : position 5 every day -> censored at window end
    //  - "news ride"    : position 8 days 1–14, position 30 from day 15
    //                     -> tenure 14, dies
    //  - "flash in pan" : position 9 days 1–3, position 40 from day 4
    //                     -> tenure 3, dies
    const seeds: Seed[] = []
    const start = new Date('2026-02-01')
    for (let i = 0; i < 60; i++) {
      const d = new Date(start)
      d.setUTCDate(start.getUTCDate() + i)
      const dateStr = d.toISOString().split('T')[0]
      const dayIdx = i + 1 // 1-based day

      const impressions = 100

      const evergreenPos = 5
      const newsRidePos = dayIdx <= 14 ? 8 : 30
      const flashPos = dayIdx <= 3 ? 9 : 40

      seeds.push({
        table: 'page_keywords',
        date: dateStr,
        rows: [
          {
            url: '/docs/guide',
            query: 'evergreen',
            date: dateStr,
            clicks: 5,
            impressions,
            sum_position: (evergreenPos - 1) * impressions,
          },
          {
            url: '/docs/guide',
            query: 'news ride',
            date: dateStr,
            clicks: 3,
            impressions,
            sum_position: (newsRidePos - 1) * impressions,
          },
          {
            url: '/docs/guide',
            query: 'flash in pan',
            date: dateStr,
            clicks: 2,
            impressions,
            sum_position: (flashPos - 1) * impressions,
          },
        ],
      })
    }
    await seed(env.engine, USER, SITE, seeds)

    const out = await runAnalyzerWithEngine(
      { engine: env.engine },
      { userId: USER, siteId: SITE },
      { type: 'survival', startDate: '2026-02-01', endDate: '2026-04-01' },
    )

    const rows = out.results as Array<{
      cohort: string
      episodeCount: number
      censoringRate: number
      medianTenure: number
      curve: Array<{ tenure: number, survival: number, atRisk: number, events: number }>
    }>

    const all = rows.find(r => r.cohort === '__all__')
    expect(all).toBeDefined()
    expect(all!.episodeCount).toBe(3)
    // 1 of 3 is censored (evergreen).
    expect(all!.censoringRate).toBeCloseTo(1 / 3, 2)
    expect(all!.medianTenure).toBeGreaterThanOrEqual(3)

    // Curve must contain entries for the event tenures (3 and 14) plus the
    // censored max tenure (60). At tenure=3, 1 of 3 dies -> S = 2/3.
    const t3 = all!.curve.find(p => p.tenure === 3)
    expect(t3).toBeDefined()
    expect(t3!.atRisk).toBe(3)
    expect(t3!.events).toBe(1)
    expect(t3!.survival).toBeCloseTo(2 / 3, 3)

    // At tenure=14, 1 of 2 remaining dies -> S = (2/3) * (1/2) = 1/3.
    const t14 = all!.curve.find(p => p.tenure === 14)
    expect(t14).toBeDefined()
    expect(t14!.atRisk).toBe(2)
    expect(t14!.events).toBe(1)
    expect(t14!.survival).toBeCloseTo(1 / 3, 3)

    // A per-cohort row should also exist for the docs page-type.
    const docs = rows.find(r => r.cohort === 'docs')
    expect(docs).toBeDefined()
    expect(docs!.episodeCount).toBe(3)

    expect((out.meta as { totalEpisodes: number }).totalEpisodes).toBe(3)
    expect((out.meta as { windowDays: number }).windowDays).toBe(60)
  }, 30_000)

  it('bipartite-pagerank ranks hub URL above leaf URLs and hub query above leaves', async () => {
    const env = await setup(dir)

    // Graph: /hub connects to all 3 queries (q1, q2, q3) with high impressions.
    // /leaf-1..3 each connect to a single query. q-hub connects to multiple
    // URLs (q1 is the multi-URL query); q-leaf-* only touch /hub.
    const rows: Row[] = [
      // /hub anchors all 3 queries
      { url: '/hub', query: 'q1', date: '2026-04-10', clicks: 50, impressions: 2000, sum_position: 10000 },
      { url: '/hub', query: 'q2', date: '2026-04-10', clicks: 40, impressions: 1800, sum_position: 9000 },
      { url: '/hub', query: 'q3', date: '2026-04-10', clicks: 30, impressions: 1600, sum_position: 8000 },
      // Leaf URLs each on just one query. q1 additionally spreads across
      // multiple leaves so it acts as the hub query.
      { url: '/leaf-1a', query: 'q1', date: '2026-04-10', clicks: 5, impressions: 500, sum_position: 3000 },
      { url: '/leaf-1b', query: 'q1', date: '2026-04-10', clicks: 5, impressions: 500, sum_position: 3000 },
      { url: '/leaf-1c', query: 'q1', date: '2026-04-10', clicks: 5, impressions: 500, sum_position: 3000 },
      { url: '/leaf-2', query: 'q2', date: '2026-04-10', clicks: 5, impressions: 500, sum_position: 3000 },
      { url: '/leaf-3', query: 'q3', date: '2026-04-10', clicks: 5, impressions: 500, sum_position: 3000 },
    ]

    await seed(env.engine, USER, SITE, [
      { table: 'page_keywords', date: '2026-04-10', rows },
    ])

    const out = await runAnalyzerWithEngine(
      { engine: env.engine },
      { userId: USER, siteId: SITE },
      { type: 'bipartite-pagerank', startDate: '2026-04-10', endDate: '2026-04-10' },
    )

    const results = out.results as Array<{
      kind: 'query' | 'url'
      id: string
      rank: number
      bridging: number
      anchoring: number
      degree: number
      impressions: number
    }>

    const urls = results.filter(r => r.kind === 'url')
    const queries = results.filter(r => r.kind === 'query')

    // Hub URL must appear and outrank every leaf URL.
    const hub = urls.find(r => r.id === '/hub')
    expect(hub).toBeDefined()
    const leafUrls = urls.filter(r => r.id.startsWith('/leaf'))
    expect(leafUrls.length).toBeGreaterThan(0)
    for (const leaf of leafUrls)
      expect(hub!.rank).toBeGreaterThan(leaf.rank)

    // The hub URL anchors every query that contributes >=5% of its incoming
    // mass; all three queries pass the threshold for /hub in this seed.
    expect(hub!.anchoring).toBeGreaterThanOrEqual(3)
    expect(hub!.degree).toBe(3)

    // Hub query (q1) spans /hub + three leaves; it must outrank q2 and q3
    // and have a larger bridging count than the single-URL queries.
    const q1 = queries.find(r => r.id === 'q1')
    const q2 = queries.find(r => r.id === 'q2')
    const q3 = queries.find(r => r.id === 'q3')
    expect(q1).toBeDefined()
    expect(q2).toBeDefined()
    expect(q3).toBeDefined()
    expect(q1!.bridging).toBeGreaterThan(q2!.bridging)
    expect(q1!.bridging).toBeGreaterThan(q3!.bridging)
    expect(q1!.rank).toBeGreaterThan(q2!.rank)
    expect(q1!.rank).toBeGreaterThan(q3!.rank)

    const meta = out.meta as {
      iterations: number
      damping: number
      convergenceDelta: number
      queryCount: number
      urlCount: number
      deltas: Array<{ step: number, l1: number }>
    }
    expect(meta.iterations).toBe(25)
    expect(meta.damping).toBeCloseTo(0.85, 5)
    expect(meta.queryCount).toBe(3)
    // 1 hub + 3 leaf-1a/b/c + leaf-2 + leaf-3 = 6 urls
    expect(meta.urlCount).toBe(6)
    expect(meta.deltas).toHaveLength(25)
    // Power iteration on a small connected bipartite graph converges
    // rapidly; by step 25 the L1 delta is essentially zero.
    expect(meta.convergenceDelta).toBeLessThan(1e-6)
  }, 60_000)
})

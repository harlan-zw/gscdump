import type { GscdumpIndexingResponse } from '@gscdump/contracts'
import type { IndexingPortfolioSite, IndexingTrendReading } from '../src/indexing'
import { describe, expect, it } from 'vitest'
import {
  getSiteIndexingIssues,
  indexedRateChange,
  indexingWindow,
  indexingWindowNote,
  issueStack,
  notIndexedStack,
  portfolioIndexingTrend,
  portfolioIssueCounts,
  portfolioRateChangeOver,
  readSiteIndexing,
  siteIndexingReading,
  windowReadings,
} from '../src/indexing'

function reading(date: string, totalUrls: number, indexedCount: number, extra: Partial<IndexingTrendReading> = {}): IndexingTrendReading {
  return { date, totalUrls, indexedCount, indexedPercent: totalUrls ? indexedCount / totalUrls * 100 : 0, ...extra }
}

function site(id: string, trend: IndexingTrendReading[]): IndexingPortfolioSite {
  return { id, label: id, trend }
}

const window = { start: '2026-11-03', end: '2026-11-05', current: false } as const

function response(overrides: { indexedPercent: number, trendPercent: number, indexedCount: number | null }): GscdumpIndexingResponse {
  const signals = { mobilePass: 0, mobileFail: 0, richResultsPass: 0, richResultsFail: 2 }
  return {
    summary: {
      totalUrls: 10,
      indexed: 8,
      notIndexed: 2,
      pending: 0,
      indexedPercent: overrides.indexedPercent,
      oldestCheck: null,
      newestCheck: null,
      change7d: 1,
      change28d: null,
      signals: { ...signals, mobileUnspecified: 0, richResultTypes: [], crawlingMobile: 0, crawlingDesktop: 0 },
    },
    trend: [{
      date: '2026-09-01',
      totalUrls: 10,
      indexedCount: overrides.indexedCount,
      notIndexedCount: null,
      errorCount: null,
      indexedPercent: overrides.trendPercent,
      issues: { blockedByRobots: null, noindexDetected: null, soft404: 1, redirect: null, notFound: null, serverError: 3 },
      coverage: { submittedIndexed: null, crawledNotIndexed: 4, discoveredNotCrawled: null },
      signals,
    }],
    meta: {
      siteUrl: 'https://example.com/',
      syncStatus: null,
      indexingStatus: 'complete',
      indexingProgress: 100,
      sitemapTotal: 10,
      inspectedCount: 10,
      noSitemapsSubmitted: false,
      sitemapsPending: false,
    },
  }
}

// Ported from request-indexing `app/utils/fleet-indexing.test.ts`.
describe('readSiteIndexing', () => {
  it('clamps an index rate the read reports above 100%', () => {
    const data = readSiteIndexing(response({ indexedPercent: 1740, trendPercent: -3, indexedCount: 0 }))
    expect(data.summary.indexedPercent).toBe(100)
    expect(data.trend[0]!.indexedPercent).toBe(0)
  })

  it('keeps the issue and coverage counts and drops the nulls', () => {
    const data = readSiteIndexing(response({ indexedPercent: 80, trendPercent: 80, indexedCount: 8 }))
    expect(data.trend[0]).toEqual({
      date: '2026-09-01',
      indexedPercent: 80,
      indexedCount: 8,
      totalUrls: 10,
      issues: { notFound: undefined, soft404: 1, serverError: 3, blockedByRobots: undefined },
      coverage: { crawledNotIndexed: 4, discoveredNotCrawled: undefined },
      signals: { richResultsPass: 0, richResultsFail: 2 },
    })
  })

  // request-indexing read a null count as 0, which reports every URL as not
  // indexed. nuxtseo.com derives it from the rate, and that rule is kept.
  it('derives an unknown indexed count from the rate, never 0', () => {
    const data = readSiteIndexing(response({ indexedPercent: 80, trendPercent: 70, indexedCount: null }))
    expect(data.trend[0]!.indexedCount).toBe(7)
  })
})

// Ported from request-indexing `shared/site-indexing-issues.test.ts`.
describe('getSiteIndexingIssues', () => {
  const everyIssue = {
    issues: { serverError: 1, notFound: 2, soft404: 3, blockedByRobots: 4 },
    coverage: { crawledNotIndexed: 5, discoveredNotCrawled: 6 },
    signals: { richResultsFail: 7 },
  }

  it('lists failures before attention rows, larger counts first', () => {
    expect(getSiteIndexingIssues(everyIssue).map(issue => `${issue.label}:${issue.count}`)).toEqual([
      'Crawled, not indexed:5',
      'Soft 404:3',
      'Not found:2',
      'Server error:1',
      'Rich result errors:7',
      'Discovered, not crawled:6',
      'Blocked by robots.txt:4',
    ])
  })

  it('drops zero counts', () => {
    expect(getSiteIndexingIssues({ issues: { notFound: 0 }, coverage: { crawledNotIndexed: 2 } }).map(issue => issue.id))
      .toEqual(['crawled-not-indexed'])
    expect(getSiteIndexingIssues(null)).toEqual([])
  })
})

describe('windowReadings', () => {
  it('leads with the held reading before the window', () => {
    const trend = [reading('2026-11-01', 10, 5), reading('2026-11-04', 10, 6), reading('2026-11-06', 10, 7)]
    expect(windowReadings(trend, window).map(point => point.date)).toEqual(['2026-11-01', '2026-11-04'])
  })

  it('keeps only the held reading when the window has none', () => {
    const trend = [reading('2026-10-20', 10, 5), reading('2026-11-01', 10, 6)]
    expect(windowReadings(trend, window).map(point => point.date)).toEqual(['2026-11-01'])
  })

  it('skips days with no inspected URLs', () => {
    const trend = [reading('2026-11-02', 10, 5), reading('2026-11-03', 0, 0), reading('2026-11-04', 10, 6)]
    expect(windowReadings(trend, window).map(point => point.date)).toEqual(['2026-11-02', '2026-11-04'])
  })
})

describe('notIndexedStack', () => {
  it('carries a Site across the days it did not report', () => {
    const stack = notIndexedStack([
      site('a', [reading('2026-11-03', 10, 6), reading('2026-11-05', 10, 8)]),
      site('b', [reading('2026-11-04', 20, 10)]),
    ], window)
    expect(stack.buckets.map(bucket => bucket.end)).toEqual(['2026-11-03', '2026-11-04', '2026-11-05'])
    expect(stack.series.find(series => series.key === 'a')!.values).toEqual([4, 4, 2])
    // b joins on the 4th and holds its first reading back to the 3rd, so joining is no rise.
    expect(stack.series.find(series => series.key === 'b')!.values).toEqual([10, 10, 10])
  })

  it('folds the rest into All Others, but names a single extra series', () => {
    const sites = Array.from({ length: 7 }, (_, index) => site(`s${index}`, [reading('2026-11-04', 100, 100 - (index + 1))]))
    expect(notIndexedStack(sites, window).series.map(series => series.key)).toEqual(['s6', 's5', 's4', 's3', 's2', '__other'])
    expect(notIndexedStack(sites.slice(0, 6), window).series.some(series => series.isOther)).toBe(false)
  })

  it('keeps the last day of each bucket, never a sum', () => {
    const trend = Array.from({ length: 4 }, (_, index) => reading(`2026-11-0${index + 1}`, 10, 10 - (index + 1)))
    const stack = notIndexedStack([site('a', trend)], { start: '2026-11-01', end: '2026-11-04' }, { maxBuckets: 2 })
    expect(stack.buckets).toEqual([{ start: '2026-11-01', end: '2026-11-02' }, { start: '2026-11-03', end: '2026-11-04' }])
    expect(stack.series[0]!.values).toEqual([2, 4])
  })
})

describe('issueStack and portfolioIssueCounts', () => {
  const sites = [
    site('a', [
      reading('2026-11-01', 10, 5, { issues: { notFound: 3 } }),
      reading('2026-11-04', 10, 5, { issues: { notFound: 1 }, coverage: { crawledNotIndexed: 2 } }),
      reading('2026-11-09', 10, 5, { issues: { notFound: 9 } }),
    ]),
    site('b', [reading('2026-11-05', 10, 5, { issues: { notFound: 4 } })]),
  ]

  it('sums each issue across Sites per day, holding each Site level', () => {
    const stack = issueStack(sites, window)
    expect(stack.buckets.map(bucket => bucket.end)).toEqual(['2026-11-04', '2026-11-05'])
    expect(stack.series.find(series => series.key === 'not-found')!.values).toEqual([5, 5])
    expect(stack.series.find(series => series.key === 'crawled-not-indexed')!.values).toEqual([2, 2])
  })

  it('counts a past window at its end, never at a later reading', () => {
    const rows = portfolioIssueCounts(sites, window)
    expect(rows.map(row => [row.id, row.count, row.siteCount])).toEqual([['not-found', 5, 2], ['crawled-not-indexed', 2, 1]])
    expect(rows[0]!.sites.map(entry => entry.siteId)).toEqual(['b', 'a'])
  })

  it('counts a current window at each Site latest reading', () => {
    const rows = portfolioIssueCounts(sites, { ...window, current: true })
    expect(rows.map(row => [row.id, row.count])).toEqual([['not-found', 13]])
  })
})

describe('siteIndexingReading', () => {
  const trend = [reading('2026-10-01', 100, 40), reading('2026-10-28', 100, 50), reading('2026-11-04', 100, 60), reading('2026-11-10', 100, 90)]

  it('reads a past window at its end, with changes in points', () => {
    expect(siteIndexingReading(null, trend, window)).toMatchObject({ indexed: 60, indexedPercent: 60, change7d: 10, change28d: 20 })
  })

  it('reads a current window from the summary', () => {
    const summary = { indexed: 95, totalUrls: 100, indexedPercent: 95, change7d: 5 }
    expect(siteIndexingReading(summary, trend, { ...window, current: true })).toMatchObject({ indexed: 95, change7d: 5, change28d: null, point: { date: '2026-11-10' } })
    expect(siteIndexingReading({ ...summary, totalUrls: 0 }, trend, { ...window, current: true })).toBeNull()
  })
})

describe('portfolioIndexingTrend', () => {
  it('weights the rate by inspected URLs and holds each Site level', () => {
    const trend = portfolioIndexingTrend([
      [reading('2026-11-03', 100, 50, { issues: { notFound: 2, soft404: 1, blockedByRobots: 9 } })],
      [reading('2026-11-01', 900, 900), reading('2026-11-04', 900, 0)],
    ], window)
    expect(trend).toEqual([
      { date: '2026-11-03', indexedPercent: 95, indexedCount: 950, errors: 3 },
      { date: '2026-11-04', indexedPercent: 5, indexedCount: 50, errors: 3 },
    ])
    expect(portfolioRateChangeOver(trend, 1)).toBe(-90)
    expect(portfolioRateChangeOver(trend, 7)).toBeNull()
  })

  // request-indexing returns a relative percent with a 1% floor. nuxtseo.com
  // returns points (#1655), and that rule is kept.
  it('reports the rate change in points', () => {
    expect(indexedRateChange([{ indexedPercent: 0.5 }, { indexedPercent: 50 }])).toBe(49.5)
    expect(indexedRateChange([{ indexedPercent: 50 }])).toBeNull()
  })
})

describe('indexingWindow', () => {
  const now = new Date('2026-11-12T12:00:00Z')

  it('ends a current Period today and keeps its length', () => {
    expect(indexingWindow('28d', true, now)).toEqual({ start: '2026-10-16', end: '2026-11-12', current: true, readDays: 28, readFrom: '2026-10-16' })
  })

  it('keeps a past range and caps the read at 90 days', () => {
    const past = indexingWindow('custom:2026-08-01:2026-08-31', true, now)
    expect(past).toEqual({ start: '2026-08-01', end: '2026-08-31', current: false, readDays: 90, readFrom: '2026-08-15' })
    expect(indexingWindowNote(past, [[{ date: '2026-08-16' }]])).toBe('Shows Aug 16, 2026 onward. Indexing data goes back 90 days.')
  })

  it('reads 28 days before a short past window end, for its changes', () => {
    expect(indexingWindow('custom:2026-11-01:2026-11-05', true, now)).toMatchObject({ readDays: 36, readFrom: '2026-10-08' })
    expect(indexingWindowNote(indexingWindow('custom:2026-11-01:2026-11-05', true, now), [])).toBeNull()
  })
})

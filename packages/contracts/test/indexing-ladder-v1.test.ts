import { COVERAGE_STATE_TAGS } from '@gscdump/contracts'
import { createGscdumpV1Protocol } from '@gscdump/contracts/v1'
import { createGscdumpV1Paths } from '@gscdump/contracts/v1/paths'
import { describe, expect, it } from 'vitest'

const meta = { requestId: 'req_ladder', surface: 'partner', version: '1.0' } as const
const counts = Object.fromEntries(COVERAGE_STATE_TAGS.map(tag => [tag, 0]))
const freshness = { _tag: 'measured', verdicts: 1487, olderThan7d: 1484, olderThan30d: 1231, olderThan7dPercent: 99.8, olderThan30dPercent: 82.8 }

function trendPoint(coverageStates: unknown) {
  return {
    date: '2026-09-30',
    totalUrls: 1487,
    indexedCount: 1,
    notIndexedCount: 1486,
    errorCount: 0,
    indexedPercent: 0.1,
    issues: { blockedByRobots: 0, noindexDetected: 0, soft404: 0, redirect: 0, notFound: 0, serverError: 0 },
    coverage: { submittedIndexed: 1, crawledNotIndexed: 0, discoveredNotCrawled: 2 },
    coverageStates,
    signals: { mobilePass: 0, mobileFail: 0, richResultsPass: 0, richResultsFail: 0 },
  }
}

function summaryData(overrides: Record<string, unknown>) {
  const signals = { mobilePass: 0, mobileFail: 0, mobileUnspecified: 0, richResultsPass: 0, richResultsFail: 0, richResultTypes: [], crawlingMobile: 0, crawlingDesktop: 0 }
  return {
    trend: [],
    summary: { totalUrls: 0, indexed: 0, notIndexed: 0, pending: 0, indexedPercent: 0, oldestCheck: null, newestCheck: null, change7d: null, change28d: null, signals },
    meta: { siteUrl: 'sc-domain:example.com', syncStatus: 'synced', indexingStatus: 'complete', indexingProgress: 100, sitemapTotal: 0, inspectedCount: 0, noSitemapsSubmitted: false, sitemapsPending: false },
    ...overrides,
  }
}

describe('indexing coverage states v1', () => {
  const { getSiteIndexing, getSiteIndexingDiagnostics } = createGscdumpV1Protocol().surfaces.partner.operations

  it('serves one count per coverage state with its capture time', () => {
    const point = trendPoint({
      _tag: 'counted',
      capturedAt: '2026-09-30T02:00:00.000Z',
      counts: { ...counts, unknown_to_google: 1484, indexed: 1, discovered_not_indexed: 2 },
      freshness,
    })
    const parsed = getSiteIndexing.responses[200].producer.parse({ data: summaryData({ trend: [point] }), meta })
    expect(parsed.data.trend[0]?.coverageStates).toMatchObject({ _tag: 'counted', counts: { unknown_to_google: 1484 } })
  })

  it('rejects a counted day that leaves a coverage state out', () => {
    const { unknown_to_google: _dropped, ...partial } = counts
    const point = trendPoint({ _tag: 'counted', capturedAt: '2026-09-30T02:00:00.000Z', counts: partial, freshness })
    expect(() => getSiteIndexing.responses[200].producer.parse({ data: summaryData({ trend: [point] }), meta })).toThrow()
  })

  it('marks a day stored before coverage states were counted', () => {
    const parsed = getSiteIndexing.responses[200].producer.parse({ data: summaryData({ trend: [trendPoint({ _tag: 'not_counted' })] }), meta })
    expect(parsed.data.trend[0]?.coverageStates).toEqual({ _tag: 'not_counted' })
  })

  it('dates the summary and the diagnostics with the evidence capture', () => {
    const capture = {
      _tag: 'captured',
      capturedAt: '2026-09-30T02:00:00.000Z',
      source: 'snapshot',
      scope: 'sitemap_urls',
      oldestVerdictAt: '2026-08-20T03:00:00.000Z',
      newestVerdictAt: '2026-09-29T03:00:00.000Z',
      freshness,
    }
    expect(getSiteIndexing.responses[200].producer.parse({ data: summaryData({ capture }), meta }).data.capture).toEqual(capture)
    const diagnostics = { summary: { totalUrls: 0, indexed: 0, indexedPercent: 0 }, issues: [], capture: { _tag: 'empty' }, meta: { siteUrl: 'sc-domain:example.com' } }
    expect(getSiteIndexingDiagnostics.responses[200].producer.parse({ data: diagnostics, meta }).data.capture).toEqual({ _tag: 'empty' })
    expect(() => getSiteIndexingDiagnostics.responses[200].producer.parse({ data: { ...diagnostics, capture: { _tag: 'captured' } }, meta })).toThrow()
  })
})

describe('watched URLs v1', () => {
  const { listSiteWatchedUrls, addSiteWatchedUrls, removeSiteWatchedUrls } = createGscdumpV1Protocol().surfaces.partner.operations

  it('builds the list, add, and remove paths from the route catalog', () => {
    const paths = createGscdumpV1Paths()
    expect(paths.path('partner.sites.indexing.watched.list', { siteId: 's_01' })).toBe('/api/partner/v1/sites/s_01/indexing/watched')
    expect(paths.path('partner.sites.indexing.watched.remove', { siteId: 's_01' })).toBe('/api/partner/v1/sites/s_01/indexing/watched/remove')
    expect([addSiteWatchedUrls.method, removeSiteWatchedUrls.method]).toEqual(['POST', 'POST'])
    expect(listSiteWatchedUrls.auth.scopes).toEqual(['indexing:read'])
    expect(addSiteWatchedUrls.auth.scopes).toEqual(['indexing:write'])
  })

  it('accepts 1 to 50 absolute URLs and nothing else', () => {
    const body = addSiteWatchedUrls.request.body
    const urls = Array.from({ length: 50 }, (_, index) => `https://example.com/${index}`)
    expect(body.parse({ urls }).urls).toHaveLength(50)
    expect(() => body.parse({ urls: [...urls, 'https://example.com/51'] })).toThrow()
    expect(() => body.parse({ urls: [] })).toThrow()
    expect(() => body.parse({ urls: ['/relative'] })).toThrow()
    expect(() => body.parse({ urls: ['https://example.com/'], label: 'panel' })).toThrow()
  })

  it('returns Checkpoints with the parsed tag and Google prose', () => {
    const checkpoint = { checkedAt: '2026-09-30T01:00:00.000Z', coverageState: 'unknown_to_google', googleCoverageState: 'URL is unknown to Google', verdict: 'NEUTRAL', lastCrawlTime: null }
    const data = { watched: [{ url: 'https://example.com/a', addedAt: '2026-09-30T00:00:00.000Z', dueAt: '2026-10-07T01:00:00.000Z', checkpoints: [checkpoint] }], limit: 50, cadenceDays: 7, meta: { siteUrl: 'sc-domain:example.com' } }
    expect(listSiteWatchedUrls.responses[200].producer.parse({ data, meta }).data.watched[0]?.checkpoints).toEqual([checkpoint])
    const unknownTag = { ...data, watched: [{ ...data.watched[0], checkpoints: [{ ...checkpoint, coverageState: 'URL is unknown to Google' }] }] }
    expect(() => listSiteWatchedUrls.responses[200].producer.parse({ data: unknownTag, meta })).toThrow()
  })
})

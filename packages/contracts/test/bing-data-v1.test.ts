import { createGscdumpV1Protocol } from '@gscdump/contracts/v1'
import { describe, expect, it } from 'vitest'

const request = { dataset: 'traffic', startDate: '2026-08-01', endDate: '2026-08-31', limit: 25, offset: 0 }
const meta = { requestId: 'req_bing', surface: 'partner', version: '1.0' }
const data = {
  searchEngine: 'bing',
  siteUrl: 'https://nuxtseo.com/',
  dataset: 'traffic',
  semantics: 'site-totals',
  sync: { _tag: 'ready', observedAt: '2026-09-01T08:00:00.000Z', providerStartDate: '2026-08-01', providerEndDate: '2026-08-31' },
  rows: [{ date: '2026-08-01', clicks: 2, impressions: 10 }],
  pagination: { total: 1, limit: 25, offset: 0, hasMore: false },
}

describe('bing public datasets', () => {
  it('parses bounded provider-date reads', () => {
    const operation = createGscdumpV1Protocol().surfaces.partner.operations.getSiteBingData
    expect(operation.request.query.parse(request)).toEqual(request)
    expect(operation.responses[200].producer.parse({ data, meta }).data).toEqual(data)
  })
  it.each([
    { endDate: '2026-07-31' },
    { startDate: '2020-01-01' },
    { limit: 501 },
    { offset: -1 },
    { dataset: 'chat' },
    { startDate: '2026-02-30' },
  ])('rejects invalid query bounds %j', (override) => {
    const operation = createGscdumpV1Protocol().surfaces.partner.operations.getSiteBingData
    expect(operation.request.query.safeParse({ ...request, ...override }).success).toBe(false)
  })
  it('rejects ranked rows presented as Site totals', () => {
    const response = createGscdumpV1Protocol().surfaces.partner.operations.getSiteBingData.responses[200]
    expect(response.producer.safeParse({ data: { ...data, dataset: 'pages' }, meta }).success).toBe(false)
  })
  it('preserves unavailable state and prior successful rows', () => {
    const response = createGscdumpV1Protocol().surfaces.partner.operations.getSiteBingData.responses[200]
    const sync = { _tag: 'unavailable', observedAt: data.sync.observedAt, providerStartDate: '2026-08-01', providerEndDate: '2026-08-31', lastAttemptAt: '2026-09-02T08:00:00.000Z', reason: 'throttled' }
    expect(response.producer.parse({ data: { ...data, sync }, meta }).data).toMatchObject({ sync, rows: data.rows })
  })
})

describe('bing keyword and Page totals', () => {
  const totalsRequest = { dataset: 'keywords', startDate: '2026-08-01', endDate: '2026-08-31', limit: 3, offset: 0 }
  const totals = {
    searchEngine: 'bing',
    siteUrl: 'https://nuxtseo.com/',
    dataset: 'keywords',
    semantics: 'ranked-keyword-totals',
    sync: data.sync,
    totals: { clicks: 9, impressions: 140 },
    rows: [{ keyword: 'nuxt seo', clicks: 7, impressions: 90, averageClickPosition: 2.5, averageImpressionPosition: null }],
    pagination: { total: 12, limit: 3, offset: 0, hasMore: true },
  }

  it('parses a ranked read with window totals and the distinct count', () => {
    const operation = createGscdumpV1Protocol().surfaces.partner.operations.getSiteBingDataTotals
    expect(operation.request.query.parse(totalsRequest)).toEqual(totalsRequest)
    expect(operation.responses[200].producer.parse({ data: totals, meta }).data).toEqual(totals)
  })
  it.each([
    { dataset: 'traffic' },
    { dataset: 'crawl' },
    { endDate: '2026-07-31' },
    { startDate: '2025-08-01' },
    { limit: 0 },
    { limit: 501 },
  ])('rejects invalid totals query %j', (override) => {
    const operation = createGscdumpV1Protocol().surfaces.partner.operations.getSiteBingDataTotals
    expect(operation.request.query.safeParse({ ...totalsRequest, ...override }).success).toBe(false)
  })
  it('rejects dated rows and missing window totals', () => {
    const response = createGscdumpV1Protocol().surfaces.partner.operations.getSiteBingDataTotals.responses[200]
    const { totals: _totals, ...withoutTotals } = totals
    expect(response.producer.safeParse({ data: withoutTotals, meta }).success).toBe(false)
    expect(response.producer.safeParse({ data: { ...totals, rows: [{ ...totals.rows[0], date: '2026-08-01' }] }, meta }).success).toBe(false)
    expect(response.producer.safeParse({ data: { ...totals, semantics: 'ranked-keywords' }, meta }).success).toBe(false)
  })
  it('requires Page rows to name a URL', () => {
    const response = createGscdumpV1Protocol().surfaces.partner.operations.getSiteBingDataTotals.responses[200]
    const pages = { ...totals, dataset: 'pages', semantics: 'ranked-page-totals', rows: [{ page: 'https://nuxtseo.com/docs', clicks: 1, impressions: 2, averageClickPosition: null, averageImpressionPosition: 3 }] }
    expect(response.producer.parse({ data: pages, meta }).data).toEqual(pages)
    expect(response.producer.safeParse({ data: { ...pages, rows: [{ ...pages.rows[0], page: 'docs' }] }, meta }).success).toBe(false)
  })
})

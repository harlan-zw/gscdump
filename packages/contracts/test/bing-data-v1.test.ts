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

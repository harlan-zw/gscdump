import { createGscdumpV1Protocol, sitemapInspectQueryV1Schema } from '@gscdump/contracts/v1'
import { describe, expect, it } from 'vitest'

const response = createGscdumpV1Protocol().surfaces.partner.operations.inspectSiteSitemap.responses[200]
const capture = { _tag: 'captured', source: 'live', capturedAt: '2026-10-08T02:00:00.000Z' }
const meta = { requestId: 'req_sitemap', surface: 'partner', version: '1.0' }
const listed = { _tag: 'listed', lastSubmitted: null, lastDownloaded: null, isPending: true, errors: 0, warnings: 0, urlCount: null }

function envelope(state: unknown, observed: unknown = capture, searchEngine = 'google') {
  return { data: { searchEngine, sitemapUrl: 'https://example.com/sitemap-old.xml', capture: observed, state }, meta }
}

describe('exact Sitemap evidence', () => {
  it('keeps absent provider dates separate from missing Sitemap evidence', () => {
    expect(response.producer.parse(envelope(listed)).data.state).toEqual(listed)
    expect(response.client.parse(envelope({ _tag: 'missing' })).data.state).toEqual({ _tag: 'missing' })
  })

  it('keeps provider RFC3339 dates with timezone offsets', () => {
    const state = { ...listed, lastSubmitted: '2026-10-01T00:00:00+00:00' }
    expect(response.producer.parse(envelope(state)).data.state).toEqual(state)
  })

  it('requires a successful dated Capture before claiming absence', () => {
    expect(response.producer.safeParse(envelope({ _tag: 'missing' }, { _tag: 'unavailable' })).success).toBe(false)
    const unavailable = { _tag: 'unavailable', reason: 'provider-unavailable', retryable: true }
    expect(response.producer.parse(envelope(unavailable, { _tag: 'unavailable' })).data.state).toEqual(unavailable)
    expect(response.producer.safeParse(envelope(unavailable)).success).toBe(false)
  })

  it('preserves Bing Capture time and provider fields', () => {
    const stored = { ...capture, source: 'stored' }
    const state = { _tag: 'listed', status: 'Success', submittedAt: null, lastCrawledAt: '2026-10-07T00:00:00.000Z', urlCount: 5 }
    expect(response.client.parse(envelope(state, stored, 'bing')).data).toEqual(envelope(state, stored, 'bing').data)
    expect(response.producer.safeParse(envelope(listed, stored, 'bing')).success).toBe(false)
  })

  it('rejects unsupported engines and non-HTTP URLs at the boundary', () => {
    expect(sitemapInspectQueryV1Schema.safeParse({ searchEngine: 'google', url: 'ftp://example.com/a' }).success).toBe(false)
    expect(sitemapInspectQueryV1Schema.safeParse({ searchEngine: 'other', url: 'https://example.com/a' }).success).toBe(false)
    expect(sitemapInspectQueryV1Schema.safeParse({ searchEngine: 'google', url: 'https://user:pass@example.com/a' }).success).toBe(false)
    expect(sitemapInspectQueryV1Schema.safeParse({ searchEngine: 'google', url: 'https://example.com/a#part' }).success).toBe(false)
  })
})

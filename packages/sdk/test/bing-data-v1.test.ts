import { createGscdumpV1Client } from '@gscdump/sdk/v1'
import { describe, expect, it, vi } from 'vitest'

describe('bing public dataset client', () => {
  it('reads ranked Pages through the Site boundary and preserves future fields', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async (url, init) => {
      const requested = new URL(String(url), 'https://example.com')
      expect(requested.pathname).toBe('/api/_gscdump/partner/v1/sites/s_site/bing/data')
      expect(Object.fromEntries(requested.searchParams)).toEqual({ dataset: 'pages', startDate: '2026-08-01', endDate: '2026-08-31', limit: '25', offset: '25' })
      expect(init?.method).toBe('GET')
      return Response.json({ data: {
        searchEngine: 'bing',
        siteUrl: 'https://nuxtseo.com/',
        dataset: 'pages',
        semantics: 'ranked-pages',
        sync: { _tag: 'ready', observedAt: '2026-09-01T08:00:00.000Z', providerStartDate: '2026-08-01', providerEndDate: '2026-08-31', futureSync: true },
        rows: [{ date: '2026-08-21', page: 'https://nuxtseo.com/', clicks: 3, impressions: 20, averageClickPosition: null, averageImpressionPosition: 4, futureRow: true }],
        pagination: { total: 26, limit: 25, offset: 25, hasMore: false },
      }, meta: { requestId: 'req_bing', surface: 'partner', version: '1.0' } })
    })
    const client = createGscdumpV1Client({ apiRoot: '/api/_gscdump', credential: 'user_secret', fetch })
    const result = await client.getSiteBingData({ params: { siteId: 's_site' }, query: { dataset: 'pages', startDate: '2026-08-01', endDate: '2026-08-31', limit: 25, offset: 25 } })
    expect(result.data).toMatchObject({ dataset: 'pages', semantics: 'ranked-pages', sync: { futureSync: true }, rows: [{ averageClickPosition: null, futureRow: true }] })
    expect(fetch).toHaveBeenCalledTimes(1)
  })
})

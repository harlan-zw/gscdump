import { createGscdumpV1Client } from '@gscdump/sdk/v1'
import { describe, expect, it, vi } from 'vitest'

describe('bing indexing evidence v1 client', () => {
  it('lists Bing evidence through the registered Site path', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async (request, init) => {
      expect(request).toBe('/api/_gscdump/partner/v1/sites/s_site/indexing/bing/evidence?limit=50&offset=0')
      expect(init?.method).toBe('GET')
      return new Response(JSON.stringify({
        data: {
          searchEngine: 'bing',
          siteUrl: 'https://nuxtseo.com/',
          indexingEvidence: [{
            _tag: 'unknown',
            searchEngine: 'bing',
            url: 'https://nuxtseo.com/new',
            observedAt: '2026-08-11T13:35:27.000Z',
            reason: 'not-observed',
          }],
          pagination: { total: 1, limit: 50, offset: 0, hasMore: false },
          futureField: true,
        },
        meta: { requestId: 'req_bing', surface: 'partner', version: '1.0' },
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    })
    const client = createGscdumpV1Client({
      apiRoot: '/api/_gscdump',
      credential: 'user_secret',
      fetch,
    })

    const result = await client.listSiteBingIndexingEvidence({
      params: { siteId: 's_site' },
      query: { limit: 50, offset: 0 },
    })

    expect(result.data.indexingEvidence).toEqual([{
      _tag: 'unknown',
      searchEngine: 'bing',
      url: 'https://nuxtseo.com/new',
      observedAt: '2026-08-11T13:35:27.000Z',
      reason: 'not-observed',
    }])
    expect(fetch).toHaveBeenCalledTimes(1)
  })
})

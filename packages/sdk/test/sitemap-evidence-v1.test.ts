import { createGscdumpV1Client } from '@gscdump/sdk/v1'
import { expect, it, vi } from 'vitest'

it('inspects an exact Sitemap without losing query or path identity', async () => {
  const sitemapUrl = 'https://example.com/Old.xml?part=1&kind=a'
  const data = {
    searchEngine: 'bing',
    sitemapUrl,
    capture: { _tag: 'captured', source: 'stored', capturedAt: '2026-10-07T02:00:00.000Z' },
    state: { _tag: 'missing' },
  }
  const fetch = vi.fn<typeof globalThis.fetch>(async (request, init) => {
    const url = new URL(String(request), 'https://host.test')
    expect(url.pathname).toBe('/api/partner/v1/sites/s_01/sitemaps/inspect')
    expect(url.searchParams.get('url')).toBe(sitemapUrl)
    expect(url.searchParams.get('searchEngine')).toBe('bing')
    expect(init?.method).toBe('GET')
    expect(init?.body).toBeUndefined()
    return new Response(JSON.stringify({ data, meta: { requestId: 'req_01', surface: 'partner', version: '1.0' } }), { headers: { 'content-type': 'application/json' } })
  })
  const client = createGscdumpV1Client({ apiRoot: '/api', credential: 'test-key', fetch })
  expect((await client.inspectSiteSitemap({ params: { siteId: 's_01' }, query: { searchEngine: 'bing', url: sitemapUrl } })).data).toEqual(data)
})

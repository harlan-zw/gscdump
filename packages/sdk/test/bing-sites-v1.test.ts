import { createGscdumpV1Client } from '@gscdump/sdk/v1'
import { describe, expect, it, vi } from 'vitest'

function response(data: unknown): Response {
  return new Response(JSON.stringify({
    data,
    meta: { requestId: 'req_bing_sites', surface: 'partner', version: '1.0' },
  }), { headers: { 'content-type': 'application/json' } })
}

function clientWith(fetch: typeof globalThis.fetch) {
  return createGscdumpV1Client({ apiRoot: '/api/_gscdump', credential: 'secret', fetch })
}

const linkable = { siteId: 's_1', siteUrl: 'https://example.com/', teamId: null, callerCanAct: true, state: { _tag: 'linkable', reason: 'not-linked' } }

describe('host-owned Bing and Sitemap client', () => {
  it('reads one Team of the Bing fleet', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async (request, init) => {
      expect(request).toBe('/api/_gscdump/partner/v1/users/u_1/indexing/bing/sites?teamId=t_1')
      expect(init?.method).toBe('GET')
      return response({ searchEngine: 'bing', grant: { _tag: 'missing' }, sites: [linkable] })
    })
    const result = await clientWith(fetch).listUserBingSites({ params: { userId: 'u_1' }, query: { teamId: 't_1' } })
    expect(result.data.sites).toEqual([linkable])
  })

  it('links a Site with no body and returns its new state', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async (request, init) => {
      expect(request).toBe('/api/_gscdump/partner/v1/sites/s_1/indexing/bing/link')
      expect(init?.method).toBe('POST')
      expect(init?.body).toBeUndefined()
      return response({ _tag: 'linked', site: { ...linkable, state: { _tag: 'verification-required', remoteSiteUrl: 'https://example.com/', verification: { _tag: 'cname', name: 'abc123', value: 'verify.bing.com' } } } })
    })
    const result = await clientWith(fetch).linkSiteBing({ params: { siteId: 's_1' } })
    expect(result.data).toMatchObject({ _tag: 'linked', site: { state: { _tag: 'verification-required' } } })
  })

  it('refuses an oversized return URL before transport', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>()
    await expect(clientWith(fetch).createSiteBingAuthorization({
      params: { siteId: 's_1' },
      body: { returnUrl: `https://requestindexing.com/${'a'.repeat(2_048)}` },
    })).rejects.toMatchObject({ code: 'request_validation' })
    expect(fetch).not.toHaveBeenCalled()
  })

  it('submits a Bing Sitemap the host discovers', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async (request, init) => {
      expect(request).toBe('/api/_gscdump/partner/v1/sites/s_1/indexing/bing/sitemaps')
      expect(init?.body).toBe('{}')
      return response({ _tag: 'failed', reason: 'no-sitemap-found', retryable: false })
    })
    const result = await clientWith(fetch).submitSiteBingSitemap({ params: { siteId: 's_1' }, body: {} })
    expect(result.data).toEqual({ _tag: 'failed', reason: 'no-sitemap-found', retryable: false })
  })

  it('reads and runs the Google Sitemap submission without naming a URL', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async (request, init) => {
      expect(request).toBe('/api/_gscdump/partner/v1/sites/s_1/sitemaps/submission')
      if (init?.method === 'GET')
        return response({ searchEngine: 'google', gscPropertyUrl: 'sc-domain:example.com', callerCanAct: true, state: { _tag: 'ready', sitemapUrl: 'https://example.com/sitemap.xml', writeAccess: 'granted' } })
      expect(init?.body).toBeUndefined()
      return response({ _tag: 'submitted', sitemapUrl: 'https://example.com/sitemap.xml', sitemapCount: 1 })
    })
    const client = clientWith(fetch)
    const read = await client.getSiteSitemapSubmission({ params: { siteId: 's_1' } })
    expect(read.data.state._tag).toBe('ready')
    const submitted = await client.submitSiteSitemap({ params: { siteId: 's_1' } })
    expect(submitted.data).toEqual({ _tag: 'submitted', sitemapUrl: 'https://example.com/sitemap.xml', sitemapCount: 1 })
  })
})

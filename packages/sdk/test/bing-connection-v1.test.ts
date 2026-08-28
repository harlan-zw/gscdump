import { createGscdumpV1Client } from '@gscdump/sdk/v1'
import { describe, expect, it, vi } from 'vitest'

function response(data: unknown): Response {
  return new Response(JSON.stringify({
    data,
    meta: { requestId: 'req_bing_connection', surface: 'partner', version: '1.0' },
  }), { headers: { 'content-type': 'application/json' } })
}

describe('bing connection v1 client', () => {
  it('gets the hosted Bing connection', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async (request, init) => {
      expect(request).toBe('/api/_gscdump/partner/v1/sites/s_site/indexing/bing/connection')
      expect(init?.method).toBe('GET')
      return response({
        _tag: 'verification-required',
        searchEngine: 'bing',
        remoteSiteUrl: 'https://nuxtseo.com/',
        verified: false,
        verification: { _tag: 'cname', name: 'abc123', value: 'verify.bing.com' },
      })
    })
    const client = createGscdumpV1Client({ apiRoot: '/api/_gscdump', credential: 'secret', fetch })

    await expect(client.getSiteBingConnection({ params: { siteId: 's_site' } })).resolves.toMatchObject({
      data: {
        _tag: 'verification-required',
        verification: { name: 'abc123', value: 'verify.bing.com' },
      },
    })
  })

  it('checks verification without a request body', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async (request, init) => {
      expect(request).toBe('/api/_gscdump/partner/v1/sites/s_site/indexing/bing/connection/verify')
      expect(init?.method).toBe('POST')
      expect(init?.body).toBeUndefined()
      return response({
        _tag: 'connected',
        searchEngine: 'bing',
        remoteSiteUrl: 'https://nuxtseo.com/',
        verified: true,
        scopes: ['webmaster.read'],
        tokenExpiresAt: null,
        lastEvidenceAt: null,
      })
    })
    const client = createGscdumpV1Client({ apiRoot: '/api/_gscdump', credential: 'secret', fetch })

    await expect(client.verifySiteBingConnection({ params: { siteId: 's_site' } })).resolves.toMatchObject({
      data: { _tag: 'connected', verified: true },
    })
  })
})

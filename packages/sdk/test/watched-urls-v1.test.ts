import { createGscdumpV1Client } from '@gscdump/sdk/v1'
import { describe, expect, it, vi } from 'vitest'

const meta = { requestId: 'req_watched', surface: 'partner', version: '1.0' }

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

describe('watched URLs v1 client', () => {
  it('adds URLs and reads back the skipped ones', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async (request, init) => {
      expect(request).toBe('/api/_gscdump/partner/v1/sites/s_01/indexing/watched')
      expect(init?.method).toBe('POST')
      expect(JSON.parse(String(init?.body))).toEqual({ urls: ['https://example.com/a', 'https://other.com/b'] })
      return json({
        data: { changed: ['https://example.com/a'], unchanged: [], skipped: [{ url: 'https://other.com/b', reason: 'domain_mismatch' }], total: 1, limit: 50 },
        meta,
      })
    })
    const client = createGscdumpV1Client({ apiRoot: '/api/_gscdump', credential: 'secret', fetch })

    const { data } = await client.addSiteWatchedUrls({ params: { siteId: 's_01' }, body: { urls: ['https://example.com/a', 'https://other.com/b'] } })
    expect(data.skipped).toEqual([{ url: 'https://other.com/b', reason: 'domain_mismatch' }])
  })

  it('removes URLs through the remove route', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async (request, init) => {
      expect(request).toBe('/api/_gscdump/partner/v1/sites/s_01/indexing/watched/remove')
      expect(init?.method).toBe('POST')
      return json({ data: { changed: [], unchanged: ['https://example.com/a'], skipped: [], total: 0, limit: 50 }, meta })
    })
    const client = createGscdumpV1Client({ apiRoot: '/api/_gscdump', credential: 'secret', fetch })

    const { data } = await client.removeSiteWatchedUrls({ params: { siteId: 's_01' }, body: { urls: ['https://example.com/a'] } })
    expect(data.unchanged).toEqual(['https://example.com/a'])
  })

  it('lists Watched URLs with their Checkpoints', async () => {
    const checkpoint = { checkedAt: '2026-09-30T01:00:00.000Z', coverageState: 'discovered_not_indexed', googleCoverageState: 'Discovered - currently not indexed', verdict: 'NEUTRAL', lastCrawlTime: null }
    const fetch = vi.fn<typeof globalThis.fetch>(async () => json({
      data: { watched: [{ url: 'https://example.com/a', addedAt: '2026-09-23T00:00:00.000Z', dueAt: '2026-10-07T01:00:00.000Z', checkpoints: [checkpoint] }], limit: 50, cadenceDays: 7, meta: { siteUrl: 'sc-domain:example.com' } },
      meta,
    }))
    const client = createGscdumpV1Client({ apiRoot: '/api/_gscdump', credential: 'secret', fetch })

    const { data } = await client.listSiteWatchedUrls({ params: { siteId: 's_01' } })
    expect(data.watched[0]?.checkpoints[0]?.coverageState).toBe('discovered_not_indexed')
  })
})

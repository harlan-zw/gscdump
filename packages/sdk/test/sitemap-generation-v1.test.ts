import { describe, expect, it, vi } from 'vitest'
import { createGscdumpV1Client } from '../src/v1'

function response(data: unknown): Response {
  return new Response(JSON.stringify({
    data,
    meta: { requestId: 'req_1', surface: 'partner', version: '1.0' },
  }), { headers: { 'content-type': 'application/json' } })
}

const generation = {
  id: 'site-1',
  observedAt: 100,
  publishedAt: 101,
  completeness: { _tag: 'complete' },
  membershipHistoryAvailableFrom: 100,
  legacyImport: { _tag: 'none' },
}

describe('sitemap generation SDK', () => {
  it('executes pinned list, membership, and export operations', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async (request, init) => {
      if (String(request).includes('/membership')) {
        expect(init?.method).toBe('POST')
        expect(JSON.parse(String(init?.body))).toEqual({
          urls: ['https://example.com/a'],
          generationId: 'site-1',
        })
        return response({
          generation,
          evidence: [{ _tag: 'absent', url: 'https://example.com/a', observedAt: 100 }],
          meta: { requested: 1, checked: 1, matched: 0 },
        })
      }
      if (String(request).includes('/export')) {
        return response({
          generation,
          export: { _tag: 'unavailable', reason: 'export_unavailable' },
        })
      }
      return response({
        generation,
        items: [],
        page: { nextCursor: null, limit: 500 },
      })
    })
    const client = createGscdumpV1Client({
      apiRoot: '/api/_gscdump',
      credential: 'secret',
      fetch,
    })

    await expect(client.listSitemapUrls({
      params: { siteId: 's_1' },
      query: { generationId: 'site-1', limit: 500 },
    })).resolves.toMatchObject({ data: { generation: { id: 'site-1' }, items: [] } })
    await expect(client.querySitemapMembership({
      params: { siteId: 's_1' },
      body: { urls: ['https://example.com/a'], generationId: 'site-1' },
    })).resolves.toMatchObject({ data: { evidence: [{ _tag: 'absent' }] } })
    await expect(client.getSitemapExport({
      params: { siteId: 's_1' },
      query: { generationId: 'site-1' },
    })).resolves.toMatchObject({ data: { export: { _tag: 'unavailable' } } })
  })
})

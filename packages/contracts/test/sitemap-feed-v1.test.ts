import { createGscdumpV1Protocol } from '@gscdump/contracts/v1'
import { describe, expect, it } from 'vitest'

const { producer, client } = createGscdumpV1Protocol().surfaces.partner.operations.getSiteSitemaps.responses[200]

function sitemapsResponse(sitemap: Record<string, unknown>): unknown {
  return {
    data: {
      sitemaps: [{ path: 'https://example.com/old-sitemap.xml', urlCount: 0, errors: 1, warnings: 0, ...sitemap }],
      history: [],
      perSitemapHistory: {},
      generation: null,
      meta: { siteUrl: 'sc-domain:example.com', syncStatus: 'synced', sitemapScope: { excludedCount: 0, duplicateCount: 0 } },
    },
    meta: { requestId: 'req_01', surface: 'partner', version: '1.0' },
  }
}

describe('sitemap feed on partner.sites.sitemaps.get', () => {
  it.each([
    { _tag: 'counted' },
    { _tag: 'dropped', status: 404, since: 1_759_276_800_000 },
    { _tag: 'dropped', status: 410, since: 0 },
  ])('lets the host send feed $_tag', (feed) => {
    const parsed = producer.parse(sitemapsResponse({ feed }))
    expect(parsed.data.sitemaps[0]?.feed).toEqual(feed)
  })

  it('reads a Sitemap from a host that sends no feed', () => {
    const parsed = client.parse(sitemapsResponse({}))
    expect(parsed.data.sitemaps[0]?.feed).toBeUndefined()
  })

  it.each([
    ['a dropped Sitemap with a status other than 404 or 410', { _tag: 'dropped', status: 403, since: 1_759_276_800_000 }],
    ['a dropped Sitemap without the start of its run', { _tag: 'dropped', status: 404 }],
    ['a dropped Sitemap whose run starts at a fractional time', { _tag: 'dropped', status: 404, since: 1.5 }],
    ['a counted Sitemap that carries a status', { _tag: 'counted', status: 404 }],
    ['a feed tag the contract does not name', { _tag: 'retired' }],
  ])('refuses %s', (_label, feed) => {
    expect(producer.safeParse(sitemapsResponse({ feed })).success).toBe(false)
  })
})

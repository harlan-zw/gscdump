import { describe, expect, it } from 'vitest'
import {
  gscdumpSitemapExportResponseSchema,
  gscdumpSitemapMembershipResponseSchema,
  gscdumpSitemapUrlsResponseSchema,
} from '../src'
import { analyticsEndpoints } from '../src/analytics'
import { partnerEndpoints } from '../src/partner'
import { createGscdumpV1Protocol } from '../src/v1'

const generation = {
  id: 'site-01JZ',
  observedAt: 1_753_746_000_000,
  publishedAt: 1_753_746_000_100,
  completeness: { _tag: 'complete' },
  membershipHistoryAvailableFrom: 1_753_746_000_000,
  legacyImport: {
    _tag: 'metadata_only',
    importedAt: 1_753_745_000_000,
    recordCount: 2,
    source: 'gsc_sitemaps',
  },
} as const

describe('hosted sitemap generation v1', () => {
  it('uses present, absent and unknown membership evidence without a legacy boolean', () => {
    const parsed = gscdumpSitemapMembershipResponseSchema.parse({
      generation,
      evidence: [
        {
          _tag: 'present',
          url: 'https://example.com/a',
          feedpath: 'https://cdn.example.com/Sitemap.xml',
          lastmod: '2026-07-29',
          firstSeenAt: 100,
          lastSeenAt: 200,
        },
        { _tag: 'absent', url: 'https://example.com/b', observedAt: 200 },
        { _tag: 'unknown', url: 'not a URL', reason: 'invalid_url' },
      ],
      meta: { requested: 3, checked: 2, matched: 1 },
    })
    expect(parsed.evidence.map(item => item._tag)).toEqual(['present', 'absent', 'unknown'])
    expect(gscdumpSitemapMembershipResponseSchema.safeParse({
      generation,
      evidence: [{ url: 'https://example.com/a', inSitemap: true }],
      meta: { requested: 1, checked: 1, matched: 1 },
    }).success).toBe(false)
  })

  it('pins cursor listing and export descriptors to a generation', () => {
    expect(gscdumpSitemapUrlsResponseSchema.parse({
      generation,
      items: [{
        url: 'https://example.com/A?x=1',
        feedpath: 'https://cdn.example.com/Sitemap.xml',
        lastmod: null,
        firstSeenAt: 100,
        lastSeenAt: 200,
      }],
      page: { nextCursor: 'opaque', limit: 500 },
    })).toMatchObject({ generation: { id: 'site-01JZ' } })

    expect(gscdumpSitemapExportResponseSchema.parse({
      generation,
      export: {
        _tag: 'url',
        url: 'https://download.example.com/export.ndjson.gz',
        expiresAt: 1_753_746_300_000,
        contentType: 'application/x-ndjson',
        contentEncoding: 'gzip',
      },
    })).toMatchObject({ export: { _tag: 'url' } })
  })

  it('registers executable listing and export operations', () => {
    const protocol = createGscdumpV1Protocol()
    expect(protocol.surfaces.partner.operations.listSitemapUrls.path)
      .toBe('/sites/{siteId}/sitemaps/urls')
    expect(protocol.surfaces.partner.operations.getSitemapExport.path)
      .toBe('/sites/{siteId}/sitemaps/export')
  })

  it('exposes sitemap transport only through public v1', () => {
    expect(Object.keys(partnerEndpoints).filter(key => key.toLowerCase().includes('sitemap'))).toEqual([])
    expect(Object.keys(analyticsEndpoints).filter(key => key.toLowerCase().includes('sitemap'))).toEqual([])
  })
})

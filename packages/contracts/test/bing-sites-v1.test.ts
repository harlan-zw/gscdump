import { createGscdumpV1Protocol } from '@gscdump/contracts/v1'
import { describe, expect, it } from 'vitest'

const meta = { requestId: 'req_bing_sites', surface: 'partner' as const, version: '1.0' as const }
const protocol = createGscdumpV1Protocol()
const operations = protocol.surfaces.partner.operations

const collecting = {
  siteId: 's_1',
  siteUrl: 'https://example.com/',
  teamId: 't_1',
  callerCanAct: true,
  state: {
    _tag: 'collecting',
    remoteSiteUrl: 'https://example.com/',
    lastEvidenceAt: null,
    sitemap: { _tag: 'awaiting-bing', checkedAt: '2026-09-30T00:00:00.000Z', lastSubmittedAt: '2026-09-30T00:00:00.000Z' },
  },
}

function fleet(sites: unknown[]) {
  return { data: { searchEngine: 'bing', grant: { _tag: 'authorized', scopes: ['webmaster.manage'] }, sites }, meta }
}

describe('bing fleet v1', () => {
  it('publishes one tagged state per Site and a Sitemap view only while collecting', () => {
    const response = operations.listUserBingSites.responses[200].producer
    const linkable = { ...collecting, siteId: 's_2', state: { _tag: 'linkable', reason: 'permission-lost' } }
    expect(response.parse(fleet([collecting, linkable]))).toEqual(fleet([collecting, linkable]))
    expect(response.safeParse(fleet([{ ...linkable, state: { ...linkable.state, sitemap: { _tag: 'unknown' } } }])).success).toBe(false)
  })

  it('refuses a Sitemap view that invites a second submit or hides the wait', () => {
    const response = operations.listUserBingSites.responses[200].producer
    const withSitemap = (sitemap: unknown) => fleet([{ ...collecting, state: { ...collecting.state, sitemap } }])
    expect(response.safeParse(withSitemap({ _tag: 'awaiting-bing', checkedAt: null, lastSubmittedAt: null })).success).toBe(false)
    expect(response.safeParse(withSitemap({ _tag: 'submitted', checkedAt: '2026-09-30T00:00:00.000Z', sitemapCount: 0, urlCount: null, lastCrawledAt: null, sitemaps: [] })).success).toBe(false)
  })

  it('lets an older client read a Site with fields added later', () => {
    const client = operations.listUserBingSites.responses[200].client
    const later = fleet([{ ...collecting, addedLater: true }])
    expect(client.parse(later).data.sites[0]).toMatchObject({ siteId: 's_1', addedLater: true })
  })

  it('rejects a team filter that is not a public Team id', () => {
    const query = operations.listUserBingSites.request.query
    expect(query.safeParse({ teamId: 't_1' }).success).toBe(true)
    expect(query.safeParse({ teamId: '12' }).success).toBe(false)
  })
})

describe('bing link, authorization, and Sitemap submit v1', () => {
  it('returns the linked Site state, or the grant step the owner owes', () => {
    const response = operations.linkSiteBing.responses[200].producer
    expect(response.parse({ data: { _tag: 'linked', site: collecting }, meta }).data).toEqual({ _tag: 'linked', site: collecting })
    expect(response.parse({ data: { _tag: 'grant-required', reason: 'grant-missing' }, meta }).data._tag).toBe('grant-required')
    expect(response.safeParse({ data: { _tag: 'linked' }, meta }).success).toBe(false)
  })

  it('bounds the return URL and answers with an authorize URL', () => {
    const operation = operations.createSiteBingAuthorization
    expect(operation.request.body.safeParse({ returnUrl: `https://nuxtseo.com/${'a'.repeat(2_048)}` }).success).toBe(false)
    expect(operation.request.body.safeParse({ redirect: '/app' }).success).toBe(false)
    expect(operation.responses[200].producer.parse({
      data: { authorizeUrl: 'https://www.bing.com/webmasters/oauth/authorize?state=x', expiresAt: '2026-09-30T00:10:00.000Z' },
      meta,
    }).data.authorizeUrl).toContain('bing.com')
  })

  it('accepts only an http or https Sitemap URL and names the submitted URL', () => {
    const operation = operations.submitSiteBingSitemap
    expect(operation.request.body.safeParse({}).success).toBe(true)
    expect(operation.request.body.safeParse({ url: 'ftp://example.com/sitemap.xml' }).success).toBe(false)
    expect(operation.responses[200].producer.safeParse({
      data: { _tag: 'submitted', sitemap: { _tag: 'unknown' } },
      meta,
    }).success).toBe(false)
  })
})

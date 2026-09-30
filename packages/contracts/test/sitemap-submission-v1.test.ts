import { createGscdumpV1Protocol, GSC_SITEMAP_SUBMIT_SCOPE } from '@gscdump/contracts/v1'
import { describe, expect, it } from 'vitest'

const meta = { requestId: 'req_sitemap_submission', surface: 'partner' as const, version: '1.0' as const }
const operations = createGscdumpV1Protocol().surfaces.partner.operations

function submission(state: unknown) {
  return { data: { searchEngine: 'google', gscPropertyUrl: 'sc-domain:example.com', callerCanAct: true, state }, meta }
}

describe('google Sitemap submission v1', () => {
  it('names the Sitemap and the blocker in one tagged state', () => {
    const response = operations.getSiteSitemapSubmission.responses[200].producer
    const states = [
      { _tag: 'ready', sitemapUrl: 'https://example.com/sitemap.xml', writeAccess: 'unknown' },
      { _tag: 'needs-write-access', sitemapUrl: 'https://example.com/sitemap.xml', requiredScope: GSC_SITEMAP_SUBMIT_SCOPE, grantHolder: { _tag: 'site-owner', email: 'owner@example.com', name: 'Owner' } },
      { _tag: 'insufficient-permission', sitemapUrl: 'https://example.com/sitemap.xml', permissionLevel: 'siteRestrictedUser', requiredPermissionLevels: ['siteOwner', 'siteFullUser'], grantHolder: { _tag: 'caller' } },
      { _tag: 'listed', checkedOn: '2026-09-30', sitemapCount: 2 },
      { _tag: 'awaiting-google', checkedOn: '2026-09-30', sitemapUrl: 'https://example.com/sitemap.xml', sitemapCount: 1 },
      { _tag: 'no-sitemap-found', checkedOn: '2026-09-30' },
      { _tag: 'not-checked' },
      { _tag: 'unavailable', reason: 'permission-lost' },
    ]
    expect(states.map(state => response.parse(submission(state)).data.state)).toEqual(states)
  })

  it('refuses a submit state without the URL it would submit', () => {
    const response = operations.getSiteSitemapSubmission.responses[200].producer
    expect(response.safeParse(submission({ _tag: 'ready', writeAccess: 'granted' })).success).toBe(false)
    expect(response.safeParse(submission({ _tag: 'ready', sitemapUrl: 'ftp://example.com/sitemap.xml', writeAccess: 'granted' })).success).toBe(false)
    expect(response.safeParse(submission({ _tag: 'needs-write-access', sitemapUrl: 'https://example.com/sitemap.xml', requiredScope: 'https://www.googleapis.com/auth/webmasters.readonly', grantHolder: { _tag: 'caller' } })).success).toBe(false)
  })

  it('names the account whose grant submits, so a teammate is asked instead of sent through OAuth', () => {
    const response = operations.getSiteSitemapSubmission.responses[200].producer
    const blocked = (grantHolder: unknown) => submission({ _tag: 'needs-write-access', sitemapUrl: 'https://example.com/sitemap.xml', requiredScope: GSC_SITEMAP_SUBMIT_SCOPE, grantHolder })
    expect(response.safeParse(blocked({ _tag: 'site-owner', email: 'owner@example.com', name: null })).success).toBe(true)
    expect(response.safeParse(blocked({ _tag: 'site-owner', name: 'Owner' })).success).toBe(false)
    expect(response.safeParse(blocked('site-owner')).success).toBe(false)
  })

  it('submits with no body and reports the outcome as a value', () => {
    const operation = operations.submitSiteSitemap
    expect(operation.request.body).toBeNull()
    const response = operation.responses[200].producer
    expect(response.parse({ data: { _tag: 'submitted', sitemapUrl: 'https://example.com/sitemap.xml', sitemapCount: 1 }, meta }).data._tag).toBe('submitted')
    expect(response.parse({ data: { _tag: 'failed', reason: 'no-sitemap-found', retryable: false, sitemapUrl: null }, meta }).data._tag).toBe('failed')
    expect(response.safeParse({ data: { _tag: 'failed', reason: 'forbidden', retryable: false, sitemapUrl: null }, meta }).success).toBe(false)
  })
})

import type { PartnerFetch } from '../src'
import { createPartnerClient } from '../src'

describe('createPartnerClient GSC control operations', () => {
  it('executes typed recovery, inspection, canonical, and sitemap actions', async () => {
    const calls: Array<{ url: string, options: any }> = []
    const fetch = ((url: string, options: any) => {
      calls.push({ url, options })
      if (url.endsWith('/recover-permission')) {
        return Promise.resolve({ success: true, permissionLevel: 'siteOwner', jobsQueued: 2, message: 'restored' })
      }
      if (url.endsWith('/indexing/inspect')) {
        return Promise.resolve({ siteId: 's_1', rateLimit: { reserved: 1, remaining: 99, limit: 100 }, results: [], errors: [], skipped: [] })
      }
      if (url.endsWith('/canonical-mismatches')) {
        return Promise.resolve({ mismatches: [], totalCount: 0, consolidationTargets: [], trend: [], meta: { siteUrl: 'sc-domain:example.com', syncStatus: 'synced' } })
      }
      if (url.endsWith('/sitemaps/membership')) {
        return Promise.resolve({
          urls: [{ url: 'https://example.com/page', normalized: 'https://example.com/page', inSitemap: true }],
          meta: { available: true, reason: null, requested: 1, checked: 1, matched: 1, newestFetchedAt: '2026-07-20T00:00:00.000Z' },
        })
      }
      const action = options.body.action
      if (action === 'refresh')
        return Promise.resolve({ success: true, action: 'refreshed', sitemapCount: 1, changed: false })
      if (action === 'auto-discover')
        return Promise.resolve({ success: true, action: 'auto-discover', discovered: 'https://example.com/sitemap.xml', submitError: null, sitemapCount: 1 })
      return Promise.resolve({ success: true, action: action === 'delete' ? 'deleted' : 'submitted', sitemapUrl: options.body.sitemapUrl, sitemapCount: 1 })
    }) as PartnerFetch
    const client = createPartnerClient({ fetch, validate: true })

    await client.recoverPermission('s_1')
    await client.requestIndexingInspect('s_1', { urls: ['https://example.com/page'] })
    await client.getCanonicalMismatches('s_1')
    await client.getSitemapMembership('s_1', { urls: ['https://example.com/page'], maxAgeDays: 30 })
    await client.submitSitemap('s_1', 'https://example.com/sitemap.xml')
    await client.refreshSitemaps('s_1')
    await client.autoDiscoverSitemap('s_1')

    expect(calls.map(call => call.url)).toEqual([
      '/api/sites/s_1/recover-permission',
      '/api/sites/s_1/indexing/inspect',
      '/api/sites/s_1/canonical-mismatches',
      '/api/sites/s_1/sitemaps/membership',
      '/api/sites/s_1/sitemaps',
      '/api/sites/s_1/sitemaps',
      '/api/sites/s_1/sitemaps',
    ])
    expect(calls.slice(4).map(call => call.options.body.action)).toEqual(['submit', 'refresh', 'auto-discover'])
    expect(calls[3]!.options).toMatchObject({ method: 'POST', body: { urls: ['https://example.com/page'], maxAgeDays: 30 } })
  })

  it('executes fully validated team mirror and catalog operations', async () => {
    const calls: Array<{ url: string, options: any }> = []
    const catalog = {
      teamId: 't_1',
      catalogUri: 'https://catalog.cloudflarestorage.com/acct/gsc-team-t-1-int',
      warehouse: 'acct_gsc-team-t-1-int',
      bucket: 'gsc-team-t-1-int',
      namespace: 'gsc',
    }
    const fetch = ((url: string, options: any) => {
      calls.push({ url, options })
      if (url.endsWith('/catalog')) {
        if (options.method === 'POST')
          return Promise.resolve({ ...catalog, status: 'ready' })
        return Promise.resolve({ ...catalog, provisioningState: 'ready', keyEncoding: 'int', catalogTablesReady: true, readsEnabled: true })
      }
      if (url.endsWith('/members/u_2'))
        return Promise.resolve(options.method === 'PATCH' ? { ok: true, role: 'viewer' } : { ok: true })
      if (url.endsWith('/members'))
        return Promise.resolve(options.method === 'GET' ? { members: [] } : { ok: true, role: 'editor' })
      if (url.includes('/partner/users/'))
        return Promise.resolve({ ok: true, teamId: 't_1' })
      if (options.method === 'PATCH')
        return Promise.resolve({ ok: true, name: 'Renamed' })
      return Promise.resolve({ ok: true })
    }) as PartnerFetch
    const client = createPartnerClient({ fetch, validate: true })

    await client.renameTeam('t_1', { name: 'Renamed' })
    await client.deleteTeam('t_1')
    await client.listTeamMembers('t_1')
    await client.addTeamMember('t_1', { userId: 'u_2', role: 'editor' })
    await client.updateTeamMemberRole('t_1', 'u_2', { role: 'viewer' })
    await client.removeTeamMember('t_1', 'u_2')
    await client.bindSiteToTeam('u_1', 's_1', { teamId: 't_1' })
    await client.getTeamCatalog('t_1')
    await client.bindTeamCatalog('t_1', catalog)

    expect(calls.map(call => `${call.options.method} ${call.url}`)).toEqual([
      'PATCH /api/partner/teams/t_1',
      'DELETE /api/partner/teams/t_1',
      'GET /api/partner/teams/t_1/members',
      'POST /api/partner/teams/t_1/members',
      'PATCH /api/partner/teams/t_1/members/u_2',
      'DELETE /api/partner/teams/t_1/members/u_2',
      'PATCH /api/partner/users/u_1/sites/s_1',
      'GET /api/partner/teams/t_1/catalog',
      'POST /api/partner/teams/t_1/catalog',
    ])
  })

  it('executes crosswalk and add/verify without caller-owned route strings', async () => {
    const calls: Array<{ url: string, options: any }> = []
    const fetch = ((url: string, options: any) => {
      calls.push({ url, options })
      if (url.endsWith('/sites/crosswalk'))
        return Promise.resolve({ crosswalk: { s_1: 42 }, sites: [{ siteId: 's_1', intId: 42, siteUrl: 'sc-domain:example.com' }] })
      if (url.endsWith('/verification-token')) {
        return Promise.resolve({
          siteUrl: 'sc-domain:example.com',
          site: { type: 'INET_DOMAIN', identifier: 'example.com' },
          method: 'DNS_TXT',
          token: 'token',
          metaContent: null,
          dnsRecord: { type: 'TXT', host: 'example.com', value: 'token' },
        })
      }
      return Promise.resolve({
        siteUrl: 'sc-domain:example.com',
        site: { type: 'INET_DOMAIN', identifier: 'example.com' },
        method: 'DNS_TXT',
        verified: true,
        owners: ['owner@example.com'],
      })
    }) as PartnerFetch
    const client = createPartnerClient({ fetch, validate: true })
    const verification = { userId: 'u_1', siteUrl: 'sc-domain:example.com', method: 'DNS_TXT' as const }

    await client.getUserSiteIntIdCrosswalk('u_1')
    await client.requestSiteVerificationToken(verification)
    await client.addAndVerifySite(verification)

    expect(calls.map(call => call.url)).toEqual([
      '/api/partner/users/u_1/sites/crosswalk',
      '/api/partner/sites/verification-token',
      '/api/partner/sites/add-and-verify',
    ])
    expect(calls.slice(1).every(call => call.options.method === 'POST')).toBe(true)
  })
})

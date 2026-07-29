import {
  partnerEndpoints,
  partnerRoutes,
} from '../src/partner'

describe('official partner GSC operations', () => {
  it('keeps deployed route builders and descriptors aligned', () => {
    expect(partnerRoutes.partner.users.siteIntIdCrosswalk('u 1')).toBe('/partner/users/u%201/sites/crosswalk')
    expect(partnerRoutes.partner.sites.verificationToken).toBe('/partner/sites/verification-token')
    expect(partnerRoutes.partner.sites.addAndVerify).toBe('/partner/sites/add-and-verify')
    expect(partnerRoutes.teams.catalog('t 1')).toBe('/partner/teams/t%201/catalog')
    expect(partnerEndpoints.getUserSiteIntIdCrosswalk).toMatchObject({ method: 'GET' })
    expect(partnerEndpoints.requestSiteVerificationToken).toMatchObject({ method: 'POST' })
    expect(partnerEndpoints.addAndVerifySite).toMatchObject({ method: 'POST' })
    expect(partnerEndpoints.getTeamCatalog).toMatchObject({ method: 'GET' })
    expect(partnerEndpoints.bindTeamCatalog).toMatchObject({ method: 'POST' })
  })

  it('fully schemas permission recovery, inspection, and canonical mismatches', () => {
    expect(partnerEndpoints.recoverPermission.response.parse({
      success: true,
      permissionLevel: 'siteOwner',
      jobsQueued: 2,
      message: 'Permission restored',
    })).toMatchObject({ success: true, jobsQueued: 2 })

    expect(partnerEndpoints.requestIndexingInspect.body.parse({
      urls: ['https://example.com/page'],
    })).toEqual({ urls: ['https://example.com/page'] })
    expect(partnerEndpoints.requestIndexingInspect.response.parse({
      siteId: 's_1',
      rateLimit: { reserved: 1, remaining: 99, limit: 100 },
      results: [],
      errors: [],
      skipped: [],
    })).toMatchObject({ siteId: 's_1' })

    expect(partnerEndpoints.getCanonicalMismatches.response.parse({
      mismatches: [],
      totalCount: 0,
      consolidationTargets: [],
      trend: [],
      meta: { siteUrl: 'sc-domain:example.com', syncStatus: 'synced' },
    })).toMatchObject({ totalCount: 0 })
  })

  it('schemas every team mirror and catalog mutation without noSchema placeholders', () => {
    expect(partnerEndpoints.renameTeam.body.parse({ name: 'Search team' })).toEqual({ name: 'Search team' })
    expect(partnerEndpoints.renameTeam.response.parse({ ok: true, name: 'Search team' })).toEqual({ ok: true, name: 'Search team' })
    expect(partnerEndpoints.deleteTeam.response.parse({ ok: true })).toEqual({ ok: true })
    expect(partnerEndpoints.addTeamMember.response.parse({ ok: true, role: 'editor', alreadyExisted: true })).toMatchObject({ role: 'editor' })
    expect(partnerEndpoints.updateTeamMemberRole.body.parse({ role: 'viewer' })).toEqual({ role: 'viewer' })
    expect(partnerEndpoints.updateTeamMemberRole.response.parse({ ok: true, role: 'viewer' })).toEqual({ ok: true, role: 'viewer' })
    expect(partnerEndpoints.removeTeamMember.response.parse({ ok: true })).toEqual({ ok: true })

    const binding = {
      catalogUri: 'https://catalog.cloudflarestorage.com/acct/gsc-team-t-1-int',
      warehouse: 'acct_gsc-team-t-1-int',
      bucket: 'gsc-team-t-1-int',
      namespace: 'gsc',
    }
    expect(partnerEndpoints.bindTeamCatalog.body.parse(binding)).toEqual(binding)
    expect(partnerEndpoints.bindTeamCatalog.response.parse({ teamId: 't_1', status: 'ready', ...binding })).toMatchObject({ teamId: 't_1', status: 'ready' })
    expect(partnerEndpoints.getTeamCatalog.response.parse({
      teamId: 't_1',
      ...binding,
      provisioningState: 'ready',
      keyEncoding: 'int',
      catalogTablesReady: true,
      readsEnabled: true,
    })).toMatchObject({ teamId: 't_1', keyEncoding: 'int' })
  })

  it('schemas the publicId crosswalk and add/verify payloads', () => {
    expect(partnerEndpoints.getUserSiteIntIdCrosswalk.response.parse({
      crosswalk: { s_1: 42 },
      sites: [{ siteId: 's_1', intId: 42, siteUrl: 'sc-domain:example.com' }],
    })).toMatchObject({ crosswalk: { s_1: 42 } })

    const request = { userId: 'u_1', siteUrl: 'sc-domain:example.com', method: 'DNS_TXT' as const }
    expect(partnerEndpoints.requestSiteVerificationToken.body.parse(request)).toEqual(request)
    expect(partnerEndpoints.requestSiteVerificationToken.response.parse({
      siteUrl: request.siteUrl,
      site: { type: 'INET_DOMAIN', identifier: 'example.com' },
      method: request.method,
      token: 'google-site-verification=token',
      metaContent: null,
      dnsRecord: { type: 'TXT', host: 'example.com', value: 'google-site-verification=token' },
    })).toMatchObject({ method: 'DNS_TXT' })
    expect(partnerEndpoints.addAndVerifySite.response.parse({
      siteUrl: request.siteUrl,
      site: { type: 'INET_DOMAIN', identifier: 'example.com' },
      method: request.method,
      verified: true,
      owners: ['owner@example.com'],
    })).toMatchObject({ verified: true })
  })
})

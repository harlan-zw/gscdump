import {
  partnerEndpoints,
  partnerRoutes,
} from '../src/partner'

const retiredEndpointNames = [
  'getUserSiteIntIdCrosswalk',
  'deleteUser',
  'requestIndexingInspect',
  'recoverPermission',
  'getTopAssociation',
  'getKeywordSparklines',
  'getQueryTrend',
  'getPageTrend',
  'getCanonicalMismatches',
  'getIndexPercent',
  'createTeam',
  'renameTeam',
  'deleteTeam',
  'listTeamMembers',
  'addTeamMember',
  'updateTeamMemberRole',
  'removeTeamMember',
  'bindSiteToTeam',
  'getTeamCatalog',
  'bindTeamCatalog',
] as const

describe('official partner GSC operations', () => {
  it('keeps only hosted legacy routes that still exist', () => {
    expect(partnerRoutes.partner.sites.verificationToken).toBe('/partner/sites/verification-token')
    expect(partnerRoutes.partner.sites.addAndVerify).toBe('/partner/sites/add-and-verify')
    expect(partnerRoutes).not.toHaveProperty('teams')
    expect(partnerRoutes.partner.users).not.toHaveProperty('byId')
    expect(partnerRoutes.partner.users).not.toHaveProperty('siteTeam')
    expect(partnerRoutes.partner.users).not.toHaveProperty('siteIntIdCrosswalk')
    expect(partnerRoutes.sites).not.toHaveProperty('indexingInspect')
    expect(partnerRoutes.sites).not.toHaveProperty('recoverPermission')
    expect(partnerRoutes.sites).not.toHaveProperty('canonicalMismatches')
    expect(partnerRoutes.sites).not.toHaveProperty('topAssociation')
    expect(partnerRoutes.sites).not.toHaveProperty('keywordSparklines')
    expect(partnerRoutes.sites).not.toHaveProperty('queryTrend')
    expect(partnerRoutes.sites).not.toHaveProperty('pageTrend')
    expect(partnerRoutes.sites).not.toHaveProperty('indexPercent')
  })

  it('does not advertise retired compatibility endpoints', () => {
    for (const name of retiredEndpointNames)
      expect(partnerEndpoints).not.toHaveProperty(name)
  })

  it('retains the two verification compatibility descriptors', () => {
    const request = { userId: 'u_1', siteUrl: 'sc-domain:example.com', method: 'DNS_TXT' as const }
    expect(partnerEndpoints.requestSiteVerificationToken.body.parse(request)).toEqual(request)
    expect(partnerEndpoints.addAndVerifySite.body.parse(request)).toEqual(request)
  })
})

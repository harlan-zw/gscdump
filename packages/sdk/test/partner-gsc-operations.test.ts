import type { PartnerFetch } from '../src/client'
import { createPartnerClient } from '../src/client'

const retiredClientMembers = [
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

describe('createPartnerClient GSC control operations', () => {
  it('does not advertise retired compatibility operations', () => {
    const client = createPartnerClient()
    for (const member of retiredClientMembers)
      expect(client).not.toHaveProperty(member)
  })

  it('retains verification operations until their live exercise closes', async () => {
    const calls: Array<{ url: string, options: any }> = []
    const fetch = ((url: string, options: any) => {
      calls.push({ url, options })
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

    await client.requestSiteVerificationToken(verification)
    await client.addAndVerifySite(verification)

    expect(calls.map(call => call.url)).toEqual([
      '/api/partner/sites/verification-token',
      '/api/partner/sites/add-and-verify',
    ])
    expect(calls.every(call => call.options.method === 'POST')).toBe(true)
  })
})

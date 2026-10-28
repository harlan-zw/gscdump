import { createGscdumpV1Protocol } from '@gscdump/contracts/v1'
import { describe, expect, it } from 'vitest'

const meta = { requestId: 'req_lifecycle', surface: 'partner', version: '1.0' } as const
const { getRegisteredHostIdentity, getUserLifecycle } = createGscdumpV1Protocol().surfaces.partner.operations

const site = {
  siteId: 's_01',
  externalSiteId: null,
  requestedUrl: 'https://www.example.com/',
  gscPropertyUrl: 'sc-domain:example.com',
  permissionLevel: 'siteOwner',
  property: { status: 'linked', nextAction: 'none' },
  analytics: { status: 'ready', progress: { completed: 1, failed: 0, total: 1, percent: 100 }, queryable: true, sourceMode: 'r2', syncedRange: { oldest: '2026-09-01', newest: '2026-10-26' }, nextAction: 'none' },
  sitemaps: { status: 'ready', discoveredCount: 1, nextAction: 'none' },
  indexing: { status: 'not_requested', eligible: true, reason: null, progress: { completed: 0, failed: 0, total: 0, percent: 0 }, nextAction: 'none' },
  hold: null,
  latestError: null,
  updatedAt: '2026-10-28T00:00:00.000Z',
}

const identity = {
  siteId: 's_01',
  userId: 'u_01',
  teamId: 't_team',
  requestedUrl: 'https://www.example.com/',
  catalogSiteId: 7,
  warehouse: 'warehouse',
  namespace: 'gsc',
  version: 0,
  revision: 0,
  catalogRevision: 1,
  dataVersion: 3,
}

const legacy = { identity, coverage: { _tag: 'legacy' } }
const verified = {
  identity: { ...identity, namespace: 'gsc_v2', version: 2, revision: 1 },
  coverage: { _tag: 'verified', window: { startDate: '2026-09-01', endDate: '2026-10-26' } },
}

function lifecycle(sites: unknown[]) {
  return {
    data: { userId: 'u_01', partnerId: 'p_01', currentTeamId: null, account: { status: 'ready', grantedScopes: [], missingScopes: [], nextAction: 'none' }, sites },
    meta,
  }
}

describe('lifecycle Site registration', () => {
  it.each([
    ['a legacy registration', legacy],
    ['a verified registration', verified],
  ])('reads %s a host sends', (_, registration) => {
    const parsed = getUserLifecycle.responses[200].client.parse(lifecycle([{ ...site, registration }]))
    expect(parsed.data.sites[0]?.registration).toEqual(registration)
  })

  it('carries the registration the identity operation answers', () => {
    const answered = getRegisteredHostIdentity.responses[200].client.parse({ data: verified, meta })
    const parsed = getUserLifecycle.responses[200].client.parse(lifecycle([{ ...site, registration: answered.data }]))
    expect(parsed.data.sites[0]?.registration).toEqual(answered.data)
  })

  it('reads a host that sends no registration as absent', () => {
    const parsed = getUserLifecycle.responses[200].client.parse(lifecycle([site]))
    expect(parsed.data.sites[0]?.registration).toBeUndefined()
  })

  it.each([
    ['an identity without its writer key', { identity: { ...identity, catalogSiteId: undefined }, coverage: { _tag: 'legacy' } }],
    ['a public ID in the wrong form', { identity: { ...identity, siteId: '01' }, coverage: { _tag: 'legacy' } }],
    ['a coverage this version does not know', { identity, coverage: { _tag: 'partial' } }],
    ['no coverage', { identity }],
  ])('refuses %s', (_, registration) => {
    expect(getUserLifecycle.responses[200].client.safeParse(lifecycle([{ ...site, registration }])).success).toBe(false)
  })

  it('lets the producer send or omit the registration', () => {
    expect(getUserLifecycle.responses[200].producer.parse(lifecycle([{ ...site, registration: legacy }])).data.sites[0]?.registration).toEqual(legacy)
    expect(getUserLifecycle.responses[200].producer.parse(lifecycle([site])).data.sites[0]?.registration).toBeUndefined()
  })

  it('refuses a producer registration with extra identity fields', () => {
    const registration = { ...legacy, identity: { ...identity, ownerId: 12 } }
    expect(getUserLifecycle.responses[200].producer.safeParse(lifecycle([{ ...site, registration }])).success).toBe(false)
  })
})

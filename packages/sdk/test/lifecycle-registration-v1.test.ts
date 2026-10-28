import { createGscdumpV1Client, isGscdumpV1Error } from '@gscdump/sdk/v1'
import { describe, expect, it, vi } from 'vitest'

const meta = { requestId: 'req_lifecycle', surface: 'partner', version: '1.0' }

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

const registration = {
  identity: { siteId: 's_01', userId: 'u_01', teamId: 't_team', requestedUrl: 'https://www.example.com/', catalogSiteId: 7, warehouse: 'warehouse', namespace: 'gsc', version: 0, revision: 0, catalogRevision: 1, dataVersion: 3 },
  coverage: { _tag: 'legacy' },
}

function lifecycleClient(sites: unknown[]) {
  const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response(JSON.stringify({
    data: { userId: 'u_01', partnerId: 'p_01', currentTeamId: null, account: { status: 'ready', grantedScopes: [], missingScopes: [], nextAction: 'none' }, sites },
    meta,
  }), { status: 200, headers: { 'content-type': 'application/json' } }))
  return { client: createGscdumpV1Client({ apiRoot: 'https://gscdump.test/api', credential: 'secret', fetch, retry: { maxAttempts: 1 } }), fetch }
}

describe('lifecycle Site registration through getUserLifecycle', () => {
  it('returns the registration a host sends on each Site', async () => {
    const { client, fetch } = lifecycleClient([{ ...site, registration }, { ...site, siteId: 's_02' }])
    const { data } = await client.getUserLifecycle({ params: { userId: 'u_01' } })
    expect(data.sites.map(entry => entry.registration)).toEqual([registration, undefined])
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('refuses a lifecycle whose registration is not a registered-host identity', async () => {
    const { client } = lifecycleClient([{ ...site, registration: { identity: { ...registration.identity, catalogSiteId: -1 }, coverage: registration.coverage } }])
    const error = await client.getUserLifecycle({ params: { userId: 'u_01' } }).catch((caught: unknown) => caught)
    expect(isGscdumpV1Error(error) && error.code).toBe('response_validation')
  })
})

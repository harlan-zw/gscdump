import { parseEntitlementRefusal, partnerWebhookEnvelopeSchema, WEBHOOK_CONTRACT_VERSION } from '@gscdump/contracts'
import { createGscdumpV1Protocol } from '@gscdump/contracts/v1'
import { createGscdumpV1Paths } from '@gscdump/contracts/v1/paths'
import { describe, expect, it } from 'vitest'

const meta = { requestId: 'req_entitlements', surface: 'partner', version: '1.0' } as const
const { createSite, getUserEntitlements, getUserLifecycle, inspectSiteUrls } = createGscdumpV1Protocol().surfaces.partner.operations

function envelope(code: string, details: Record<string, unknown>) {
  return { error: { code, message: 'The free allowance covers 3 Sites. Disconnect a Site, or use Local mode for more Sites.', requestId: 'req_01', retryable: false, details } }
}

describe('entitlement refusals', () => {
  it.each([
    ['invalid_request', { reason: 'site_allowance', limit: 3 }],
    ['invalid_request', { reason: 'duplicate_property', siteUrl: 'example.com' }],
    ['invalid_request', { reason: 'site_held', hold: 'size_limit' }],
    ['invalid_request', { reason: 'inspection_off' }],
    ['rate_limited', { reason: 'inspection_allowance', limit: 5000, resetsAt: '2026-11-01' }],
  ] as const)('reads %s %o from a v1 error envelope', (code, details) => {
    const parsed = inspectSiteUrls.errorResponse.client.parse(envelope(code, details))
    expect(parseEntitlementRefusal(parsed.error.details)).toEqual(details)
  })

  it('drops detail keys a newer host adds', () => {
    const parsed = createSite.errorResponse.client.parse(envelope('invalid_request', { reason: 'site_allowance', limit: 8, policy: 'grandfathered' }))
    expect(parseEntitlementRefusal(parsed.error.details)).toEqual({ reason: 'site_allowance', limit: 8 })
  })

  it.each([
    ['another failure reason', { reason: 'ACCESS_TOKEN_SCOPE_INSUFFICIENT', missing: ['scope'] }],
    ['a hold reason this version does not know', { reason: 'site_held', hold: 'region_limit' }],
    ['a held Site without its reason', { reason: 'site_held' }],
    ['a reset day that is not a date', { reason: 'inspection_allowance', limit: 5000, resetsAt: 'next month' }],
    ['empty details', {}],
  ])('returns null for %s', (_, details) => {
    expect(parseEntitlementRefusal(details)).toBeNull()
  })
})

describe('lifecycle Site hold', () => {
  const site = {
    siteId: 's_01',
    externalSiteId: null,
    requestedUrl: 'sc-domain:example.com',
    gscPropertyUrl: 'sc-domain:example.com',
    permissionLevel: 'siteOwner',
    property: { status: 'linked', nextAction: 'none' },
    analytics: { status: 'queued', progress: { completed: 0, failed: 0, total: 0, percent: 0 }, queryable: false, sourceMode: 'none', syncedRange: { oldest: null, newest: null }, nextAction: 'wait_for_sync' },
    sitemaps: { status: 'unknown', discoveredCount: 0, nextAction: 'none' },
    indexing: { status: 'not_requested', eligible: true, reason: null, progress: { completed: 0, failed: 0, total: 0, percent: 0 }, nextAction: 'none' },
    latestError: null,
    updatedAt: '2026-09-30T00:00:00.000Z',
  }
  const lifecycle = (sites: unknown[]) => ({
    data: { userId: 'u_01', partnerId: 'p_01', currentTeamId: null, account: { status: 'ready', grantedScopes: [], missingScopes: [], nextAction: 'none' }, sites },
    meta,
  })

  it('reads the hold reason a host sends', () => {
    const parsed = getUserLifecycle.responses[200].client.parse(lifecycle([{ ...site, hold: 'size_pending' }]))
    expect(parsed.data.sites[0]?.hold).toBe('size_pending')
  })

  it('reads a host that sends no hold as not held', () => {
    const parsed = getUserLifecycle.responses[200].client.parse(lifecycle([site]))
    expect(parsed.data.sites[0]?.hold).toBeNull()
  })

  it('requires the producer to send hold', () => {
    expect(() => getUserLifecycle.responses[200].producer.parse(lifecycle([site]))).toThrow()
    expect(getUserLifecycle.responses[200].producer.parse(lifecycle([{ ...site, hold: null }])).data.sites[0]?.hold).toBeNull()
  })
})

describe('user entitlements v1', () => {
  const metered = {
    mode: 'metered',
    phase: 'beta',
    meters: {
      sites: { used: 4, allowance: 3 },
      preservedRows: { used: null, allowance: 250_000 },
      urlInspections: { used: 12, allowance: null, resetsAt: '2026-10-01' },
    },
    sizeLimitRowsPerDay: 2_500,
    heldSites: [{ siteId: 's_02', hold: 'sitemap_limit' }],
  }

  it('builds the path from the route catalog', () => {
    expect(createGscdumpV1Paths().path('partner.users.entitlements.get', { userId: 'u_01' })).toBe('/api/partner/v1/users/u_01/entitlements')
  })

  it('carries no Meters for an exempt partner', () => {
    expect(getUserEntitlements.responses[200].producer.parse({ data: { mode: 'exempt' }, meta }).data).toEqual({ mode: 'exempt' })
    expect(() => getUserEntitlements.responses[200].producer.parse({ data: { mode: 'exempt', meters: metered.meters }, meta })).toThrow()
  })

  it('carries each Meter, the size limit, and held Sites for a metered partner', () => {
    expect(getUserEntitlements.responses[200].producer.parse({ data: metered, meta }).data).toEqual(metered)
  })

  it('rejects a metered response without its Meters or with an unknown hold reason', () => {
    const { meters: _meters, ...withoutMeters } = metered
    expect(() => getUserEntitlements.responses[200].client.parse({ data: withoutMeters, meta })).toThrow()
    expect(() => getUserEntitlements.responses[200].client.parse({ data: { ...metered, heldSites: [{ siteId: 's_02', hold: 'region_limit' }] }, meta })).toThrow()
  })
})

describe('user.allowance.notice webhook', () => {
  const notice = {
    contractVersion: WEBHOOK_CONTRACT_VERSION,
    deliveryId: 'whd_1',
    event: 'user.allowance.notice',
    partnerId: 'p_01',
    userId: 'u_01',
    lifecycleRevision: 1,
    occurredAt: '2026-09-30T00:00:00.000Z',
    data: { userId: 'u_01', meter: 'url_inspections', threshold: 80, used: 4_000, allowance: 5_000, period: '2026-09' },
  }

  it('accepts a notice with its typed data', () => {
    expect(partnerWebhookEnvelopeSchema.parse(notice).data).toEqual(notice.data)
  })

  it.each([
    ['a threshold other than 80 or 100', { threshold: 90 }],
    ['an unknown Meter', { meter: 'gigabytes' }],
    ['a period that is not a month', { period: '2026-09-30' }],
  ])('rejects a notice with %s', (_, change) => {
    expect(partnerWebhookEnvelopeSchema.safeParse({ ...notice, data: { ...notice.data, ...change } }).success).toBe(false)
  })

  it('leaves the data of other events untyped', () => {
    expect(partnerWebhookEnvelopeSchema.safeParse({ ...notice, event: 'site.indexing.ready', data: { threshold: 90 } }).success).toBe(true)
  })
})

import { parseEntitlementRefusal } from '@gscdump/contracts'
import { createGscdumpV1Client, isGscdumpV1Error } from '@gscdump/sdk/v1'
import { parseWebhookPayload, signWebhookPayload, WEBHOOK_CONTRACT_VERSION } from '@gscdump/sdk/webhook'
import { describe, expect, it, vi } from 'vitest'

const meta = { requestId: 'req_entitlements', surface: 'partner', version: '1.0' }

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

describe('user entitlements v1 client', () => {
  it('reads a metered partner\'s Meters through getUserEntitlements', async () => {
    const data = {
      mode: 'metered',
      phase: 'beta',
      meters: {
        sites: { used: 3, allowance: 3 },
        preservedRows: { used: 90_000, allowance: 250_000 },
        urlInspections: { used: 5_000, allowance: 5_000, resetsAt: '2026-10-01' },
      },
      sizeLimitRowsPerDay: 2_500,
      heldSites: [],
    }
    const fetch = vi.fn<typeof globalThis.fetch>(async (request, init) => {
      expect(request).toBe('/api/_gscdump/partner/v1/users/u_01/entitlements')
      expect(init?.method).toBe('GET')
      return json({ data, meta })
    })
    const client = createGscdumpV1Client({ apiRoot: '/api/_gscdump', credential: 'secret', fetch })

    const response = await client.getUserEntitlements({ params: { userId: 'u_01' } })
    expect(response.data).toEqual(data)
  })

  it('reads an exempt partner as no Meters', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => json({ data: { mode: 'exempt' }, meta }))
    const client = createGscdumpV1Client({ apiRoot: '/api/_gscdump', credential: 'secret', fetch })

    const { data } = await client.getUserEntitlements({ params: { userId: 'u_01' } })
    expect(data).toEqual({ mode: 'exempt' })
  })

  it('surfaces a refused Site registration as a parsed entitlement refusal', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => json({
      error: { code: 'invalid_request', message: 'The free allowance covers 3 Sites.', requestId: 'req_01', retryable: false, details: { reason: 'site_allowance', limit: 3 } },
    }, 409))
    const client = createGscdumpV1Client({ apiRoot: '/api/_gscdump', credential: 'secret', fetch })

    const error = await client.createSite({ params: { userId: 'u_01' }, body: { siteUrl: 'sc-domain:example.com' } }).catch((caught: unknown) => caught)
    expect(isGscdumpV1Error(error) && error.status).toBe(409)
    expect(isGscdumpV1Error(error) ? parseEntitlementRefusal(error.details) : 'not a v1 error').toEqual({ reason: 'site_allowance', limit: 3 })
    expect(fetch).toHaveBeenCalledTimes(1)
  })
})

describe('user.allowance.notice webhook', () => {
  const secret = 'whsec_test'
  const envelope = {
    contractVersion: WEBHOOK_CONTRACT_VERSION,
    deliveryId: 'whd_allowance',
    event: 'user.allowance.notice',
    partnerId: 'p_01',
    userId: 'u_01',
    externalUserId: null,
    externalSiteId: null,
    lifecycleRevision: 1,
    occurredAt: '2026-09-30T00:00:00.000Z',
    data: { userId: 'u_01', meter: 'sites', threshold: 100, used: 3, allowance: 3, period: '2026-09' },
  }

  it('verifies a signed notice and narrows its data by event', async () => {
    const raw = JSON.stringify(envelope)
    const parsed = await parseWebhookPayload(raw, { secret, signature: await signWebhookPayload(raw, secret) })

    const notice = parsed.event === 'user.allowance.notice' ? parsed.data : null
    expect(notice).toEqual(envelope.data)
  })

  it('rejects a notice whose body changed after signing', async () => {
    const raw = JSON.stringify(envelope)
    const signature = await signWebhookPayload(raw, secret)
    const tampered = JSON.stringify({ ...envelope, data: { ...envelope.data, used: 1 } })

    await expect(parseWebhookPayload(tampered, { secret, signature })).rejects.toThrow('Invalid webhook signature')
  })

  it('rejects a signed notice with malformed data', async () => {
    const raw = JSON.stringify({ ...envelope, data: { ...envelope.data, threshold: 50 } })

    await expect(parseWebhookPayload(raw, { secret, signature: await signWebhookPayload(raw, secret) })).rejects.toThrow()
  })
})

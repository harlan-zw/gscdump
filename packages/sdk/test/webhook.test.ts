import {
  createWebhookEnvelope,
  generateWebhookSecret,
  parseWebhookPayload,
  readWebhookHeaders,
  shouldQueueWebhook,
  signWebhookPayload,
  toCanonicalWebhookEvent,
  verifyWebhookSignature,
  WEBHOOK_CONTRACT_VERSION,
  WEBHOOK_DELIVERY_HEADER,
  WEBHOOK_EVENT_HEADER,
  WEBHOOK_SIGNATURE_HEADER,
  WEBHOOK_TIMESTAMP_HEADER,
} from '../src/webhook'

describe('partner webhooks', () => {
  it('creates canonical envelopes and preserves legacy event context', () => {
    const envelope = createWebhookEnvelope({
      event: 'site.completed',
      partnerId: 'partner_1',
      userId: 'usr_1',
      siteId: 'site_1',
      externalSiteId: 'ext_site_1',
      lifecycleRevision: 123,
      occurredAt: '2026-05-11T00:00:00.000Z',
      data: { rowsInserted: 100 },
    })

    expect(envelope).toMatchObject({
      contractVersion: WEBHOOK_CONTRACT_VERSION,
      event: 'site.analytics.ready',
      externalUserId: null,
      externalSiteId: 'ext_site_1',
      data: {
        legacyEvent: 'site.completed',
        legacyPayload: {
          event: 'site.completed',
          rowsInserted: 100,
        },
        rowsInserted: 100,
      },
    })
  })

  it('matches current gscdump.com user lifecycle envelopes', () => {
    const envelope = createWebhookEnvelope({
      event: 'user.lifecycle.changed',
      partnerId: 'partner_1',
      userId: 'usr_1',
      lifecycleRevision: 789,
      occurredAt: '2026-05-11T00:00:00.000Z',
      data: { account: { status: 'ready' } },
    })

    expect(JSON.parse(JSON.stringify(envelope))).toEqual({
      contractVersion: WEBHOOK_CONTRACT_VERSION,
      deliveryId: envelope.deliveryId,
      event: 'user.lifecycle.changed',
      partnerId: 'partner_1',
      userId: 'usr_1',
      externalUserId: null,
      externalSiteId: null,
      lifecycleRevision: 789,
      occurredAt: '2026-05-11T00:00:00.000Z',
      data: {
        legacyEvent: 'user.lifecycle.changed',
        account: { status: 'ready' },
      },
    })
  })

  it('signs and verifies raw JSON payloads', async () => {
    const secret = 'whsec_test'
    const payload = JSON.stringify({ deliveryId: 'whd_1', event: 'site.analytics.ready' })
    const signature = await signWebhookPayload(payload, secret)

    expect(signature).toMatch(/^sha256=[\da-f]{64}$/)
    await expect(verifyWebhookSignature(payload, signature, secret)).resolves.toBe(true)
    await expect(verifyWebhookSignature(`${payload} `, signature, secret)).resolves.toBe(false)
  })

  it('parses payloads with signature validation and header helpers', async () => {
    const secret = generateWebhookSecret()
    const envelope = createWebhookEnvelope({
      event: 'site.indexing.ready',
      partnerId: 'partner_1',
      userId: null,
      lifecycleRevision: 456,
      occurredAt: '2026-05-11T00:00:00.000Z',
      data: {},
    })
    const payload = JSON.stringify(envelope)
    const signature = await signWebhookPayload(payload, secret)
    const headers = new Headers({
      [WEBHOOK_EVENT_HEADER]: envelope.event,
      [WEBHOOK_DELIVERY_HEADER]: envelope.deliveryId,
      [WEBHOOK_SIGNATURE_HEADER]: signature,
      [WEBHOOK_TIMESTAMP_HEADER]: envelope.occurredAt,
    })

    expect(readWebhookHeaders(headers)).toMatchObject({
      event: envelope.event,
      delivery: envelope.deliveryId,
      timestamp: envelope.occurredAt,
      signature,
    })
    await expect(parseWebhookPayload(payload, { secret, headers })).resolves.toEqual(envelope)
    await expect(parseWebhookPayload(payload, { secret, signature: 'sha256=bad' })).rejects.toThrow('Invalid webhook signature')
  })

  it('matches webhook subscriptions against canonical aliases', () => {
    expect(toCanonicalWebhookEvent('auth.failed')).toBe('site.auth.failed')
    expect(shouldQueueWebhook(JSON.stringify(['site.auth.failed']), 'auth.failed')).toBe(true)
    expect(shouldQueueWebhook(['site.indexing.ready'], 'site.completed')).toBe(false)
  })
})

import {
  parseWebhookPayload,
  readWebhookHeaders,
  signWebhookPayload,
  verifyWebhookSignature,
  WEBHOOK_CONTRACT_VERSION,
  WEBHOOK_DELIVERY_HEADER,
  WEBHOOK_EVENT_HEADER,
  WEBHOOK_SIGNATURE_HEADER,
  WEBHOOK_TIMESTAMP_HEADER,
} from '../src/webhook'

describe('partner webhooks', () => {
  it('signs and verifies raw JSON payloads', async () => {
    const secret = 'whsec_test'
    const payload = JSON.stringify({ deliveryId: 'whd_1', event: 'site.analytics.ready' })
    const signature = await signWebhookPayload(payload, secret)

    expect(signature).toMatch(/^sha256=[\da-f]{64}$/)
    await expect(verifyWebhookSignature(payload, signature, secret)).resolves.toBe(true)
    await expect(verifyWebhookSignature(`${payload} `, signature, secret)).resolves.toBe(false)
  })

  it('parses payloads with signature validation and header helpers', async () => {
    const secret = 'whsec_test'
    const envelope = {
      contractVersion: WEBHOOK_CONTRACT_VERSION,
      deliveryId: 'whd_1',
      event: 'site.indexing.ready',
      partnerId: 'partner_1',
      userId: null,
      externalUserId: null,
      externalSiteId: null,
      lifecycleRevision: 456,
      occurredAt: '2026-05-11T00:00:00.000Z',
      data: {},
    } as const
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
})

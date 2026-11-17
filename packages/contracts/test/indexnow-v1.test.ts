import { indexNowAutomaticSendingUpdateV1Schema, indexNowConnectionV1Schema, indexNowConnectionV1Schemas, indexNowSubmissionReceiptV1Schema, indexNowSubmissionReceiptV1Schemas, indexNowSubmitV1Schema } from '@gscdump/contracts/v1'
import { describe, expect, it } from 'vitest'

const receipt = { id: 'in_1', trigger: 'manual', urls: ['https://example.com/page'], createdAt: '2026-09-30T00:00:00.000Z', updatedAt: '2026-09-30T00:00:00.000Z', attempts: 1 }
const connected = { _tag: 'connected', host: 'example.com', keyLocation: 'https://example.com/abc12345.txt', verifiedAt: '2026-09-30T00:00:00.000Z' }
describe('indexNow wire boundary', () => {
  it('rejects a connection response that exposes the key', () => {
    expect(indexNowConnectionV1Schema.safeParse({ _tag: 'verification-required', host: 'example.com', keyLocation: 'https://example.com/key.txt', reason: null, automaticSending: { _tag: 'off' }, key: 'abc12345' }).success).toBe(false)
  })
  it('rejects an accepted receipt with pending verification', () => {
    expect(indexNowSubmissionReceiptV1Schema.safeParse({ ...receipt, _tag: 'accepted', httpStatus: 202, reason: 'key-validation-pending', retryAt: null }).success).toBe(false)
  })
  it('parses pending receipt as key validation pending', () => {
    const value = { ...receipt, _tag: 'pending', httpStatus: 202, reason: 'key-validation-pending', retryAt: null }
    expect(indexNowSubmissionReceiptV1Schema.parse(value)).toEqual(value)
  })
  it('rejects batches beyond the hosted limit', () => {
    expect(indexNowSubmitV1Schema.safeParse({ urls: Array.from({ length: 1001 }).fill(receipt.urls[0]), idempotencyKey: 'request1' }).success).toBe(false)
  })
})

describe('indexNow automatic sending wire boundary', () => {
  it('requires the producer to state automatic sending on a stored key', () => {
    expect(indexNowConnectionV1Schema.safeParse(connected).success).toBe(false)
    expect(indexNowConnectionV1Schema.parse({ ...connected, automaticSending: { _tag: 'off' } })).toEqual({ ...connected, automaticSending: { _tag: 'off' } })
  })

  it('reads an older host connection as automatic sending off', () => {
    expect(indexNowConnectionV1Schemas.client.parse(connected)).toEqual({ ...connected, automaticSending: { _tag: 'off' } })
  })

  it('carries the last automatic check and why it left URLs unsent', () => {
    const automaticSending = {
      _tag: 'on',
      since: '2026-11-18T00:00:00.000Z',
      lastCheck: { checkedAt: '2026-11-19T00:00:00.000Z', changedUrls: 900, sentUrls: 500, completeness: { _tag: 'truncated', reasons: ['daily-limit'] } },
    }
    expect(indexNowConnectionV1Schema.parse({ ...connected, automaticSending })).toEqual({ ...connected, automaticSending })
    expect(indexNowConnectionV1Schema.safeParse({ ...connected, automaticSending: { ...automaticSending, lastCheck: { ...automaticSending.lastCheck, completeness: { _tag: 'truncated', reasons: [] } } } }).success).toBe(false)
  })

  it('marks an automatic Submission apart from a manual one', () => {
    const automatic = { ...receipt, trigger: 'automatic', _tag: 'accepted', httpStatus: 200, reason: null, retryAt: null }
    expect(indexNowSubmissionReceiptV1Schema.parse(automatic)).toEqual(automatic)
    expect(indexNowSubmissionReceiptV1Schema.safeParse({ ...automatic, trigger: 'scheduled' }).success).toBe(false)
  })

  it('reads an older host receipt as manual', () => {
    const { trigger: _trigger, ...older } = { ...receipt, _tag: 'accepted', httpStatus: 200, reason: null, retryAt: null }
    expect(indexNowSubmissionReceiptV1Schemas.client.parse(older)).toMatchObject({ trigger: 'manual' })
    expect(indexNowSubmissionReceiptV1Schema.safeParse(older).success).toBe(false)
  })

  it('accepts only on or off for the switch', () => {
    expect(indexNowAutomaticSendingUpdateV1Schema.parse({ automaticSending: 'on' })).toEqual({ automaticSending: 'on' })
    expect(indexNowAutomaticSendingUpdateV1Schema.safeParse({ automaticSending: true }).success).toBe(false)
    expect(indexNowAutomaticSendingUpdateV1Schema.safeParse({ automaticSending: 'on', urls: [] }).success).toBe(false)
  })
})

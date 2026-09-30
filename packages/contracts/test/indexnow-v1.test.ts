import { indexNowConnectionV1Schema, indexNowSubmissionReceiptV1Schema, indexNowSubmitV1Schema } from '@gscdump/contracts/v1'
import { describe, expect, it } from 'vitest'

const receipt = { id: 'in_1', urls: ['https://example.com/page'], createdAt: '2026-09-30T00:00:00.000Z', updatedAt: '2026-09-30T00:00:00.000Z', attempts: 1 }
describe('indexNow wire boundary', () => {
  it('rejects a connection response that exposes the key', () => {
    expect(indexNowConnectionV1Schema.safeParse({ _tag: 'verification-required', host: 'example.com', keyLocation: 'https://example.com/key.txt', reason: null, key: 'abc12345' }).success).toBe(false)
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

import { googleSubmissionReceiptV1Schemas, googleSubmitV1Schema, indexingApiGrantV1Schemas, parseGoogleSubmissionRefusal, siteIndexingApiGrantV1Schemas } from '@gscdump/contracts/v1'
import { describe, expect, it } from 'vitest'

const receipt = { id: 'gi_1', url: 'https://example.com/jobs/1', createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z', attempts: 1 }

describe('google Indexing API wire boundary', () => {
  it('accepts one URL per Submission and refuses a batch', () => {
    expect(googleSubmitV1Schema.safeParse({ url: receipt.url, idempotencyKey: 'request1' }).success).toBe(true)
    expect(googleSubmitV1Schema.safeParse({ urls: [receipt.url], idempotencyKey: 'request1' }).success).toBe(false)
  })
  it('refuses a URL that is not http or https', () => {
    expect(googleSubmitV1Schema.safeParse({ url: 'ftp://example.com/jobs/1', idempotencyKey: 'request1' }).success).toBe(false)
  })
  it('refuses a grant response that exposes the refresh token', () => {
    expect(indexingApiGrantV1Schemas.producer.safeParse({ _tag: 'granted', googleEmail: null, grantedAt: receipt.createdAt, refreshToken: 'secret' }).success).toBe(false)
  })
  it('refuses an accepted receipt that carries a rejection reason', () => {
    expect(googleSubmissionReceiptV1Schemas.producer.safeParse({ ...receipt, _tag: 'accepted', httpStatus: 200, reason: 'not-owner' }).success).toBe(false)
  })
  it('refuses a rejection reason the contract does not name', () => {
    expect(googleSubmissionReceiptV1Schemas.producer.safeParse({ ...receipt, _tag: 'rejected', httpStatus: 403, reason: 'forbidden' }).success).toBe(false)
  })
  it('reads a grant refusal with no Google response as rejected', () => {
    const value = { ...receipt, _tag: 'rejected', httpStatus: null, reason: 'reauthorization-required' }
    expect(googleSubmissionReceiptV1Schemas.producer.parse(value)).toEqual(value)
  })
  it('lets a client read a receipt from a newer host', () => {
    expect(googleSubmissionReceiptV1Schemas.client.safeParse({ ...receipt, _tag: 'accepted', httpStatus: 200, reason: null, newField: 1 }).success).toBe(true)
  })
  it('reads the daily limit from refusal details', () => {
    expect(parseGoogleSubmissionRefusal({ reason: 'site_daily_limit', limit: 5, resetsAt: '2026-10-02T07:00:00.000Z' })).toEqual({ reason: 'site_daily_limit', limit: 5, resetsAt: '2026-10-02T07:00:00.000Z' })
  })
  it('returns null for a refusal that is not a Google Submission refusal', () => {
    expect(parseGoogleSubmissionRefusal({ reason: 'site_allowance', limit: 3 })).toBeNull()
    expect(parseGoogleSubmissionRefusal(null)).toBeNull()
  })
})

describe('site Indexing API grant wire boundary', () => {
  it('names a granted Site without the grantor\'s Google account', () => {
    expect(siteIndexingApiGrantV1Schemas.producer.parse({ _tag: 'granted', grantedAt: '2026-10-01T00:00:00.000Z' })).toEqual({ _tag: 'granted', grantedAt: '2026-10-01T00:00:00.000Z' })
    expect(siteIndexingApiGrantV1Schemas.producer.safeParse({ _tag: 'granted', grantedAt: '2026-10-01T00:00:00.000Z', googleEmail: 'owner@example.com' }).success).toBe(false)
    expect(siteIndexingApiGrantV1Schemas.producer.safeParse({ _tag: 'reauthorization-required', googleEmail: 'owner@example.com' }).success).toBe(false)
  })
  it('reads a partner without a usable Indexing API client as unavailable', () => {
    expect(siteIndexingApiGrantV1Schemas.producer.parse({ _tag: 'unavailable' })).toEqual({ _tag: 'unavailable' })
  })
  it('lets a client read a grant state from a newer host', () => {
    expect(siteIndexingApiGrantV1Schemas.client.safeParse({ _tag: 'missing', newField: 1 }).success).toBe(true)
  })
})

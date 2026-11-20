import { googleReceiptListQueryV1Schema, indexNowReceiptListQueryV1Schema, submissionOutcomesQueryV1Schema, submissionOutcomesV1Schemas, submissionSummaryV1Schemas } from '@gscdump/contracts/v1'
import { describe, expect, it } from 'vitest'

const window = { days: 30, from: '2026-10-19T00:00:00.000Z', to: '2026-11-18T00:00:00.000Z' }
const summary = {
  window,
  indexNow: { submissions: 2, urls: 12, urlsByState: { queued: 0, accepted: 11, pending: 0, rejected: 0, retrying: 0, failed: 1 }, urlsByTrigger: { manual: 1, automatic: 11 } },
  google: { submissions: 1, byState: { accepted: 1, rejected: 0, failed: 0 } },
}
const submission = { channel: 'indexnow', receiptId: 'in_1', state: 'accepted', trigger: 'automatic', submittedAt: '2026-11-10T00:00:00.000Z' }
const inspection = { inspectedAt: '2026-11-12T00:00:00.000Z', verdict: 'PASS', coverageState: 'indexed', lastCrawledAt: '2026-11-09T00:00:00.000Z' }
const page = { total: 1, limit: 25, offset: 0, hasMore: false }

describe('submission summary wire boundary', () => {
  it('parses counts by channel, state, and trigger', () => {
    expect(submissionSummaryV1Schemas.producer.parse(summary)).toEqual(summary)
  })

  it('refuses a producer state the contract does not name, and a client keeps it', () => {
    const extra = { ...summary, google: { ...summary.google, byState: { ...summary.google.byState, sending: 1 } } }
    expect(submissionSummaryV1Schemas.producer.safeParse(extra).success).toBe(false)
    expect(submissionSummaryV1Schemas.client.parse(extra).google.byState).toMatchObject({ sending: 1 })
  })
})

describe('submission outcomes wire boundary', () => {
  it('counts an IndexNow 202 (pending) send as received, and refuses unreceived states', () => {
    const row = (state: string) => ({ window, outcomes: [{ url: 'https://example.com/new', submission: { ...submission, state }, google: { _tag: 'never-inspected' } }], pagination: page })
    expect(submissionOutcomesV1Schemas.producer.parse(row('pending')).outcomes[0]?.submission.state).toBe('pending')
    expect(submissionOutcomesV1Schemas.client.parse(row('pending')).outcomes[0]?.submission.state).toBe('pending')
    expect(submissionOutcomesV1Schemas.producer.safeParse(row('failed')).success).toBe(false)
  })

  it('keeps the receipt and the later Google inspection as separate clocks', () => {
    const value = { window, outcomes: [{ url: 'https://example.com/new', submission, google: { _tag: 'inspected-after', ...inspection } }], pagination: page }
    expect(submissionOutcomesV1Schemas.producer.parse(value)).toEqual(value)
  })

  it('carries no inspection fields for a URL Google was never inspected for', () => {
    const value = { window, outcomes: [{ url: 'https://example.com/new', submission, google: { _tag: 'never-inspected', ...inspection } }], pagination: page }
    expect(submissionOutcomesV1Schemas.producer.safeParse(value).success).toBe(false)
  })

  it('reads a coverage state a newer host adds as unrecognized', () => {
    const value = { window, outcomes: [{ url: 'https://example.com/new', submission, google: { _tag: 'not-inspected-since', ...inspection, coverageState: 'future_state' } }], pagination: page }
    expect(submissionOutcomesV1Schemas.client.parse(value).outcomes[0]?.google).toMatchObject({ coverageState: 'unrecognized' })
  })

  it('bounds a page, because each page reads stored inspections once', () => {
    expect(submissionOutcomesQueryV1Schema.parse({})).toEqual({ days: 30, limit: 25, offset: 0 })
    expect(submissionOutcomesQueryV1Schema.safeParse({ limit: 51 }).success).toBe(false)
    expect(submissionOutcomesQueryV1Schema.safeParse({ days: 91 }).success).toBe(false)
  })
})

describe('receipt list filters', () => {
  it('filters IndexNow receipts by state, trigger, since, and URL', () => {
    const query = { state: 'accepted', trigger: 'automatic', since: '2026-11-01T00:00:00.000Z', url: 'https://example.com/new' }
    expect(indexNowReceiptListQueryV1Schema.parse(query)).toEqual({ ...query, limit: 25, offset: 0 })
  })

  it('has no trigger filter for Google receipts, which are always manual', () => {
    expect(googleReceiptListQueryV1Schema.safeParse({ trigger: 'manual' }).success).toBe(false)
    expect(googleReceiptListQueryV1Schema.safeParse({ state: 'pending' }).success).toBe(false)
    expect(googleReceiptListQueryV1Schema.parse({ state: 'rejected' })).toMatchObject({ state: 'rejected' })
  })
})

import { parseRecordReadRefusal } from '@gscdump/contracts'
import { createGscdumpV1Protocol } from '@gscdump/contracts/v1'
import { describe, expect, it } from 'vitest'

const { queryRows } = createGscdumpV1Protocol().surfaces.analytics.operations

function envelope(details: Record<string, unknown>) {
  return { error: { code: 'invalid_request', message: 'The record for this Site is not readable yet. Try again in a few minutes.', requestId: 'req_01', retryable: false, details } }
}

describe('record read refusals', () => {
  it.each([
    { reason: 'record_not_ready' },
    { reason: 'record_not_ready', syncStatus: 'synced', lastSyncAt: 1790824592, oldestDateSynced: '2025-05-30', newestDateSynced: '2026-09-29' },
    { reason: 'range_not_synced', missingStart: '2026-08-01', missingEnd: '2026-08-31', syncStatus: 'syncing' },
  ])('reads %o from an analytics.rows.query error envelope', (details) => {
    const parsed = queryRows.errorResponse.client.parse(envelope(details))
    expect(parseRecordReadRefusal(parsed.error.details)).toEqual(details)
  })

  it('drops detail keys a newer host adds', () => {
    expect(parseRecordReadRefusal({ reason: 'record_not_ready', retryAfterSeconds: 60 })).toEqual({ reason: 'record_not_ready' })
  })

  it.each([
    ['an entitlement refusal', { reason: 'site_held', hold: 'size_limit' }],
    ['a missing range without its days', { reason: 'range_not_synced' }],
    ['a missing day that is not a date', { reason: 'range_not_synced', missingStart: 'last week', missingEnd: '2026-08-31' }],
    ['empty details', {}],
  ])('returns null for %s', (_, details) => {
    expect(parseRecordReadRefusal(details)).toBeNull()
  })
})

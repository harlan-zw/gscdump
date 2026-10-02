import { createGscdumpV1Protocol } from '@gscdump/contracts/v1'
import { describe, expect, it } from 'vitest'

const { producer, client } = createGscdumpV1Protocol().surfaces.partner.operations.deleteUser.responses[200]

function deleteResponse(fields: Record<string, unknown>): unknown {
  return {
    data: { ok: true, queued: true, userId: 1, publicId: 'u_01', ...fields },
    meta: { requestId: 'req_01', surface: 'partner', version: '1.0' },
  }
}

describe('search Console grant on partner.users.delete', () => {
  it.each([
    { _tag: 'revoked' },
    { _tag: 'already-invalid' },
    { _tag: 'not-revoked', reason: 'no-token' },
    { _tag: 'not-revoked', reason: 'other-client' },
    { _tag: 'not-revoked', reason: 'unknown-cloud-project' },
    { _tag: 'not-revoked', reason: 'shared-cloud-project' },
    { _tag: 'revoke-failed', reason: 'google_http_503' },
    { _tag: 'revoke-failed', reason: 'token_decrypt: bad key' },
  ])('lets the host report $_tag $reason', (searchConsoleGrant) => {
    const parsed = producer.parse(deleteResponse({ searchConsoleGrant }))
    expect(parsed.data.searchConsoleGrant).toEqual(searchConsoleGrant)
  })

  it('reads a delete response from a host that does not report the grant', () => {
    const parsed = client.parse(deleteResponse({}))
    expect(parsed.data.searchConsoleGrant).toBeUndefined()
  })

  it.each([
    ['a kept grant without a reason', { _tag: 'not-revoked' }],
    ['a kept grant with a reason the contract does not name', { _tag: 'not-revoked', reason: 'partner_issued' }],
    ['a failed revoke without a reason', { _tag: 'revoke-failed' }],
    ['a failed revoke with an empty reason', { _tag: 'revoke-failed', reason: '' }],
    ['a revoked grant that carries a reason', { _tag: 'revoked', reason: 'no-token' }],
    ['an outcome tag the contract does not name', { _tag: 'kept' }],
  ])('refuses %s', (_label, searchConsoleGrant) => {
    expect(producer.safeParse(deleteResponse({ searchConsoleGrant })).success).toBe(false)
  })
})

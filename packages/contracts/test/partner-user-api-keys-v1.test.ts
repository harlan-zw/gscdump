import { createGscdumpV1Protocol, defineHttpOperation } from '@gscdump/contracts/v1'
import { createGscdumpV1Paths } from '@gscdump/contracts/v1/paths'
import { describe, expect, it } from 'vitest'

const meta = { requestId: 'req_api_keys', surface: 'partner', version: '1.0' } as const

describe('partner user API keys v1', () => {
  it('registers create, list, and revoke on the user API key routes', () => {
    const { createUserApiKey, listUserApiKeys, revokeUserApiKey } = createGscdumpV1Protocol().surfaces.partner.operations

    expect([createUserApiKey.id, createUserApiKey.method, createUserApiKey.path]).toEqual([
      'partner.users.api_keys.create',
      'POST',
      '/users/{userId}/api-keys',
    ])
    expect([listUserApiKeys.id, listUserApiKeys.method, listUserApiKeys.path]).toEqual([
      'partner.users.api_keys.list',
      'GET',
      '/users/{userId}/api-keys',
    ])
    expect([revokeUserApiKey.id, revokeUserApiKey.method, revokeUserApiKey.path]).toEqual([
      'partner.users.api_keys.revoke',
      'DELETE',
      '/users/{userId}/api-keys/{keyId}',
    ])
    expect(Object.keys(createUserApiKey.responses)).toEqual(['201'])
    expect(createUserApiKey.semantics).toMatchObject({ idempotent: false, retry: 'never' })
    for (const operation of [createUserApiKey, listUserApiKeys, revokeUserApiKey]) {
      expect(operation.auth.credentials).toEqual(['partner_key'])
      expect(operation.auth.ownership).toEqual([{ credential: 'partner_key', rule: 'linked_user' }])
    }
  })

  it('builds a percent-encoded revoke path from the route catalog', () => {
    const paths = createGscdumpV1Paths()
    expect(paths.path('partner.users.api_keys.revoke', { userId: 'u_01', keyId: 'ak_01' }))
      .toBe('/api/partner/v1/users/u_01/api-keys/ak_01')
  })

  it('trims labels and rejects empty, long, or extra request fields', () => {
    const body = createGscdumpV1Protocol().surfaces.partner.operations.createUserApiKey.request.body

    expect(body.parse({ label: '  Laptop CLI  ' })).toEqual({ label: 'Laptop CLI' })
    expect(body.parse({ label: 'x'.repeat(64) }).label).toHaveLength(64)
    expect(() => body.parse({ label: '   ' })).toThrow()
    expect(() => body.parse({ label: 'x'.repeat(65) })).toThrow()
    expect(() => body.parse({ label: 'CLI', apiKey: 'gsd_user_abc' })).toThrow()
  })

  it('returns the raw key only from create and never from list', () => {
    const { createUserApiKey, listUserApiKeys } = createGscdumpV1Protocol().surfaces.partner.operations
    const created = { keyId: 'ak_01', apiKey: 'gsd_user_abc123', preview: 'gsd_user_abc...c123', label: 'CLI', createdAt: 1789516800 }

    expect(createUserApiKey.responses[201].producer.parse({ data: created, meta }).data.apiKey).toBe('gsd_user_abc123')
    expect(() => createUserApiKey.responses[201].producer.parse({ data: { ...created, apiKey: 'gsd_prod_abc123' }, meta })).toThrow()
    expect(() => createUserApiKey.responses[201].producer.parse({ data: { ...created, keyId: 'u_01' }, meta })).toThrow()

    const listed = { keyId: 'ak_01', preview: 'gsd_user_abc...c123', label: 'CLI', createdAt: 1789516800, lastUsedAt: null }
    expect(listUserApiKeys.responses[200].producer.parse({ data: { keys: [listed] }, meta }).data.keys).toEqual([listed])
    expect(() => listUserApiKeys.responses[200].producer.parse({ data: { keys: [{ ...listed, apiKey: 'gsd_user_abc123' }] }, meta })).toThrow()
  })

  it('declares the limit and unknown-key errors on the operations that raise them', () => {
    const { createUserApiKey, listUserApiKeys, revokeUserApiKey } = createGscdumpV1Protocol().surfaces.partner.operations
    const error = (code: string) => ({ error: { code, message: 'x', requestId: 'req_01', retryable: false, details: {} } })

    expect(createUserApiKey.errorResponse.producer.parse(error('api_key_limit_reached'))).toBeTruthy()
    expect(() => listUserApiKeys.errorResponse.producer.parse(error('api_key_limit_reached'))).toThrow()
    expect(revokeUserApiKey.errorResponse.producer.parse(error('api_key_not_found'))).toBeTruthy()
    expect(() => createUserApiKey.errorResponse.producer.parse(error('api_key_not_found'))).toThrow()
  })

  it('accepts snake_case operation ID segments but rejects malformed ones', () => {
    const operation = createGscdumpV1Protocol().surfaces.partner.operations.listUserApiKeys

    for (const id of ['partner.users.api__keys.list', 'partner.users._keys.list', 'partner.users.keys_.list', 'partner.Users.list'])
      expect(() => defineHttpOperation({ ...operation, id } as typeof operation)).toThrow(/stable dotted lowercase identifier/)
  })
})

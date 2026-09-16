import { createGscdumpV1Client, isGscdumpV1Error } from '@gscdump/sdk/v1'
import { describe, expect, it, vi } from 'vitest'

const meta = { requestId: 'req_api_keys', surface: 'partner', version: '1.0' }

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

describe('partner user API keys v1 client', () => {
  it('creates an API key with a trimmed label and accepts the 201 response', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async (request, init) => {
      expect(request).toBe('/api/_gscdump/partner/v1/users/u_01/api-keys')
      expect(init?.method).toBe('POST')
      expect(JSON.parse(String(init?.body))).toEqual({ label: 'Laptop CLI' })
      return json({
        data: { keyId: 'ak_01', apiKey: 'gsd_user_abc123', preview: 'gsd_user_abc...c123', label: 'Laptop CLI', createdAt: 1789516800 },
        meta,
      }, 201)
    })
    const client = createGscdumpV1Client({ apiRoot: '/api/_gscdump', credential: 'secret', fetch })

    await expect(client.createUserApiKey({ params: { userId: 'u_01' }, body: { label: ' Laptop CLI ' } }))
      .resolves
      .toMatchObject({ data: { keyId: 'ak_01', apiKey: 'gsd_user_abc123' } })
  })

  it('does not retry a create that the server rejected at the key limit', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => json({
      error: { code: 'api_key_limit_reached', message: 'Limit reached', requestId: 'req_01', retryable: false, details: {} },
    }, 409))
    const client = createGscdumpV1Client({ apiRoot: '/api/_gscdump', credential: 'secret', fetch })

    const error = await client.createUserApiKey({ params: { userId: 'u_01' }, body: { label: 'CLI' } }).catch((cause: unknown) => cause)
    expect(isGscdumpV1Error(error) && error.code).toBe('api_key_limit_reached')
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('lists API keys without raw key material', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async (request, init) => {
      expect(request).toBe('/api/_gscdump/partner/v1/users/u_01/api-keys')
      expect(init?.method).toBe('GET')
      return json({
        data: { keys: [{ keyId: 'ak_01', preview: 'gsd_user_abc...c123', label: 'CLI', createdAt: 1789516800, lastUsedAt: 1789520400 }] },
        meta,
      })
    })
    const client = createGscdumpV1Client({ apiRoot: '/api/_gscdump', credential: 'secret', fetch })

    const response = await client.listUserApiKeys({ params: { userId: 'u_01' } })
    expect(response.data.keys).toEqual([{ keyId: 'ak_01', preview: 'gsd_user_abc...c123', label: 'CLI', createdAt: 1789516800, lastUsedAt: 1789520400 }])
  })

  it('revokes an API key by id and surfaces an unknown key as api_key_not_found', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async (request, init) => {
      expect(request).toBe('/api/_gscdump/partner/v1/users/u_01/api-keys/ak_01')
      expect(init?.method).toBe('DELETE')
      expect(init?.body).toBeUndefined()
      return json({ data: { ok: true, keyId: 'ak_01' }, meta })
    })
    const client = createGscdumpV1Client({ apiRoot: '/api/_gscdump', credential: 'secret', fetch })

    await expect(client.revokeUserApiKey({ params: { userId: 'u_01', keyId: 'ak_01' } }))
      .resolves
      .toMatchObject({ data: { ok: true, keyId: 'ak_01' } })

    fetch.mockImplementation(async () => json({
      error: { code: 'api_key_not_found', message: 'Not found', requestId: 'req_02', retryable: false, details: {} },
    }, 404))
    const error = await client.revokeUserApiKey({ params: { userId: 'u_01', keyId: 'ak_01' } }).catch((cause: unknown) => cause)
    expect(isGscdumpV1Error(error) && [error.code, error.status]).toEqual(['api_key_not_found', 404])
  })
})

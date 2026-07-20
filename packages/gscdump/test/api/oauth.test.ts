import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  exchangeAuthCodeResult,
  GscApiError,
  introspectAccessToken,
  introspectAccessTokenResult,
  revokeOAuthToken,
  revokeOAuthTokenResult,
} from '../../src'

afterEach(() => {
  vi.unstubAllGlobals()
})

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

describe('oauth token lifecycle helpers', () => {
  it('retains the granted scope from an authorization-code exchange', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({
      access_token: 'access-token',
      expires_in: 3600,
      refresh_token: 'refresh-token',
      scope: 'openid https://www.googleapis.com/auth/webmasters',
    }))
    vi.stubGlobal('fetch', fetchMock)

    const result = await exchangeAuthCodeResult('code', 'client', 'secret', 'https://example.com/callback')

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value).toMatchObject({
        accessToken: 'access-token',
        refreshToken: 'refresh-token',
        scope: 'openid https://www.googleapis.com/auth/webmasters',
      })
      expect(result.value).not.toHaveProperty('refresh_token')
    }
  })

  it('normalizes access-token introspection fields', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({
      issued_to: 'client-id',
      aud: 'audience',
      azp: 'authorized-party',
      user_id: 'user-id',
      sub: 'subject',
      scope: 'scope:a scope:b',
      expires_in: '120',
      exp: '1784500000',
      email: 'dev@example.com',
      email_verified: 'true',
      access_type: 'offline',
    }))
    vi.stubGlobal('fetch', fetchMock)

    const result = await introspectAccessTokenResult('token with spaces')

    expect(result).toEqual({
      ok: true,
      value: {
        issuedTo: 'client-id',
        audience: 'audience',
        authorizedParty: 'authorized-party',
        userId: 'user-id',
        subject: 'subject',
        scope: 'scope:a scope:b',
        expiresIn: 120,
        expiresAt: 1784500000,
        email: 'dev@example.com',
        emailVerified: true,
        accessType: 'offline',
      },
    })
    expect(fetchMock).toHaveBeenCalledWith(
      'https://oauth2.googleapis.com/tokeninfo?access_token=token%20with%20spaces',
      expect.objectContaining({ method: 'GET', signal: expect.any(AbortSignal) }),
    )
  })

  it('classifies an invalid introspection token and preserves GscApiError in the throwing wrapper', async () => {
    const invalid = () => jsonResponse({ error: 'invalid_token', error_description: 'Token is invalid' }, 400)
    const fetchMock = vi.fn().mockImplementation(async () => invalid())
    vi.stubGlobal('fetch', fetchMock)

    const result = await introspectAccessTokenResult('bad-token')
    expect(result.ok).toBe(false)
    if (!result.ok)
      expect(result.error.kind).toBe('auth-expired')

    const thrown = await introspectAccessToken('bad-token').catch(error => error)
    expect(thrown).toBeInstanceOf(GscApiError)
    expect((thrown as GscApiError).info).toMatchObject({ code: 400, reason: 'invalid_token' })
  })

  it('revokes access or refresh tokens with form encoding', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(revokeOAuthTokenResult('refresh-token')).resolves.toEqual({ ok: true, value: undefined })
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(fetchMock.mock.calls[0]?.[0]).toBe('https://oauth2.googleapis.com/revoke')
    expect(init.method).toBe('POST')
    expect(init.body).toBeInstanceOf(URLSearchParams)
    expect((init.body as URLSearchParams).get('token')).toBe('refresh-token')
  })

  it('classifies revocation server failures as transport errors in both API styles', async () => {
    const unavailable = () => jsonResponse({
      error: { code: 503, message: 'Unavailable', status: 'UNAVAILABLE' },
    }, 503)
    const fetchMock = vi.fn().mockImplementation(async () => unavailable())
    vi.stubGlobal('fetch', fetchMock)

    const result = await revokeOAuthTokenResult('token')
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.kind).toBe('transport')
      expect(result.error.kind === 'transport' && result.error.status).toBe(503)
    }

    const thrown = await revokeOAuthToken('token').catch(error => error)
    expect(thrown).toBeInstanceOf(GscApiError)
    expect((thrown as GscApiError).info).toMatchObject({ code: 503, status: 'UNAVAILABLE' })
  })
})

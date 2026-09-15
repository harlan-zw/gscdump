import { describe, expect, it, vi } from 'vitest'
import { loginWithPlatform, refreshWithPlatform } from '../src/hosted-auth'

const response = (value: unknown) => new Response(JSON.stringify(value))

describe('free CLI authentication', () => {
  it('polls once authorized, using only the trusted platform origin', async () => {
    const request = vi.fn()
      .mockResolvedValueOnce(response({ code: 'A'.repeat(20), expiresIn: 600, authUrl: 'https://evil.example/' }))
      .mockResolvedValueOnce(response({ status: 'pending' }))
      .mockResolvedValueOnce(response({ status: 'complete', tokens: { accessToken: 'access', refreshToken: 'refresh', expiresAt: 1800000000000 } }))
    const authorize = vi.fn()
    const tokens = await loginWithPlatform({ request, authorize, wait: async () => {}, now: () => 0 })
    expect(authorize).toHaveBeenCalledWith(`https://gscdump.com/app/cli/auth?code=${'A'.repeat(20)}`)
    expect(tokens).toEqual({ provider: 'gscdump', access_token: 'access', refresh_token: 'refresh', expiry_date: 1800000000000 })
    expect(request.mock.calls.map(([url]) => new URL(url).origin)).toEqual(Array.from({ length: 3 }).fill('https://gscdump.com'))
  })

  it('refreshes through the platform without following redirects', async () => {
    const request = vi.fn().mockResolvedValue(response({ accessToken: 'next', expiresAt: 1800000000000 }))
    const result = await refreshWithPlatform('refresh', request)
    expect(result).toEqual({ access_token: 'next', expiry_date: 1800000000000 })
    expect(request).toHaveBeenCalledWith('https://gscdump.com/api/cli/auth/refresh', expect.objectContaining({
      redirect: 'error',
      body: JSON.stringify({ refreshToken: 'refresh' }),
    }))
  })

  it('rejects malformed tokens before they enter storage', async () => {
    const request = vi.fn()
      .mockResolvedValueOnce(response({ code: 'A'.repeat(20), expiresIn: 600 }))
      .mockResolvedValueOnce(response({ status: 'complete', tokens: { accessToken: 'access' } }))
    await expect(loginWithPlatform({ request, authorize: async () => {}, wait: async () => {}, now: () => 0 })).rejects.toThrow()
  })

  it('stops waiting after the authorization expires', async () => {
    let now = 0
    const request = vi.fn().mockResolvedValue(response({ code: 'A'.repeat(20), expiresIn: 1 }))
    await expect(loginWithPlatform({ request, authorize: async () => {
      now = 2000
    }, wait: async () => {}, now: () => now })).rejects.toThrow('expired')
    expect(request).toHaveBeenCalledTimes(1)
  })

  it('does not expose a server error body containing tokens', async () => {
    const request = vi.fn().mockResolvedValue(new Response('secret-token', { status: 401 }))
    await expect(refreshWithPlatform('refresh', request)).rejects.toThrow('Run `gscdump auth login --mode local --force`')
  })
})

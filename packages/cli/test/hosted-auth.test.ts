import { describe, expect, it, vi } from 'vitest'
import { loginWithHostedSession } from '../src/hosted-auth'

const response = (value: unknown) => new Response(JSON.stringify(value))

describe('hosted login', () => {
  it('links Hosted mode in the browser without receiving Google tokens or an API key', async () => {
    const sessionId = 'a'.repeat(64)
    const request = vi.fn()
      .mockResolvedValueOnce(response({ code: `S-${'A'.repeat(20)}`, expiresIn: 600, authUrl: 'https://evil.example/' }))
      .mockResolvedValueOnce(response({ status: 'pending' }))
      .mockResolvedValueOnce(response({ status: 'complete', sessionId }))
    const authorize = vi.fn()
    await expect(loginWithHostedSession({ request, authorize, wait: async () => {}, now: () => 0 })).resolves.toBe(sessionId)
    expect(authorize).toHaveBeenCalledWith(`https://gscdump.com/app/cli/auth?code=S-${'A'.repeat(20)}`)
    expect(request.mock.calls.map(([url]) => new URL(url).origin)).toEqual(Array.from({ length: 3 }).fill('https://gscdump.com'))
    expect(request.mock.calls.map(([url]) => new URL(url).pathname)).not.toContain('/api/cli/auth/refresh')
  })

  it('rejects a Google token response from an old host', async () => {
    const request = vi.fn()
      .mockResolvedValueOnce(response({ code: 'A'.repeat(20), expiresIn: 600 }))
    await expect(loginWithHostedSession({ request, authorize: async () => {}, wait: async () => {}, now: () => 0 })).rejects.toThrow()
  })

  it('stops waiting after the authorization expires', async () => {
    let now = 0
    const request = vi.fn()
      .mockResolvedValueOnce(response({ code: `S-${'A'.repeat(20)}`, expiresIn: 1 }))
    await expect(loginWithHostedSession({ request, authorize: async () => {
      now = 2000
    }, wait: async () => {}, now: () => now })).rejects.toThrow('expired')
    expect(request).toHaveBeenCalledTimes(1)
  })

  it('points Hosted login failures at the Hosted login command', async () => {
    const request = vi.fn().mockResolvedValue(new Response('forbidden', { status: 403 }))
    const error = await loginWithHostedSession({ request, authorize: async () => {}, wait: async () => {}, now: () => 0 }).then(() => null, (error: unknown) => error as Error)
    expect(error).toBeInstanceOf(Error)
    expect(error!.message).toContain('`gscdump auth login --mode hosted`')
  })
})

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

  it('retries transient poll errors with backoff and sends userAgent on poll', async () => {
    const sessionId = 'b'.repeat(64)
    const waits: number[] = []
    const request = vi.fn()
      .mockResolvedValueOnce(response({ code: `S-${'B'.repeat(20)}`, expiresIn: 600 }))
      .mockRejectedValueOnce(new TypeError('network blip'))
      .mockResolvedValueOnce(new Response('unavailable', { status: 503 }))
      .mockResolvedValueOnce(response({ status: 'complete', sessionId }))
    const result = await loginWithHostedSession({
      request,
      authorize: async () => {},
      wait: async ms => void waits.push(ms),
      now: () => 0,
      userAgent: 'gscdump-cli/7.23.2 (linux devbox)',
    })
    expect(result).toBe(sessionId)
    expect(waits).toEqual([4000, 6000])
    const pollUrl = new URL(request.mock.calls[3]![0] as string)
    expect(pollUrl.searchParams.get('userAgent')).toBe('gscdump-cli/7.23.2 (linux devbox)')
  })

  it('stops after repeated transient poll failures', async () => {
    const request = vi.fn()
      .mockResolvedValueOnce(response({ code: `S-${'C'.repeat(20)}`, expiresIn: 600 }))
      .mockResolvedValue(new Response('busy', { status: 503 }))
    await expect(loginWithHostedSession({
      request,
      authorize: async () => {},
      wait: async () => {},
      now: () => 0,
    })).rejects.toThrow('temporarily unavailable')
    expect(request).toHaveBeenCalledTimes(6)
  })

  it('never retries 403 login_cancelled responses', async () => {
    const request = vi.fn()
      .mockResolvedValueOnce(response({ code: `S-${'D'.repeat(20)}`, expiresIn: 600 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: { details: { reason: 'login_cancelled' } } }), { status: 403 }))
    await expect(loginWithHostedSession({
      request,
      authorize: async () => {},
      wait: async () => {},
      now: () => 0,
    })).rejects.toThrow('cancelled')
    expect(request).toHaveBeenCalledTimes(2)
  })

  it('retries 429 and malformed 200 JSON responses without overshooting the deadline', async () => {
    const sessionId = 'e'.repeat(64)
    let now = 0
    const waits: number[] = []
    const request = vi.fn()
      .mockResolvedValueOnce(response({ code: `S-${'E'.repeat(20)}`, expiresIn: 20 }))
      .mockResolvedValueOnce(new Response('rate limited', { status: 429 }))
      .mockResolvedValueOnce(new Response('<html>gateway</html>', { status: 200 }))
      .mockResolvedValueOnce(response({ status: 'complete', sessionId }))
    const result = await loginWithHostedSession({
      request,
      authorize: async () => {},
      wait: async (ms) => {
        waits.push(ms)
        now += ms
      },
      now: () => now,
    })
    expect(result).toBe(sessionId)
    expect(waits).toEqual([4000, 6000])

    let capNow = 0
    const capWaits: number[] = []
    const capRequest = vi.fn()
      .mockResolvedValueOnce(response({ code: `S-${'F'.repeat(20)}`, expiresIn: 5 }))
      .mockResolvedValue(new Response('rate limited', { status: 429 }))
    await expect(loginWithHostedSession({
      request: capRequest,
      authorize: async () => {},
      wait: async (ms) => {
        capWaits.push(ms)
        capNow += ms
      },
      now: () => capNow,
    })).rejects.toThrow('expired')
    expect(capWaits).toEqual([4000, 1000])
  })
})

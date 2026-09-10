import { describe, expect, it, vi } from 'vitest'
import { bingWebmaster } from '../../src/bing'

describe('bing API key authentication', () => {
  it('lists sites through the API key endpoint without a bearer token', async () => {
    const fetch = vi.fn(async () => Response.json({ d: [] }))
    const result = await bingWebmaster({ apiKey: 'key&with=symbols', fetch }).getUserSites()
    expect(result).toEqual({ ok: true, value: [] })
    const [input, init] = fetch.mock.calls[0] as unknown as [string, RequestInit]
    const url = new URL(input)
    expect(url.origin).toBe('https://ssl.bing.com')
    expect(url.searchParams.get('apikey')).toBe('key&with=symbols')
    expect(new Headers(init.headers).has('authorization')).toBe(false)
  })

  it('rejects an empty key before making a request', async () => {
    const fetch = vi.fn()
    expect(await bingWebmaster({ apiKey: ' ', fetch }).getUserSites())
      .toEqual({ ok: false, error: { _tag: 'AuthenticationRequired' } })
    expect(fetch).not.toHaveBeenCalled()
  })

  it('resolves OAuth credentials for each request', async () => {
    let token = 'first-token'
    const fetch = vi.fn(async (_input: string, init?: RequestInit) => {
      expect(new Headers(init?.headers).get('authorization')).toBe(`Bearer ${token}`)
      return Response.json({ d: [] })
    })
    const client = bingWebmaster({ accessToken: async () => token, fetch })
    await client.getUserSites()
    token = 'refreshed-token'
    await client.getUserSites()
    expect(fetch).toHaveBeenCalledTimes(2)
  })
})

import type { FetchOptions } from 'ofetch'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { googleSearchConsole } from '../src'

afterEach(() => {
  vi.unstubAllGlobals()
})

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Retry-After': '0' },
  })
}

describe('google client fetch options', () => {
  it.each([
    { 'x-project': 'custom' },
    new Headers({ 'x-project': 'custom' }),
    [['x-project', 'custom']] as [string, string][],
  ])('sends custom headers with authentication: %j', async (headers) => {
    const fetch = vi.fn().mockImplementation(async () => jsonResponse({ siteEntry: [] }))
    vi.stubGlobal('fetch', fetch)

    await googleSearchConsole('test-token', { fetchOptions: { headers } }).sites()

    const sent = new Headers(fetch.mock.calls[0]![1].headers)
    expect(sent.get('x-project')).toBe('custom')
    expect(sent.get('Authorization')).toBe('Bearer test-token')
    expect(sent.get('Accept-Encoding')).toBe('gzip')
  })

  it.each([false, true])('awaits request hooks after authentication, array=%s', async (array) => {
    const fetch = vi.fn().mockImplementation(async () => jsonResponse({ siteEntry: [] }))
    vi.stubGlobal('fetch', fetch)
    const hook: NonNullable<FetchOptions['onRequest']> = async ({ options }) => {
      await Promise.resolve()
      options.headers.set('x-auth-observed', options.headers.get('Authorization') ?? 'missing')
    }
    const onRequest = array
      ? [hook, ({ options }: Parameters<typeof hook>[0]) => options.headers.set('x-second-hook', options.headers.get('x-auth-observed')!)]
      : hook

    await googleSearchConsole('test-token', { fetchOptions: { onRequest } }).sites()

    const sent = new Headers(fetch.mock.calls[0]![1].headers)
    expect(sent.get('x-auth-observed')).toBe('Bearer test-token')
    if (array)
      expect(sent.get('x-second-hook')).toBe('Bearer test-token')
  })

  it.each([0, false])('honors retry=%s', async (retry) => {
    const fetch = vi.fn().mockImplementation(async () => jsonResponse({}, 503))
    vi.stubGlobal('fetch', fetch)

    await expect(googleSearchConsole('test-token', { fetchOptions: { retry } }).sites()).rejects.toThrow('503')

    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('keeps default retries when optional settings are undefined', async () => {
    const fetch = vi.fn().mockImplementation(async () => jsonResponse({}, 503))
    vi.stubGlobal('fetch', fetch)

    await expect(googleSearchConsole('test-token', {
      fetchOptions: { retry: undefined, retryDelay: undefined, retryStatusCodes: undefined },
    }).sites()).rejects.toThrow('503')

    expect(fetch).toHaveBeenCalledTimes(4)
  })

  it('propagates request hook failures before sending', async () => {
    const fetch = vi.fn()
    vi.stubGlobal('fetch', fetch)
    const failure = new Error('request hook failed')

    await expect(googleSearchConsole('test-token', {
      fetchOptions: { onRequest: async () => { throw failure } },
    }).sites()).rejects.toBe(failure)

    expect(fetch).not.toHaveBeenCalled()
  })

  it('honors custom retry status codes and delays', async () => {
    const fetch = vi.fn()
      .mockImplementationOnce(async () => jsonResponse({}, 418))
      .mockImplementationOnce(async () => jsonResponse({ siteEntry: [{ siteUrl: 'sc-domain:example.com' }] }))
    vi.stubGlobal('fetch', fetch)
    const retryDelay = vi.fn(() => 0)

    const sites = await googleSearchConsole('test-token', {
      fetchOptions: { retry: 1, retryStatusCodes: [418], retryDelay },
    }).sites()

    expect(sites).toEqual([{ siteUrl: 'sc-domain:example.com' }])
    expect(fetch).toHaveBeenCalledTimes(2)
    expect(retryDelay).toHaveBeenCalledOnce()
  })
})

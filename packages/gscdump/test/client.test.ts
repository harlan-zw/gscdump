import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createFetch, googleSearchConsole } from '../src'

// Mock ofetch
const { mockFetch: _mockFetch, createSpy, ofetchSpy } = vi.hoisted(() => {
  const mockFetch = vi.fn() as any
  const createSpy = vi.fn((_options?: any) => mockFetch)
  const ofetchSpy = vi.fn() as any
  ofetchSpy.create = (options: any) => createSpy(options)
  return { mockFetch, createSpy, ofetchSpy }
})

vi.mock('ofetch', () => ({
  ofetch: ofetchSpy,
}))

describe('createGscFetch', () => {
  it('should create a fetcher with authorization header logic', async () => {
    createFetch('test-token')
    const options = createSpy.mock.calls[createSpy.mock.calls.length - 1][0] as any
    expect(options.onRequest).toBeDefined()

    // Test that onRequest sets the header
    const reqCtx = { options: { headers: new Headers() } }
    await options.onRequest(reqCtx)
    expect(reqCtx.options.headers.get('Authorization')).toBe('Bearer test-token')
  })

  it('should resolve dynamic tokens from getAccessToken', async () => {
    const mockAuth = {
      getAccessToken: vi.fn().mockResolvedValue({ token: 'dynamic-token' }),
    }
    createFetch(mockAuth)
    const options = createSpy.mock.calls[createSpy.mock.calls.length - 1][0] as any

    const reqCtx = { options: { headers: new Headers() } }
    await options.onRequest(reqCtx)
    expect(reqCtx.options.headers.get('Authorization')).toBe('Bearer dynamic-token')
    expect(mockAuth.getAccessToken).toHaveBeenCalled()
  })

  it('should resolve token from OAuth2Client-like object', async () => {
    const mockAuthClient = {
      credentials: {
        access_token: 'oauth-token',
      },
      // mimicking OAuth2Client which has this method but we might use credentials directly if present
      getAccessToken: vi.fn(),
    }
    createFetch(mockAuthClient)
    const options = createSpy.mock.calls[createSpy.mock.calls.length - 1][0] as any

    const reqCtx = { options: { headers: new Headers() } }
    // Our logic prioritizes getAccessToken if present, let's verify that behavior or adjust test expectation
    // Looking at implementation:
    // if ('getAccessToken' in auth && typeof auth.getAccessToken === 'function') -> uses getAccessToken
    // So distinct from 'credentials' check which is fallback.
    // Let's make getAccessToken return empty or something to force fallback?
    // Actually, real OAuth2Client has getAccessToken() that refreshes if needed.
    // The previous implementation of resolveToken checked getAccessToken BEFORE credentials.
    // So if getAccessToken exists, it is used.

    // Let's test that getAccessToken IS used if present
    mockAuthClient.getAccessToken.mockResolvedValue({ token: 'refreshed-token' })

    await options.onRequest(reqCtx)
    expect(reqCtx.options.headers.get('Authorization')).toBe('Bearer refreshed-token')
  })

  it('should fallback to credentials if getAccessToken is missing/not function', async () => {
    const mockAuthClient = {
      credentials: {
        access_token: 'credential-token',
      },
      // no getAccessToken
    } as any
    createFetch(mockAuthClient)
    const options = createSpy.mock.calls[createSpy.mock.calls.length - 1][0] as any

    const reqCtx = { options: { headers: new Headers() } }
    await options.onRequest(reqCtx)
    expect(reqCtx.options.headers.get('Authorization')).toBe('Bearer credential-token')
  })

  // 'without auth' test is no longer valid as TS enforces auth
  // We can remove it or test logic if we bypass TS, but better to remove behavior test if signature forbids it.

  it('should have error handler for 403', async () => {
    createFetch('test-token')
    const options = createSpy.mock.calls[createSpy.mock.calls.length - 1][0] as any
    expect(options.onResponseError).toBeDefined()

    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => { })
    await options.onResponseError({ response: { status: 403 } })
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Permission denied'))
    consoleSpy.mockRestore()
  })
})

describe('googleSearchConsole', () => {
  it('should create a client with methods', () => {
    const client = googleSearchConsole('test-token')
    expect(client.sites).toBeDefined()
    expect(client.query).toBeDefined()
  })

  // Removed 'create client without auth' test

  it('should accept custom fetch implementation', async () => {
    const customFetch = vi.fn().mockResolvedValue({ siteEntry: [] })
    const client = googleSearchConsole('dummy', { fetch: customFetch as any })
    await client.sites()
    expect(customFetch).toHaveBeenCalledWith('https://searchconsole.googleapis.com/webmasters/v3/sites', { signal: undefined })
  })

  it('preserves `sc-domain:` literal prefix when encoding siteUrl', async () => {
    const customFetch = vi.fn().mockResolvedValue({ permissionLevel: 'siteOwner', siteUrl: 'sc-domain:example.com' })
    const client = googleSearchConsole('dummy', { fetch: customFetch as any })
    await client.sites.get('sc-domain:example.com')
    expect(customFetch).toHaveBeenCalledWith(
      'https://searchconsole.googleapis.com/webmasters/v3/sites/sc-domain:example.com',
      { signal: undefined },
    )
  })

  it('percent-encodes URL-prefix siteUrls', async () => {
    const customFetch = vi.fn().mockResolvedValue({})
    const client = googleSearchConsole('dummy', { fetch: customFetch as any })
    await client.sites.delete('https://example.com/')
    expect(customFetch).toHaveBeenCalledWith(
      'https://searchconsole.googleapis.com/webmasters/v3/sites/https%3A%2F%2Fexample.com%2F',
      { method: 'DELETE', signal: undefined },
    )
  })

  it('sitemaps.list passes sitemapIndex query param when provided', async () => {
    const customFetch = vi.fn().mockResolvedValue({ sitemap: [] })
    const client = googleSearchConsole('dummy', { fetch: customFetch as any })
    await client.sitemaps.list('sc-domain:example.com', { sitemapIndex: 'https://example.com/sitemap_index.xml' })
    expect(customFetch).toHaveBeenCalledWith(
      'https://searchconsole.googleapis.com/webmasters/v3/sites/sc-domain:example.com/sitemaps',
      { signal: undefined, query: { sitemapIndex: 'https://example.com/sitemap_index.xml' } },
    )
  })

  it('sitemaps.list omits query entirely when sitemapIndex not provided', async () => {
    const customFetch = vi.fn().mockResolvedValue({ sitemap: [] })
    const client = googleSearchConsole('dummy', { fetch: customFetch as any })
    await client.sitemaps.list('sc-domain:example.com')
    expect(customFetch).toHaveBeenCalledWith(
      'https://searchconsole.googleapis.com/webmasters/v3/sites/sc-domain:example.com/sitemaps',
      { signal: undefined, query: undefined },
    )
  })

  it('inspect includes languageCode in body when provided', async () => {
    const customFetch = vi.fn().mockResolvedValue({ inspectionResult: {} })
    const client = googleSearchConsole('dummy', { fetch: customFetch as any })
    await client.inspect('sc-domain:example.com', 'https://example.com/p', { languageCode: 'de-CH' })
    expect(customFetch).toHaveBeenCalledWith(
      'https://searchconsole.googleapis.com/v1/urlInspection/index:inspect',
      {
        method: 'POST',
        body: { inspectionUrl: 'https://example.com/p', siteUrl: 'sc-domain:example.com', languageCode: 'de-CH' },
        signal: undefined,
      },
    )
  })

  it('inspect omits languageCode from body when not provided', async () => {
    const customFetch = vi.fn().mockResolvedValue({ inspectionResult: {} })
    const client = googleSearchConsole('dummy', { fetch: customFetch as any })
    await client.inspect('sc-domain:example.com', 'https://example.com/p')
    const body = customFetch.mock.calls[0][1].body
    expect(body).not.toHaveProperty('languageCode')
  })

  it('should call onRateLimited on 429', async () => {
    const onRateLimited = vi.fn()
    const _client = googleSearchConsole('test-token', { onRateLimited })
    // We can't trigger 429 easily because createGscFetch is mocked
    // Ideally we should test the interceptor logic, but since we mock `ofetch.create` returning a mock fetch,
    // we can't inspect the 'onResponseError' logic passed to create easily without peeking into calls again.

    // Let's verify that createGscFetch was called with an onResponseError that chains correctly.
    const createCalls = createSpy.mock.calls
    const lastCallArgs = createCalls[createCalls.length - 1][0] as any
    expect(lastCallArgs.onResponseError).toBeDefined()

    // Manually invoke the wrapped handler to verify it calls onRateLimited
    await lastCallArgs.onResponseError({ response: { status: 429 } })
    expect(onRateLimited).toHaveBeenCalled()
  })
})

describe('createGscAuth', () => {
  const mockDate = 1000000000000
  beforeEach(() => {
    vi.setSystemTime(mockDate)
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('should create an auth client with credentials', async () => {
    const { createAuth } = await import('../src')
    const auth = createAuth({
      clientId: 'cid',
      clientSecret: 'csec',
      refreshToken: 'rtoken',
    })
    expect(auth.credentials?.refresh_token).toBe('rtoken')
    expect(auth.getAccessToken).toBeDefined()
  })

  it('should refresh token if expired or missing', async () => {
    const { createAuth } = await import('../src')
    const auth = createAuth({
      clientId: 'cid',
      clientSecret: 'csec',
      refreshToken: 'rtoken',
    })

    const mockTokenResponse = { access_token: 'new-access-token', expires_in: 3600 }
    ofetchSpy.mockResolvedValue(mockTokenResponse)

    // First call - no token, should refresh
    const r1 = await auth.getAccessToken()
    expect(r1.token).toBe('new-access-token')
    expect(ofetchSpy).toHaveBeenCalledWith('https://oauth2.googleapis.com/token', expect.objectContaining({
      method: 'POST',
      body: expect.any(URLSearchParams),
    }))
    const body = (ofetchSpy.mock.calls[0]![1] as { body: URLSearchParams }).body
    expect(body.get('client_id')).toBe('cid')
    expect(body.get('client_secret')).toBe('csec')
    expect(body.get('refresh_token')).toBe('rtoken')
    expect(body.get('grant_type')).toBe('refresh_token')

    // Check credentials updated
    expect(auth.credentials?.access_token).toBe('new-access-token')
    // expiry is now + 3600s
    expect(auth.credentials?.expiry_date).toBe(mockDate + 3600 * 1000)

    // Second call - valid token, no refresh
    ofetchSpy.mockClear()
    const r2 = await auth.getAccessToken()
    expect(r2.token).toBe('new-access-token')
    expect(ofetchSpy).not.toHaveBeenCalled()

    // Advance time to expire token
    vi.setSystemTime(mockDate + 3600 * 1000 + 1)
    ofetchSpy.mockResolvedValue({ access_token: 'refreshed-again', expires_in: 3600 })

    const r3 = await auth.getAccessToken()
    expect(r3.token).toBe('refreshed-again')
    expect(ofetchSpy).toHaveBeenCalled()
  })
})

describe('createGscFetch integration', () => {
  // Re-importing inside test context seems cleaner for isolation but not strictly necessary effectively
  // reusing logic from previous suite

  it('should auto-wrap GscAuthOptions into client', async () => {
    // We assume createGscFetch internally calls createGscAuth
    // We can spy on createGscAuth export in client.ts? Not easy if it's same file internal usage.
    // However, we can test that headers are set correctly using ONLY options, which implies internal wrapping worked.

    // reset mocks from previous usage
    createSpy.mockClear()

    const optionsAuth = {
      clientId: 'cid',
      clientSecret: 'csec',
      refreshToken: 'rtoken',
    }

    // We need createGscAuth to make an API call to get the INITIAL token?
    // Start of createGscAuth does NOT fetch token immediately. It lazy fetches on first getAccessToken call.
    // createGscFetch creates ofetch instance with onRequest.
    // onRequest calls resolveToken -> auth.getAccessToken() -> fetches.

    // So we mock the token endpoint response
    ofetchSpy.mockResolvedValue({ access_token: 'auto-wrapped-token', expires_in: 3600 })

    createFetch(optionsAuth)
    const options = createSpy.mock.calls[createSpy.mock.calls.length - 1][0] as any
    const reqCtx = { options: { headers: new Headers() } }

    await options.onRequest(reqCtx)

    expect(reqCtx.options.headers.get('Authorization')).toBe('Bearer auto-wrapped-token')
  })
})

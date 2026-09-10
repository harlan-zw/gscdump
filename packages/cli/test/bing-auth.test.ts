import type { CliRuntime } from '../src/runtime'
import fs from 'node:fs/promises'
import { createServer, request } from 'node:http'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { runCommand } from 'citty'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { clearBingCredentials, getBingClient, loginBingOAuth, saveBingCredentials } from '../src/bing-auth'
import { bingCommand } from '../src/commands/bing'
import { createCliRuntime, runWithCliRuntime } from '../src/runtime'

const realFetch = globalThis.fetch.bind(globalThis)
const siteUrl = 'https://example.com/'
const oauthClient = { clientId: 'registered-client', clientSecret: 'private-client-secret' }
const validToken = { access_token: 'new-access-token', refresh_token: 'new-refresh-token', expires_in: 3600 }

async function loopbackUri() {
  const server = createServer()
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (!address || typeof address === 'string')
    throw new Error('The test needs a loopback port.')
  await new Promise<void>((resolve) => {
    server.close(() => resolve())
  })
  return `http://127.0.0.1:${address.port}/oauth/bing`
}

describe('local Bing authentication', () => {
  let runtime: CliRuntime
  let root: string
  let tokenReplies: Response[]
  let siteReplies: Response[]
  let exchanges: URLSearchParams[]
  let apiRequests: { url: URL, headers: Headers }[]

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'gscdump-bing-auth-'))
    runtime = createCliRuntime({ configDir: path.join(root, 'personal'), environment: {} })
    tokenReplies = [Response.json(validToken)]
    siteReplies = []
    exchanges = []
    apiRequests = []
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : input)
      if (url.toString() === 'https://www.bing.com/webmasters/oauth/token') {
        exchanges.push(new URLSearchParams(String(init?.body)))
        const reply = tokenReplies.shift()
        if (!reply)
          throw new Error('Unexpected token request.')
        return reply
      }
      if (['www.bing.com', 'ssl.bing.com'].includes(url.hostname) && url.pathname.endsWith('/GetUserSites')) {
        apiRequests.push({ url, headers: new Headers(init?.headers) })
        return siteReplies.shift() ?? Response.json({ d: [{ Url: siteUrl, IsVerified: true }] })
      }
      throw new Error(`Unexpected HTTP request: ${url.origin}${url.pathname}`)
    }))
  })

  afterEach(async () => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    await fs.rm(root, { recursive: true, force: true })
  })

  function within<T>(run: () => T, selected = runtime) {
    return runWithCliRuntime(selected, run)
  }

  async function startLogin(options: {
    callback?: (callback: URL, authorize: URL) => Promise<void>
    timeoutMs?: number
  } = {}) {
    const redirectUri = await loopbackUri()
    await within(() => loginBingOAuth({
      ...oauthClient,
      redirectUri,
      timeoutMs: options.timeoutMs ?? 1000,
      async openUrl(url) {
        const authorize = new URL(url)
        const callback = new URL(authorize.searchParams.get('redirect_uri')!)
        callback.searchParams.set('state', authorize.searchParams.get('state')!)
        callback.searchParams.set('code', 'consented-code')
        if (options.callback)
          await options.callback(callback, authorize)
        else
          await realFetch(callback).then(response => response.text())
      },
    }))
    return redirectUri
  }

  async function querySites(selected = runtime) {
    return within(async () => (await getBingClient()).getUserSites(), selected)
  }

  async function seedWorkingCredentials() {
    await within(() => saveBingCredentials({ _tag: 'ApiKey', apiKey: 'working-api-key' }))
  }

  async function expectWorkingCredentials() {
    expect(await querySites()).toMatchObject({ ok: true, value: [{ url: siteUrl }] })
    expect(apiRequests.at(-1)!.url.searchParams.get('apikey')).toBe('working-api-key')
  }

  it.each([3600, '3600'])('saves browser consent and reuses its token with expires_in %s', async (expiresIn) => {
    tokenReplies = [Response.json({ ...validToken, expires_in: expiresIn })]
    let authorize: URL | undefined
    const redirectUri = await startLogin({
      async callback(callback, url) {
        authorize = url
        const response = await realFetch(callback)
        expect(response.status).toBe(200)
        expect(response.headers.get('cache-control')).toBe('no-store')
        await response.text()
      },
    })

    expect(await querySites()).toMatchObject({ ok: true, value: [{ url: siteUrl, isVerified: true }] })
    expect(exchanges.map(exchange => Object.fromEntries(exchange))).toEqual([{
      client_id: oauthClient.clientId,
      client_secret: oauthClient.clientSecret,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code',
      code: 'consented-code',
    }])
    expect(authorize!.searchParams.get('client_secret')).toBeNull()
    expect(authorize!.searchParams.get('scope')).toBe('webmaster.manage')
    expect(apiRequests.map(request => request.headers.get('authorization'))).toEqual([
      'Bearer new-access-token',
      'Bearer new-access-token',
    ])
    await expect(realFetch(redirectUri)).rejects.toThrow()
  })

  it.each(['missing', 'mismatch', 'duplicate'])('rejects %s state without consuming consent', async (state) => {
    await startLogin({
      async callback(callback) {
        const invalid = new URL(callback)
        if (state === 'missing')
          invalid.searchParams.delete('state')
        else if (state === 'mismatch')
          invalid.searchParams.set('state', 'unrelated-state')
        else
          invalid.searchParams.append('state', 'unrelated-state')
        const response = await realFetch(invalid)
        await response.text()
        expect(response.status).toBe(400)
        expect(exchanges).toEqual([])
        await realFetch(callback).then(response => response.text())
      },
    })

    expect(await querySites()).toMatchObject({ ok: true })
    expect(exchanges.map(exchange => exchange.get('code'))).toEqual(['consented-code'])
  })

  it.each(['wrong-path', 'wrong-method', 'missing-code', 'duplicate-code', 'duplicate-error', 'code-and-error'])('ignores %s before valid consent', async (kind) => {
    await startLogin({
      async callback(callback) {
        const invalid = new URL(callback)
        if (kind === 'wrong-path')
          invalid.pathname = '/favicon.ico'
        if (kind === 'duplicate-code')
          invalid.searchParams.append('code', 'unrelated-code')
        if (kind === 'missing-code' || kind === 'duplicate-error')
          invalid.searchParams.delete('code')
        if (kind === 'code-and-error' || kind === 'duplicate-error')
          invalid.searchParams.set('error', 'access_denied')
        if (kind === 'duplicate-error')
          invalid.searchParams.append('error', 'server_error')
        const response = await realFetch(invalid, { method: kind === 'wrong-method' ? 'POST' : 'GET' })
        await response.text()
        expect(response.status).toBeGreaterThanOrEqual(400)
        expect(exchanges).toEqual([])
        await realFetch(callback).then(response => response.text())
      },
    })

    expect(exchanges.map(exchange => exchange.get('code'))).toEqual(['consented-code'])
  })

  it('rejects a malformed raw request URL and still accepts browser consent', async () => {
    await startLogin({
      async callback(callback) {
        const status = await new Promise<number | undefined>((resolve, reject) => {
          const req = request({ hostname: '127.0.0.1', port: callback.port, path: 'http://[' }, (response) => {
            response.resume()
            response.once('end', () => resolve(response.statusCode))
          })
          req.once('error', reject)
          req.end()
        })
        expect(status).toBe(400)
        expect(exchanges).toEqual([])
        await realFetch(callback).then(response => response.text())
      },
    })

    expect(await querySites()).toMatchObject({ ok: true })
    expect(exchanges.map(exchange => exchange.get('code'))).toEqual(['consented-code'])
  })

  it('preserves working credentials after browser denial and omits provider error text', async () => {
    await seedWorkingCredentials()
    await expect(startLogin({
      async callback(callback) {
        callback.searchParams.delete('code')
        callback.searchParams.set('error', 'access_denied')
        callback.searchParams.set('error_description', 'private-provider-error')
        const response = await realFetch(callback)
        expect(response.status).toBe(400)
        expect(await response.text()).not.toContain('private-provider-error')
      },
    })).rejects.toThrow('Bing authorization failed')

    expect(exchanges).toEqual([])
    await expectWorkingCredentials()
  })

  it('preserves working credentials after a timeout and closes the listener', async () => {
    await seedWorkingCredentials()
    let callbackUrl: URL | undefined
    await expect(startLogin({
      timeoutMs: 50,
      async callback(callback) { callbackUrl = callback },
    })).rejects.toThrow('timed out')

    expect(exchanges).toEqual([])
    await expectWorkingCredentials()
    await expect(realFetch(callbackUrl!)).rejects.toThrow()
  })

  it('preserves working credentials when token exchange fails', async () => {
    await seedWorkingCredentials()
    tokenReplies = [Response.json({ error: 'private-exchange-error' }, { status: 401 })]

    await expect(startLogin()).rejects.toThrow('Bing token request failed (401)')
    await expectWorkingCredentials()
  })

  it('preserves working credentials when Bing rejects the exchanged token', async () => {
    await seedWorkingCredentials()
    siteReplies = [Response.json({ ErrorCode: 2 }, { status: 401 })]

    await expect(startLogin()).rejects.toThrow('Bing login failed')
    await expectWorkingCredentials()
  })

  it.each([
    ['empty access token', { ...validToken, access_token: ' ' }],
    ['non-string access token', { ...validToken, access_token: 42 }],
    ['zero expiry', { ...validToken, expires_in: 0 }],
    ['negative expiry', { ...validToken, expires_in: -10 }],
    ['fractional expiry', { ...validToken, expires_in: 1.5 }],
    ['invalid expiry string', { ...validToken, expires_in: '3600seconds' }],
    ['excessive expiry', { ...validToken, expires_in: 31_536_001 }],
    ['empty refresh token', { ...validToken, refresh_token: '' }],
  ])('rejects %s and preserves working credentials', async (_, token) => {
    await seedWorkingCredentials()
    tokenReplies = [Response.json(token)]

    await expect(startLogin()).rejects.toThrow('invalid OAuth token')
    await expectWorkingCredentials()
  })

  it('requires a refresh token for initial consent and preserves working credentials', async () => {
    await seedWorkingCredentials()
    tokenReplies = [Response.json({ access_token: 'temporary-access', expires_in: 3600 })]

    await expect(startLogin()).rejects.toThrow('did not return a refresh token')
    await expectWorkingCredentials()
  })

  it('rejects malformed token JSON without revealing its body or replacing credentials', async () => {
    await seedWorkingCredentials()
    tokenReplies = [new Response('private-provider-token is not JSON', { headers: { 'Content-Type': 'application/json' } })]

    const login = startLogin()
    await expect(login).rejects.toThrow('invalid OAuth token')
    await expect(login).rejects.not.toThrow('private-pr')
    await expectWorkingCredentials()
  })

  it('preserves the refresh token after a failed refresh so the next command can retry', async () => {
    await within(() => saveBingCredentials({
      _tag: 'OAuth',
      ...oauthClient,
      redirectUri: 'http://127.0.0.1:53683/oauth/bing',
      accessToken: 'expired-access',
      refreshToken: 'original-refresh',
      expiresAt: Date.now() - 1,
    }))
    tokenReplies = [
      Response.json({ error: 'temporarily_unavailable' }, { status: 503 }),
      Response.json(validToken),
    ]

    await expect(querySites()).rejects.toThrow('Bing token request failed (503)')
    expect(await querySites()).toMatchObject({ ok: true })
    expect(exchanges.map(exchange => exchange.get('refresh_token'))).toEqual(['original-refresh', 'original-refresh'])
    expect(apiRequests.map(request => request.headers.get('authorization'))).toEqual(['Bearer new-access-token'])
  })

  it.each([
    'https://127.0.0.1:53683/oauth/bing',
    'http://0.0.0.0:53683/oauth/bing',
    'http://remote.example:53683/oauth/bing',
    'http://127.0.0.1/oauth/bing',
    'http://user:secret@127.0.0.1:53683/oauth/bing',
    'http://127.0.0.1:53683/oauth/bing?existing=query',
    'http://127.0.0.1:53683/oauth/bing#fragment',
  ])('rejects an unsafe callback before opening consent: %s', async (redirectUri) => {
    const openUrl = vi.fn()

    await expect(within(() => loginBingOAuth({ ...oauthClient, redirectUri, openUrl }))).rejects.toThrow('loopback redirect URI')
    expect(openUrl).not.toHaveBeenCalled()
    expect(exchanges).toEqual([])
  })

  it.each([true, false])('refreshes expired credentials and retains the refresh token when rotation is %s', async (rotate) => {
    let now = Date.now()
    vi.spyOn(Date, 'now').mockImplementation(() => now)
    await within(() => saveBingCredentials({
      _tag: 'OAuth',
      ...oauthClient,
      redirectUri: 'http://127.0.0.1:53683/oauth/bing',
      accessToken: 'expired-access',
      refreshToken: 'original-refresh',
      expiresAt: now - 1,
    }))
    tokenReplies = [
      Response.json({ access_token: 'refreshed-access', expires_in: 3600, ...(rotate ? { refresh_token: 'rotated-refresh' } : {}) }),
      Response.json({ access_token: 'second-access', expires_in: 3600 }),
    ]

    expect(await querySites()).toMatchObject({ ok: true })
    expect(await querySites()).toMatchObject({ ok: true })
    expect(exchanges.map(exchange => exchange.get('refresh_token'))).toEqual(['original-refresh'])
    now += 3_600_000
    expect(await querySites()).toMatchObject({ ok: true })

    expect(exchanges.map(exchange => exchange.get('grant_type'))).toEqual(['refresh_token', 'refresh_token'])
    expect(exchanges.map(exchange => exchange.get('refresh_token'))).toEqual([
      'original-refresh',
      rotate ? 'rotated-refresh' : 'original-refresh',
    ])
    expect(apiRequests.map(request => request.headers.get('authorization'))).toEqual([
      'Bearer refreshed-access',
      'Bearer refreshed-access',
      'Bearer second-access',
    ])
  })

  it('keeps credentials isolated by profile and clears only the selected profile', async () => {
    const other = createCliRuntime({ configDir: path.join(root, 'work'), environment: {} })
    await seedWorkingCredentials()
    await within(() => saveBingCredentials({ _tag: 'ApiKey', apiKey: 'work-api-key' }), other)

    await querySites()
    await querySites(other)
    expect(apiRequests.map(request => request.url.searchParams.get('apikey'))).toEqual(['working-api-key', 'work-api-key'])
    await within(clearBingCredentials, other)
    await expect(querySites(other)).rejects.toThrow('Bing credentials are missing')
    await expectWorkingCredentials()
  })

  it.each([
    ['BING_API_KEY', 'environment-api-key'],
    ['BING_ACCESS_TOKEN', 'environment-access-token'],
  ])('uses %s without replacing saved credentials', async (name, value) => {
    await seedWorkingCredentials()
    runtime.environment[name] = value

    expect(await querySites()).toMatchObject({ ok: true })
    if (name === 'BING_API_KEY')
      expect(apiRequests.at(-1)!.url.searchParams.get('apikey')).toBe(value)
    else
      expect(apiRequests.at(-1)!.headers.get('authorization')).toBe(`Bearer ${value}`)
    delete runtime.environment[name]
    await expectWorkingCredentials()
  })

  it('reports OAuth status without returning saved secrets', async () => {
    await startLogin()
    const output: string[] = []
    vi.spyOn(console, 'log').mockImplementation((...args) => output.push(args.join(' ')))

    await within(() => runCommand(bingCommand, { rawArgs: ['status', '--json'] }))

    expect(JSON.parse(output.at(-1)!)).toMatchObject({ searchEngine: 'bing', authenticated: true, verifiedSites: 1 })
    for (const secret of [oauthClient.clientSecret, validToken.access_token, validToken.refresh_token])
      expect(output.join('\n')).not.toContain(secret)
  })

  it.skipIf(process.platform === 'win32')('stores renewed credentials with owner-only permissions', async () => {
    await seedWorkingCredentials()
    const filename = path.join(runtime.configDir, 'bing-tokens.json')
    await fs.chmod(filename, 0o644)

    await startLogin()

    expect((await fs.stat(filename)).mode & 0o777).toBe(0o600)
    expect((await fs.stat(runtime.configDir)).mode & 0o777).toBe(0o700)
    expect(await querySites()).toMatchObject({ ok: true })
  })
})

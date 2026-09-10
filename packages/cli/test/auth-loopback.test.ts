import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import { request } from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { stripVTControlCharacters } from 'node:util'
import { OAuth2Client } from 'google-auth-library'
import open from 'open'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { authenticate, loadTokens } from '../src/auth'
import { setConfigDir } from '../src/config'

vi.mock('open', () => ({ default: vi.fn().mockResolvedValue(undefined) }))
vi.mock('ofetch', () => ({ ofetch: vi.fn().mockRejectedValue(new Error('Unexpected device flow')) }))

const credentials = { clientId: 'test-client', clientSecret: 'test-secret' }
const tokens = { access_token: 'test-access-token', refresh_token: 'test-refresh-token' }

describe('loopback OAuth', () => {
  let configDir: string
  let output: string[]

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    configDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gscdump-loopback-'))
    setConfigDir(configDir)
    output = []
    vi.spyOn(console, 'log').mockImplementation((...args) => output.push(args.join(' ')))
    vi.spyOn(OAuth2Client.prototype, 'getToken').mockResolvedValue({ tokens, res: null } as never)
    vi.mocked(open).mockClear()
  })

  afterEach(async () => {
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000)
    vi.useRealTimers()
    vi.restoreAllMocks()
    await fs.rm(configDir, { recursive: true, force: true })
  })

  async function start(noBrowser = false) {
    const result = authenticate(credentials, true, { force: true, noBrowser })
      .then(client => ({ client, error: null }), error => ({ client: null, error }))
    let url: URL | undefined
    await vi.waitFor(() => {
      const printedUrl = stripVTControlCharacters(output.join('\n')).match(/https:\/\/accounts\.google\.com\/\S+/)
      expect(printedUrl, output.join('\n')).not.toBeNull()
      url = new URL(printedUrl![0])
    }, { timeout: 1000 })
    const callback = new URL(url!.searchParams.get('redirect_uri')!)
    callback.searchParams.set('state', url!.searchParams.get('state') ?? '')
    callback.searchParams.set('code', 'authorized-code')
    return { url: url!, callback, result }
  }

  it('binds the token exchange to the state and S256 challenge', async () => {
    const { url, callback, result } = await start()
    const response = await fetch(callback)
    const page = await response.text()
    const { client, error } = await result
    const exchange = vi.mocked(OAuth2Client.prototype.getToken).mock.calls[0]?.[0]

    expect(response.status).toBe(200)
    expect(page).toMatch(/Authorization successful/i)
    expect(error).toBeNull()
    expect(client?.credentials).toEqual(tokens)
    expect(await loadTokens()).toEqual(tokens)
    expect(url.searchParams.get('state')).toMatch(/^[\w-]{43,}$/)
    expect(url.searchParams.get('code_challenge_method')).toBe('S256')
    expect(exchange).toMatchObject({ code: 'authorized-code', redirect_uri: callback.origin })
    const verifier = (exchange as { codeVerifier: string }).codeVerifier
    expect(verifier).toMatch(/^[\w-]{43,128}$/)
    expect(url.searchParams.get('code_challenge')).toBe(createHash('sha256').update(verifier).digest('base64url'))
    expect(open).toHaveBeenCalledWith(url.toString())
  })

  it.each(['missing', 'mismatch', 'duplicate'])('rejects %s state and waits for the valid callback', async (state) => {
    const { callback, result } = await start()
    const invalid = new URL(callback)
    if (state === 'missing')
      invalid.searchParams.delete('state')
    else if (state === 'mismatch')
      invalid.searchParams.set('state', 'other-request')
    else
      invalid.searchParams.append('state', 'other-request')
    const rejected = await fetch(invalid)
    await rejected.text()
    const prematureExchanges = vi.mocked(OAuth2Client.prototype.getToken).mock.calls.length
    await fetch(callback).then(response => response.text(), error => String(error))
    const completed = await result

    expect(rejected.status).toBe(400)
    expect(prematureExchanges).toBe(0)
    expect(completed.client?.credentials).toEqual(tokens)
    expect(OAuth2Client.prototype.getToken).toHaveBeenCalledTimes(1)
  })

  it('reports denial without exchanging or saving tokens', async () => {
    const { callback, result } = await start()
    callback.searchParams.delete('code')
    callback.searchParams.set('error', 'access_denied')
    const response = await fetch(callback)
    const page = await response.text()
    const completed = await result

    expect(response.status).toBe(400)
    expect(page).toContain('Authorization denied')
    expect(completed.error).toMatchObject({ authError: { kind: 'oauth-denied' } })
    expect(OAuth2Client.prototype.getToken).not.toHaveBeenCalled()
    expect(await loadTokens()).toBeNull()
  })

  it.each(['missing-code', 'duplicate-code', 'code-and-error', 'wrong-path', 'wrong-method'])('ignores %s before a valid callback', async (invalidResponse) => {
    const { callback, result } = await start()
    const invalid = new URL(callback)
    if (invalidResponse === 'missing-code')
      invalid.searchParams.delete('code')
    if (invalidResponse === 'duplicate-code')
      invalid.searchParams.append('code', 'second-code')
    if (invalidResponse === 'code-and-error')
      invalid.searchParams.set('error', 'access_denied')
    if (invalidResponse === 'wrong-path')
      invalid.pathname = '/favicon.ico'
    const response = await fetch(invalid, { method: invalidResponse === 'wrong-method' ? 'POST' : 'GET' })
    await response.text()
    const prematureExchanges = vi.mocked(OAuth2Client.prototype.getToken).mock.calls.length
    await fetch(callback).then(response => response.text())
    const completed = await result

    expect(response.status).toBeGreaterThanOrEqual(400)
    expect(prematureExchanges).toBe(0)
    expect(completed.client?.credentials).toEqual(tokens)
    expect(OAuth2Client.prototype.getToken).toHaveBeenCalledTimes(1)
  })

  it('times out without saving tokens or leaving the listener open', async () => {
    const { callback, result } = await start()
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000)
    const completed = await result

    expect(completed.error).toMatchObject({ authError: { kind: 'oauth-timed-out' } })
    expect(OAuth2Client.prototype.getToken).not.toHaveBeenCalled()
    expect(await loadTokens()).toBeNull()
    await expect(fetch(callback)).rejects.toThrow()
  })

  it('rejects a malformed request URL without terminating login', async () => {
    const { callback, result } = await start()
    const status = await new Promise<number | undefined>((resolve, reject) => {
      const req = request({ hostname: '127.0.0.1', port: callback.port, path: 'http://[' }, (response) => {
        response.resume()
        response.on('end', () => resolve(response.statusCode))
      })
      req.on('error', reject)
      req.end()
    })
    await fetch(callback).then(response => response.text())
    const completed = await result

    expect(status).toBe(400)
    expect(completed.client?.credentials).toEqual(tokens)
    expect(OAuth2Client.prototype.getToken).toHaveBeenCalledTimes(1)
  })

  it('exchanges a code only once when duplicate callbacks arrive', async () => {
    const { callback, result } = await start()
    const responses = await Promise.allSettled([
      fetch(callback).then(response => response.text()),
      fetch(callback).then(response => response.text()),
    ])
    const completed = await result

    expect(responses.some(response => response.status === 'fulfilled')).toBe(true)
    expect(completed.client?.credentials).toEqual(tokens)
    expect(OAuth2Client.prototype.getToken).toHaveBeenCalledTimes(1)
    expect(await loadTokens()).toEqual(tokens)
  })

  it('does not retry or save tokens when the token exchange fails', async () => {
    vi.mocked(OAuth2Client.prototype.getToken).mockRejectedValueOnce(new Error('Token exchange failed'))
    const { callback, result } = await start()
    await fetch(callback).then(response => response.text())
    const completed = await result

    expect(completed.error.message).toBe('Token exchange failed')
    expect(OAuth2Client.prototype.getToken).toHaveBeenCalledTimes(1)
    expect(await loadTokens()).toBeNull()
    await expect(fetch(callback)).rejects.toThrow()
  })

  it('uses fresh state and PKCE for each login attempt', async () => {
    const first = await start()
    await fetch(first.callback).then(response => response.text())
    await first.result
    output = []
    const second = await start()
    await fetch(second.callback).then(response => response.text())
    await second.result

    expect(second.url.searchParams.get('state')).not.toBe(first.url.searchParams.get('state'))
    expect(second.url.searchParams.get('code_challenge')).not.toBe(first.url.searchParams.get('code_challenge'))
  })

  it('does not reflect callback errors into the response or CLI error', async () => {
    const { callback, result } = await start()
    callback.searchParams.delete('code')
    callback.searchParams.set('error', '<script>alert(1)</script>')
    const response = await fetch(callback)
    const page = await response.text()
    const completed = await result

    expect(page).not.toContain('<script>')
    expect(completed.error.message).not.toContain('<script>')
    expect(completed.error).toMatchObject({ authError: { kind: 'oauth-failed' } })
    expect(OAuth2Client.prototype.getToken).not.toHaveBeenCalled()
  })

  it('prints the loopback URL without opening a browser in headless mode', async () => {
    const { url, callback, result } = await start(true)
    await fetch(callback).then(response => response.text())
    const completed = await result

    expect(completed.client?.credentials).toEqual(tokens)
    expect(open).not.toHaveBeenCalled()
    expect(output.join('\n')).toContain(callback.port)
    expect(output.join('\n')).toContain('ssh -N -L')
    expect(url.searchParams.get('code_challenge_method')).toBe('S256')
  })
})

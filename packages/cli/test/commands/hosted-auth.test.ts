import type { CliRuntime } from '../../src/runtime'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { resolveAuthentication, saveAuthentication } from '../../src/auth-state'
import { saveBingCredentials } from '../../src/bing-auth'
import { authCommand } from '../../src/commands/auth'
import { createCliRuntime, runWithCliRuntime } from '../../src/runtime'

vi.mock('../../src/auth', async importOriginal => ({
  ...await importOriginal<typeof import('../../src/auth')>(),
  getAuth: vi.fn().mockRejectedValue(new Error('Local login failed')),
}))

let runtime: CliRuntime
const hosted = { _tag: 'Hosted', apiRoot: 'https://gscdump.com/api', apiKey: 'gsd_user_saved' } as const
beforeEach(async () => {
  runtime = createCliRuntime({ configDir: await fs.mkdtemp(path.join(os.tmpdir(), 'gscdump-hosted-auth-')), environment: {} })
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ user: { publicId: 'user-1', email: 'user@example.com' }, sites: [] })))
})
afterEach(async () => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  await fs.rm(runtime.configDir, { recursive: true, force: true })
})

async function run(name: 'login' | 'status' | 'logout', args: Record<string, unknown>) {
  const command = authCommand.subCommands![name]
  await runWithCliRuntime(runtime, () => command.run!({ args, rawArgs: [], cmd: command }))
}

it('validates Hosted credentials and persists the shared authenticated state', async () => {
  await run('login', { 'mode': 'hosted', 'api-key': hosted.apiKey, 'quiet': true })
  expect(await runWithCliRuntime(runtime, resolveAuthentication)).toEqual(hosted)
  expect(fetch).toHaveBeenCalledWith('https://gscdump.com/api/cli/me', expect.objectContaining({ headers: expect.objectContaining({ 'x-api-key': hosted.apiKey }) }))
})

it('saves a browser-authorized CLI session and revokes it on logout', async () => {
  const sessionId = 'a'.repeat(64)
  vi.mocked(fetch).mockImplementation(async (input: string | URL) => {
    const url = new URL(input)
    if (url.pathname.endsWith('/cli/auth/init')) {
      expect(url.pathname).not.toContain('refresh')
      return Response.json({ code: `S-${'A'.repeat(20)}`, expiresIn: 600 })
    }
    if (url.pathname.endsWith('/cli/auth/poll'))
      return Response.json({ status: 'complete', sessionId })
    if (url.pathname.endsWith('/cli/me'))
      return Response.json({ user: { publicId: 'u_01', email: 'user@example.com' }, sites: [] })
    if (url.pathname.endsWith('/cli/auth/logout'))
      return Response.json({ success: true })
    throw new Error(`Unexpected request: ${url.pathname}`)
  })
  await run('login', { mode: 'hosted', browser: false, quiet: true })
  expect(await runWithCliRuntime(runtime, resolveAuthentication)).toEqual({ _tag: 'Hosted', apiRoot: hosted.apiRoot, sessionId })
  expect(fetch).toHaveBeenCalledWith('https://gscdump.com/api/cli/me', expect.objectContaining({ headers: expect.objectContaining({ 'x-cli-session': sessionId }) }))
  await run('logout', { quiet: true })
  expect(fetch).toHaveBeenCalledWith('https://gscdump.com/api/cli/auth/logout', expect.objectContaining({ method: 'POST', headers: expect.objectContaining({ 'x-cli-session': sessionId }) }))
  expect(await runWithCliRuntime(runtime, resolveAuthentication)).toEqual({ _tag: 'Local' })
})

it('preserves working Hosted mode after a failed Hosted login', async () => {
  await runWithCliRuntime(runtime, () => saveAuthentication(hosted))
  vi.mocked(fetch).mockResolvedValue(Response.json({}, { status: 401 }))
  await expect(run('login', { 'mode': 'hosted', 'api-key': 'gsd_user_rejected', 'quiet': true })).rejects.toThrow()
  expect(await runWithCliRuntime(runtime, resolveAuthentication)).toEqual(hosted)
})

it('reports the Hosted account and commands without token details', async () => {
  await runWithCliRuntime(runtime, () => saveAuthentication(hosted))
  await run('status', { json: true })
  const result = JSON.parse(vi.mocked(console.log).mock.calls.at(-1)![0])
  expect(result).toMatchObject({ authenticated: true, mode: 'hosted', account: 'user@example.com' })
  expect(result.commands).toContain('query')
  expect(result.commands).toContain('bing login')
  expect(result.commands).not.toContain('sync')
  expect(JSON.stringify(result)).not.toContain(hosted.apiKey)
})

it('reports hosted sync progress for each registered Site', async () => {
  await runWithCliRuntime(runtime, () => saveAuthentication(hosted))
  vi.mocked(fetch).mockImplementation(async (input: string | URL) => {
    const url = new URL(input)
    if (url.pathname.endsWith('/cli/me'))
      return Response.json({ user: { publicId: 'user-1', email: 'user@example.com' }, sites: [{ siteId: 's_1', siteUrl: 'sc-domain:example.com', syncStatus: 'syncing', syncProgress: { completed: 41, total: 90, percent: 45.5 } }] })
    throw new Error(`Unexpected request: ${url.pathname}`)
  })

  await run('status', { json: true })
  const result = JSON.parse(vi.mocked(console.log).mock.calls.at(-1)![0])
  expect(result.hostedSync).toEqual([{ siteUrl: 'sc-domain:example.com', syncStatus: 'syncing', syncProgress: { completed: 41, total: 90, percent: 45.5 }, oldestDateSynced: null, newestDateSynced: null }])

  await run('status', {})
  expect(vi.mocked(console.log).mock.calls.map(call => String(call[0]))).toContain('    sc-domain:example.com  syncing: 41 of 90 days (46%)')
})

it('reports a failed Hosted status instead of rejecting when the hosted API fails', async () => {
  await runWithCliRuntime(runtime, () => saveAuthentication(hosted))
  vi.mocked(fetch).mockImplementation(async (input: string | URL) => {
    const url = new URL(input)
    if (url.pathname.endsWith('/cli/me'))
      return Response.json({ error: { code: 'internal', message: 'Hosted failure.', requestId: 'req_down', retryable: true, details: {} } }, { status: 500 })
    throw new Error(`Unexpected request: ${url.pathname}`)
  })
  const warn = vi.spyOn(runtime.logger, 'warn')

  const jsonRun = runWithCliRuntime(runtime, () => run('status', { json: true }))
  await expect(jsonRun.then(() => 'resolved' as const)).resolves.toBe('resolved')
  const result = JSON.parse(vi.mocked(console.log).mock.calls.at(-1)![0])
  expect(result).toMatchObject({ authenticated: false, mode: 'hosted', apiRoot: hosted.apiRoot })
  expect(result.error).toContain('500')
  expect(JSON.stringify(result)).not.toContain(hosted.apiKey)

  const humanRun = runWithCliRuntime(runtime, () => run('status', {}))
  await expect(humanRun.then(() => 'resolved' as const)).resolves.toBe('resolved')
  expect(warn).toHaveBeenCalledWith(expect.stringContaining('500'))
})

it('clears shared authentication on logout', async () => {
  await runWithCliRuntime(runtime, () => saveAuthentication(hosted))
  await run('logout', { quiet: true })
  expect(await runWithCliRuntime(runtime, resolveAuthentication)).toEqual({ _tag: 'Local' })
})

it('clears saved credentials when Hosted session revocation fails', async () => {
  const sessionId = 'b'.repeat(64)
  await runWithCliRuntime(runtime, () => saveAuthentication({ _tag: 'Hosted', apiRoot: hosted.apiRoot, sessionId }))
  vi.mocked(fetch).mockResolvedValue(Response.json({ error: { code: 'unauthorized' } }, { status: 401 }))
  await run('logout', { quiet: true })
  expect(fetch).toHaveBeenCalledWith('https://gscdump.com/api/cli/auth/logout', expect.objectContaining({ method: 'POST', headers: expect.objectContaining({ 'x-cli-session': sessionId }) }))
  expect(await runWithCliRuntime(runtime, resolveAuthentication)).toEqual({ _tag: 'Local' })
})

it('clears local state when saved authentication is corrupt', async () => {
  await fs.writeFile(path.join(runtime.configDir, 'authentication.json'), '{oops', { mode: 0o600 })
  await run('logout', { quiet: true })
  expect(await runWithCliRuntime(runtime, resolveAuthentication)).toEqual({ _tag: 'Local' })
})

it('allows a trailing slash on GSCDUMP_API_ROOT for browser Hosted login', async () => {
  const sessionId = 'c'.repeat(64)
  runtime.environment.GSCDUMP_API_ROOT = 'https://gscdump.com/api/'
  vi.mocked(fetch).mockImplementation(async (input: string | URL) => {
    const url = new URL(input)
    if (url.pathname.endsWith('/cli/auth/init')) {
      expect(url.pathname).not.toContain('refresh')
      return Response.json({ code: `S-${'A'.repeat(20)}`, expiresIn: 600 })
    }
    if (url.pathname.endsWith('/cli/auth/poll'))
      return Response.json({ status: 'complete', sessionId })
    if (url.pathname.endsWith('/cli/me'))
      return Response.json({ user: { publicId: 'u_01', email: 'user@example.com' }, sites: [] })
    throw new Error(`Unexpected request: ${url.pathname}`)
  })
  await run('login', { mode: 'hosted', browser: false, quiet: true })
  expect(await runWithCliRuntime(runtime, resolveAuthentication)).toEqual({ _tag: 'Hosted', apiRoot: 'https://gscdump.com/api', sessionId })
})

it('rejects unsafe Hosted API roots before sending an API key', async () => {
  await expect(run('login', { 'mode': 'hosted', 'api-key': hosted.apiKey, 'api-root': 'http://example.com/api', 'quiet': true })).rejects.toThrow('Invalid Hosted credentials')
  expect(fetch).not.toHaveBeenCalled()
})

it('keeps Hosted mode when Local login fails', async () => {
  await runWithCliRuntime(runtime, () => saveAuthentication(hosted))
  await expect(run('login', { mode: 'local', quiet: true })).rejects.toThrow()
  expect(await runWithCliRuntime(runtime, resolveAuthentication)).toEqual(hosted)
})

it('reports a local Bing login when Google credentials are missing', async () => {
  await runWithCliRuntime(runtime, () => saveBingCredentials({ _tag: 'ApiKey', apiKey: 'bing-saved-secret' }))
  vi.mocked(fetch).mockResolvedValue(Response.json({ d: [] }))
  await run('status', { json: true })
  const result = JSON.parse(vi.mocked(console.log).mock.calls.at(-1)![0])
  expect(result).toMatchObject({ authenticated: true, mode: 'local', googleAuthenticated: false, bing: { authenticated: true, source: 'ApiKey' } })
  expect(JSON.stringify(result)).not.toContain('bing-saved-secret')
})

it('reports rejected local Bing credentials without claiming authentication', async () => {
  runtime.environment.BING_API_KEY = 'bing-rejected-secret'
  vi.mocked(fetch).mockResolvedValue(Response.json({}, { status: 401 }))
  await run('status', { json: true })
  const result = JSON.parse(vi.mocked(console.log).mock.calls.at(-1)![0])
  expect(result).toMatchObject({ authenticated: false, bing: { configured: true, authenticated: false } })
})

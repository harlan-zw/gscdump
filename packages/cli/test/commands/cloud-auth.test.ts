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
const cloud = { _tag: 'Cloud', apiRoot: 'https://gscdump.com/api', apiKey: 'gsd_user_saved' } as const
beforeEach(async () => {
  runtime = createCliRuntime({ configDir: await fs.mkdtemp(path.join(os.tmpdir(), 'gscdump-cloud-auth-')), environment: {} })
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

it('validates cloud credentials and persists the shared authenticated state', async () => {
  await run('login', { 'mode': 'cloud', 'api-key': cloud.apiKey, 'quiet': true })
  expect(await runWithCliRuntime(runtime, resolveAuthentication)).toEqual(cloud)
  expect(fetch).toHaveBeenCalledWith('https://gscdump.com/api/cli/me', expect.objectContaining({ headers: expect.objectContaining({ 'x-api-key': cloud.apiKey }) }))
})

it('preserves working cloud authentication after failed cloud login', async () => {
  await runWithCliRuntime(runtime, () => saveAuthentication(cloud))
  vi.mocked(fetch).mockResolvedValue(Response.json({}, { status: 401 }))
  await expect(run('login', { 'mode': 'cloud', 'api-key': 'gsd_user_rejected', 'quiet': true })).rejects.toThrow()
  expect(await runWithCliRuntime(runtime, resolveAuthentication)).toEqual(cloud)
})

it('reports cloud account and features without token details', async () => {
  await runWithCliRuntime(runtime, () => saveAuthentication(cloud))
  await run('status', { json: true })
  const result = JSON.parse(vi.mocked(console.log).mock.calls.at(-1)![0])
  expect(result).toMatchObject({ authenticated: true, mode: 'cloud', account: 'user@example.com' })
  expect(result.capabilities.google).toContain('query')
  expect(JSON.stringify(result)).not.toContain(cloud.apiKey)
})

it('reports a failed cloud status instead of rejecting when the hosted API fails', async () => {
  await runWithCliRuntime(runtime, () => saveAuthentication(cloud))
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
  expect(result).toMatchObject({ authenticated: false, mode: 'cloud', apiRoot: cloud.apiRoot })
  expect(result.error).toContain('500')
  expect(JSON.stringify(result)).not.toContain(cloud.apiKey)

  const humanRun = runWithCliRuntime(runtime, () => run('status', {}))
  await expect(humanRun.then(() => 'resolved' as const)).resolves.toBe('resolved')
  expect(warn).toHaveBeenCalledWith(expect.stringContaining('500'))
})

it('clears shared authentication on logout', async () => {
  await runWithCliRuntime(runtime, () => saveAuthentication(cloud))
  await run('logout', { quiet: true })
  expect(await runWithCliRuntime(runtime, resolveAuthentication)).toEqual({ _tag: 'Local' })
})

it('rejects unsafe cloud roots before sending an API key', async () => {
  await expect(run('login', { 'mode': 'cloud', 'api-key': cloud.apiKey, 'api-root': 'http://example.com/api', 'quiet': true })).rejects.toThrow('Invalid authentication')
  expect(fetch).not.toHaveBeenCalled()
})

it('keeps cloud authentication when local login fails', async () => {
  await runWithCliRuntime(runtime, () => saveAuthentication(cloud))
  await expect(run('login', { mode: 'local', quiet: true })).rejects.toThrow()
  expect(await runWithCliRuntime(runtime, resolveAuthentication)).toEqual(cloud)
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

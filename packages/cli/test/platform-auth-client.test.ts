import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import open from 'open'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { clearTokens, getAuth, loadTokens, saveTokens } from '../src/auth'
import { authCommand } from '../src/commands/auth'
import { setConfigDir } from '../src/config'

vi.mock('open', () => ({ default: vi.fn().mockResolvedValue(undefined) }))
vi.mock('../src/commands/init', () => ({ runSmokeTest: vi.fn() }))

let directory: string
beforeEach(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'gscdump-platform-auth-'))
  setConfigDir(directory)
  for (const key of ['GSC_CLIENT_ID', 'GSC_CLIENT_SECRET', 'GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET'])
    vi.stubEnv(key, '')
})
afterEach(async () => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  await fs.rm(directory, { recursive: true, force: true })
})

it('refreshes saved platform credentials and keeps the refresh secret out of Google requests', async () => {
  await saveTokens({ provider: 'gscdump', access_token: 'expired', refresh_token: 'secret', expiry_date: 1 })
  const request = vi.fn().mockResolvedValue(new Response(JSON.stringify({ accessToken: 'renewed', expiresAt: Date.now() + 3600000 })))
  vi.stubGlobal('fetch', request)
  const client = await getAuth({ interactive: false })
  const headers = await client.getRequestHeaders('https://www.googleapis.com/webmasters/v3/sites')
  expect(headers.get('authorization')).toBe('Bearer renewed')
  expect(client.credentials.refresh_token).toBeUndefined()
  expect(request).toHaveBeenCalledTimes(1)
  expect(request.mock.calls[0]?.[0]).toBe('https://gscdump.com/api/cli/auth/refresh')
  expect(await loadTokens()).toMatchObject({ provider: 'gscdump', access_token: 'renewed', refresh_token: 'secret' })
  await clearTokens()
  expect(await loadTokens()).toBeNull()
})

it('reconnects rejected credentials with the prescribed local forced login', async () => {
  const previous = { provider: 'gscdump' as const, access_token: 'expired', refresh_token: 'rejected', expiry_date: 1 }
  await saveTokens(previous)
  const request = vi.fn().mockResolvedValueOnce(new Response('private error', { status: 401 }))
  vi.stubGlobal('fetch', request)
  const error = await getAuth({ interactive: false }).then(() => null, (error: Error) => error)
  expect(error?.message).toContain('gscdump auth login --mode local --force')
  expect(await loadTokens()).toEqual(previous)
  const expiresAt = Date.now() + 3600000
  request.mockResolvedValueOnce(Response.json({ code: 'A'.repeat(20), expiresIn: 600 }))
    .mockResolvedValueOnce(Response.json({ status: 'complete', tokens: { accessToken: 'new-access', refreshToken: 'new-refresh', expiresAt } }))
    .mockResolvedValueOnce(Response.json({ scope: 'webmasters.readonly' }))
  const command = authCommand.subCommands!.login
  await command.run!({ args: { mode: 'local', force: true, browser: true }, rawArgs: [], cmd: command })
  expect(request.mock.calls.map(([url]) => url)).toEqual([
    'https://gscdump.com/api/cli/auth/refresh',
    'https://gscdump.com/api/cli/auth/init',
    `https://gscdump.com/api/cli/auth/poll?code=${'A'.repeat(20)}`,
    'https://oauth2.googleapis.com/tokeninfo?access_token=new-access',
  ])
  expect(open).toHaveBeenCalledWith(`https://gscdump.com/app/cli/auth?code=${'A'.repeat(20)}`)
  expect(await loadTokens()).toEqual({ provider: 'gscdump', access_token: 'new-access', refresh_token: 'new-refresh', expiry_date: expiresAt })
})

it('preserves saved credentials without starting login when refresh is unavailable', async () => {
  const previous = { provider: 'gscdump' as const, access_token: 'expired', refresh_token: 'secret', expiry_date: 1 }
  await saveTokens(previous)
  const request = vi.fn().mockResolvedValue(new Response('unavailable', { status: 503 }))
  vi.stubGlobal('fetch', request)
  await expect(getAuth({ interactive: true })).rejects.toThrow('Try again')
  expect(request).toHaveBeenCalledTimes(1)
  expect(await loadTokens()).toEqual(previous)
})

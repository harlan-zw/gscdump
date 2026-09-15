import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { clearTokens, getAuth, loadTokens, saveTokens } from '../src/auth'
import { setConfigDir } from '../src/config'

let directory: string
beforeEach(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'gscdump-platform-auth-'))
  setConfigDir(directory)
  for (const key of ['GSC_CLIENT_ID', 'GSC_CLIENT_SECRET', 'GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET'])
    vi.stubEnv(key, '')
})
afterEach(async () => {
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

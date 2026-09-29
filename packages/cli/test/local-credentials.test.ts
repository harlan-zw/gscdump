import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { ACCESS_NOT_SET_UP, getAuth, loadTokens, probeAuth, saveTokens } from '../src/auth'
import { setConfigDir } from '../src/config'

let directory: string
beforeEach(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'gscdump-local-credentials-'))
  setConfigDir(directory)
  for (const key of ['GSC_CLIENT_ID', 'GSC_CLIENT_SECRET', 'GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'GSC_ACCESS_TOKEN', 'GOOGLE_ACCESS_TOKEN', 'GSC_REFRESH_TOKEN', 'GOOGLE_REFRESH_TOKEN', 'GSC_SERVICE_ACCOUNT_JSON', 'GOOGLE_APPLICATION_CREDENTIALS', 'GSCDUMP_API_KEY', 'GSCDUMP_AUTH_MODE'])
    vi.stubEnv(key, '')
})
afterEach(async () => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  await fs.rm(directory, { recursive: true, force: true })
})

it('names both access modes when no Google credentials exist', async () => {
  const request = vi.fn()
  vi.stubGlobal('fetch', request)
  await expect(getAuth({ interactive: false })).rejects.toThrow(ACCESS_NOT_SET_UP)
  expect(ACCESS_NOT_SET_UP).toContain('--service-account')
  expect(ACCESS_NOT_SET_UP).toContain('GSC_CLIENT_ID')
  expect(ACCESS_NOT_SET_UP).toContain('gscdump auth login --mode hosted')
  expect(request).not.toHaveBeenCalled()
})

it('ignores Google tokens saved by the removed gscdump.com login and never calls gscdump.com', async () => {
  await saveTokens({ provider: 'gscdump', access_token: 'old', refresh_token: 'old-refresh', expiry_date: 1 } as never)
  const request = vi.fn()
  vi.stubGlobal('fetch', request)
  expect(await loadTokens()).toBeNull()
  expect(await probeAuth()).toBe('none')
  await expect(getAuth({ interactive: false })).rejects.toThrow(ACCESS_NOT_SET_UP)
  expect(request).not.toHaveBeenCalled()
})

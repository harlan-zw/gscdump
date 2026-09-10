import type { CliRuntime } from '../src/runtime'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { resolveAuthentication, saveAuthentication } from '../src/auth-state'
import { createCliRuntime, runWithCliRuntime } from '../src/runtime'

let runtime: CliRuntime
beforeEach(async () => {
  runtime = createCliRuntime({ configDir: await fs.mkdtemp(path.join(os.tmpdir(), 'gscdump-auth-state-')), environment: {} })
})
afterEach(async () => {
  vi.restoreAllMocks()
  await fs.rm(runtime.configDir, { recursive: true, force: true })
})

it('uses one saved hosted state for subsequent commands', async () => {
  await runWithCliRuntime(runtime, () => saveAuthentication({ _tag: 'Cloud', apiRoot: 'https://gscdump.com/api', apiKey: 'gsd_user_secret' }))
  expect(await runWithCliRuntime(runtime, resolveAuthentication)).toEqual({ _tag: 'Cloud', apiRoot: 'https://gscdump.com/api', apiKey: 'gsd_user_secret' })
})

it('honours explicit local selection when a hosted key is in the environment', async () => {
  runtime.environment.GSCDUMP_API_KEY = 'gsd_user_secret'
  await runWithCliRuntime(runtime, () => saveAuthentication({ _tag: 'Local' }))
  expect(await runWithCliRuntime(runtime, resolveAuthentication)).toEqual({ _tag: 'Local' })
})

it('does not send a saved hosted key to an overridden API root', async () => {
  await runWithCliRuntime(runtime, () => saveAuthentication({ _tag: 'Cloud', apiRoot: 'https://gscdump.com/api', apiKey: 'gsd_user_secret' }))
  runtime.environment.GSCDUMP_API_ROOT = 'https://other.example/api'
  await expect(runWithCliRuntime(runtime, resolveAuthentication)).rejects.toThrow('API root')
})

it('rejects malformed saved state instead of switching to local credentials', async () => {
  await fs.writeFile(path.join(runtime.configDir, 'authentication.json'), JSON.stringify({ _tag: 'Cloud' }))
  await expect(runWithCliRuntime(runtime, resolveAuthentication)).rejects.toThrow('authentication')
})

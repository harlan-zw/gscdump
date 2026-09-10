import fs from 'node:fs/promises'
import { afterEach, expect, it, vi } from 'vitest'
import { resolveAuthentication, saveAuthentication } from '../../src/auth-state'
import { inspectBingCredentials, saveBingCredentials } from '../../src/bing-auth'
import { adoptCurrentConfigAsProfile } from '../../src/commands/profile'
import { createCliRuntime, runWithCliRuntime } from '../../src/runtime'

const root = vi.hoisted(() => `/tmp/gscdump-profile-auth-${Math.random().toString(36).slice(2)}`)
vi.mock('../../src/commands/profile-selection', () => ({
  ROOT_DIR: root,
  PROFILES_DIR: `${root}/profiles`,
  ACTIVE_MARKER: `${root}/active-profile`,
  getProfileDir: (name: string) => `${root}/profiles/${name}`,
  readActiveMarkerSync: () => null,
}))

afterEach(() => fs.rm(root, { recursive: true, force: true }))

it('keeps the selected authentication mode and Bing credentials after profile adoption', async () => {
  const runtime = createCliRuntime({ configDir: root, environment: { GSCDUMP_API_KEY: 'gsd_user_environment' } })
  await runWithCliRuntime(runtime, async () => {
    await saveAuthentication({ _tag: 'Local' })
    await saveBingCredentials({ _tag: 'ApiKey', apiKey: 'bing-profile-secret' })
    await adoptCurrentConfigAsProfile('google-account')
    expect(await resolveAuthentication()).toEqual({ _tag: 'Local' })
    expect(await inspectBingCredentials()).toEqual({ _tag: 'ApiKey' })
  })
})

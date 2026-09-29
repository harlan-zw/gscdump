import type { CliRuntime } from '../src/runtime'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { HOSTED_NOT_SET_UP, LOCAL_MODE_REQUIRED, parseAuthMode, resolveAccessMode, resolveAuthentication, saveAuthentication } from '../src/auth-state'
import { createCommandContext } from '../src/context'
import { createCliRuntime, runWithCliRuntime } from '../src/runtime'

describe('resolveAccessMode', () => {
  it('uses the flag before the environment and the saved mode', () => {
    expect(resolveAccessMode({ flag: 'local', env: 'hosted', saved: 'hosted', apiKey: 'gsd_user_x' })).toEqual({ mode: 'local', source: 'flag' })
  })

  it('uses GSCDUMP_AUTH_MODE before the saved mode', () => {
    expect(resolveAccessMode({ env: 'hosted', saved: 'local' })).toEqual({ mode: 'hosted', source: 'env' })
  })

  it('uses the saved mode before an API key in the environment', () => {
    expect(resolveAccessMode({ saved: 'local', apiKey: 'gsd_user_x' })).toEqual({ mode: 'local', source: 'saved' })
  })

  it('selects Hosted when only GSCDUMP_API_KEY is set', () => {
    expect(resolveAccessMode({ apiKey: 'gsd_user_x' })).toEqual({ mode: 'hosted', source: 'api-key' })
  })

  it('selects Local when nothing is set', () => {
    expect(resolveAccessMode({})).toEqual({ mode: 'local', source: 'default' })
  })

  it('rejects the removed cloud mode in the environment', () => {
    expect(() => resolveAccessMode({ env: 'cloud' })).toThrow('Access mode must be local or hosted.')
  })
})

describe('parseAuthMode', () => {
  it('accepts local and hosted', () => {
    expect(parseAuthMode('local')).toBe('local')
    expect(parseAuthMode('hosted')).toBe('hosted')
    expect(parseAuthMode(undefined)).toBeUndefined()
  })

  it('rejects cloud', () => {
    expect(() => parseAuthMode('cloud')).toThrow('Access mode must be local or hosted.')
  })
})

describe('resolveAuthentication errors', () => {
  let runtime: CliRuntime
  beforeEach(async () => {
    runtime = createCliRuntime({ configDir: await fs.mkdtemp(path.join(os.tmpdir(), 'gscdump-access-mode-')), environment: {} })
  })
  afterEach(async () => {
    await fs.rm(runtime.configDir, { recursive: true, force: true })
  })

  it('names both setup commands for a saved state from an older CLI', async () => {
    await fs.writeFile(path.join(runtime.configDir, 'authentication.json'), JSON.stringify({ _tag: 'Cloud', apiRoot: 'https://gscdump.com/api', apiKey: 'gsd_user_x' }))
    const error = await runWithCliRuntime(runtime, resolveAuthentication).then(() => null, (error: Error) => error)
    expect(error?.message).toContain('gscdump auth login --mode local')
    expect(error?.message).toContain('gscdump auth login --mode hosted')
  })

  it('tells the user how to set up Hosted mode when Hosted credentials are missing', async () => {
    runtime.authModeOverride = 'hosted'
    await expect(runWithCliRuntime(runtime, resolveAuthentication)).rejects.toThrow(HOSTED_NOT_SET_UP)
    expect(HOSTED_NOT_SET_UP).toContain('gscdump auth login --mode hosted')
  })

  it('reads a saved Hosted session', async () => {
    const state = { _tag: 'Hosted' as const, apiRoot: 'https://gscdump.com/api', sessionId: 'a'.repeat(64) }
    await runWithCliRuntime(runtime, () => saveAuthentication(state))
    expect(await runWithCliRuntime(runtime, resolveAuthentication)).toEqual(state)
  })

  it('refuses a Google command in Hosted mode with the Local setup command', async () => {
    runtime.environment.GSCDUMP_API_KEY = 'gsd_user_secret'
    const error = await runWithCliRuntime(runtime, () => createCommandContext({ needsAuth: true })).then(() => null, (error: Error) => error)
    expect(error?.message).toBe(LOCAL_MODE_REQUIRED)
    expect(LOCAL_MODE_REQUIRED).toContain('gscdump auth login --mode local')
  })
})

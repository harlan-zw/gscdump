import type { CliRuntime } from '../../src/runtime'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { runCommand } from 'citty'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { saveBingCredentials } from '../../src/bing-auth'
import { authCommand } from '../../src/commands/auth'
import { createCliRuntime, runWithCliRuntime } from '../../src/runtime'

const tokenEndpoint = 'https://www.bing.com/webmasters/oauth/token'

describe('auth status when the Bing token refresh fails', () => {
  let runtime: CliRuntime
  let root: string
  let output: string[]

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'gscdump-auth-status-bing-'))
    runtime = createCliRuntime({ configDir: path.join(root, 'personal'), environment: {} })
    output = []
    vi.spyOn(console, 'log').mockImplementation((...args) => output.push(args.map(String).join(' ')))
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
      const url = new URL(input instanceof Request ? input.url : input)
      if (url.toString() === tokenEndpoint)
        return Response.json({ error: 'temporarily_unavailable' }, { status: 503 })
      throw new Error(`Unexpected HTTP request: ${url.origin}${url.pathname}`)
    }))
  })

  afterEach(async () => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    await fs.rm(root, { recursive: true, force: true })
  })

  async function seedExpiredOAuthCredentials() {
    await runWithCliRuntime(runtime, () => saveBingCredentials({
      _tag: 'OAuth',
      clientId: 'registered-client',
      clientSecret: 'private-client-secret',
      redirectUri: 'http://127.0.0.1:53683/oauth/bing',
      accessToken: 'expired-access',
      refreshToken: 'original-refresh',
      expiresAt: Date.now() - 1,
    }))
  }

  it('resolves with a per-provider report instead of rejecting', async () => {
    await seedExpiredOAuthCredentials()
    const warn = vi.spyOn(runtime.logger, 'warn')

    const run = runWithCliRuntime(runtime, () => runCommand(authCommand, { rawArgs: ['status', '--json'] }))
    await expect(run.then(() => 'resolved' as const)).resolves.toBe('resolved')

    const report = JSON.parse(output.at(-1)!)
    expect(report).toMatchObject({
      googleAuthenticated: false,
      bing: { configured: true, authenticated: false },
    })

    output = []
    await runWithCliRuntime(runtime, () => runCommand(authCommand, { rawArgs: ['status'] }))
    expect(warn).toHaveBeenCalledWith('Bing credentials failed verification. Run `gscdump bing login` again.')
    expect(warn).toHaveBeenCalledWith('Not authenticated')
  })
})

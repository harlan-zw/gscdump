import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { runCommand } from 'citty'
import { JWT } from 'google-auth-library'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { authCommand } from '../../src/commands/auth'
import { saveConfig } from '../../src/config'
import { createCliRuntime, runWithCliRuntime } from '../../src/runtime'

const request = vi.hoisted(() => vi.fn())
vi.mock('ofetch', () => ({ ofetch: request }))

describe('service-account status', () => {
  let root: string
  let output: string[]
  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'gscdump-service-status-'))
    output = []
    vi.spyOn(console, 'log').mockImplementation((...args) => output.push(args.map(String).join(' ')))
    vi.spyOn(JWT.prototype, 'getAccessToken').mockResolvedValue({ token: 'service-access' })
    request.mockResolvedValue({ email: 'tester@example.iam.gserviceaccount.com', scope: 'https://www.googleapis.com/auth/webmasters https://www.googleapis.com/auth/indexing https://www.googleapis.com/auth/siteverification' })
  })
  afterEach(async () => {
    vi.restoreAllMocks()
    await fs.rm(root, { recursive: true, force: true })
  })

  it.each(['saved', 'environment'] as const)('verifies %s service-account credentials without saved OAuth tokens', async (source) => {
    const keyPath = path.join(root, 'key.json')
    await fs.writeFile(keyPath, JSON.stringify({ type: 'service_account', client_email: 'tester@example.iam.gserviceaccount.com', private_key: 'fake-key' }))
    const runtime = createCliRuntime({ configDir: path.join(root, 'config'), environment: source === 'environment' ? { GOOGLE_APPLICATION_CREDENTIALS: keyPath, GSC_ACCESS_TOKEN: 'ignored-oauth-token' } : {} })
    await runWithCliRuntime(runtime, async () => {
      if (source === 'saved')
        await saveConfig({ serviceAccountPath: keyPath })
      await runCommand(authCommand.subCommands!.status, { rawArgs: ['--json'] })
      expect(JSON.parse(output.at(-1)!)).toMatchObject({ authenticated: true, googleAuthenticated: true, googleError: null, source: 'service-account', tokenAccount: 'tester@example.iam.gserviceaccount.com', tokens: null })
      expect(String(request.mock.calls.at(-1)?.[1]?.body)).toBe('access_token=service-access')
      const success = vi.spyOn(runtime.logger, 'success')
      await runCommand(authCommand.subCommands!.status, { rawArgs: [] })
      expect(success).toHaveBeenCalledWith('Authenticated (service account)')
      await runCommand(authCommand.subCommands!.scopes, { rawArgs: ['--json'] })
      expect(JSON.parse(output.at(-1)!)).toMatchObject({ missing: [] })
    })
  })
  it('reports rejected service-account credentials instead of using an environment OAuth token', async () => {
    const keyPath = path.join(root, 'key.json')
    await fs.writeFile(keyPath, JSON.stringify({ type: 'service_account', client_email: 'tester@example.iam.gserviceaccount.com', private_key: 'fake-key' }))
    vi.mocked(JWT.prototype.getAccessToken).mockRejectedValue(new Error('invalid_grant'))
    const runtime = createCliRuntime({ configDir: path.join(root, 'config'), environment: { GSC_SERVICE_ACCOUNT_JSON: keyPath, GSC_ACCESS_TOKEN: 'ignored-oauth-token' } })
    await runWithCliRuntime(runtime, () => runCommand(authCommand.subCommands!.status, { rawArgs: ['--json'] }))
    expect(JSON.parse(output.at(-1)!)).toMatchObject({ authenticated: false, googleAuthenticated: false, googleError: 'invalid_grant', source: 'service-account' })
  })

  it('uses environment OAuth credentials when the service-account file no longer exists', async () => {
    const runtime = createCliRuntime({ configDir: path.join(root, 'config'), environment: { GSC_SERVICE_ACCOUNT_JSON: path.join(root, 'missing.json'), GSC_ACCESS_TOKEN: 'oauth-access' } })
    await runWithCliRuntime(runtime, () => runCommand(authCommand.subCommands!.status, { rawArgs: ['--json'] }))
    expect(JSON.parse(output.at(-1)!)).toMatchObject({ authenticated: true, source: 'env' })
    expect(String(request.mock.calls.at(-1)?.[1]?.body)).toBe('access_token=oauth-access')
  })
})

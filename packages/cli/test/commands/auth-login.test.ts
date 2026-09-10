import type { CliRuntime } from '../../src/runtime'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { stripVTControlCharacters } from 'node:util'
import { OAuth2Client } from 'google-auth-library'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { loadTokens, saveTokens } from '../../src/auth'
import { authCommand } from '../../src/commands/auth'
import { createCliRuntime, runWithCliRuntime } from '../../src/runtime'

vi.mock('open', () => ({ default: vi.fn().mockResolvedValue(undefined) }))
vi.mock('../../src/commands/init', () => ({ runSmokeTest: vi.fn().mockResolvedValue(undefined) }))

const previousTokens = { access_token: 'previous-access-token', refresh_token: 'previous-refresh-token' }
const replacementTokens = { access_token: 'replacement-access-token', refresh_token: 'replacement-refresh-token' }

describe('forced auth login', () => {
  let runtime: CliRuntime
  let output: string[]

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    runtime = createCliRuntime({
      configDir: await fs.mkdtemp(path.join(os.tmpdir(), 'gscdump-auth-login-')),
      environment: { GSC_CLIENT_ID: 'test-client', GSC_CLIENT_SECRET: 'test-secret' },
      rawArgs: [],
    })
    runtime.activeProfileOverride = 'test'
    output = []
    vi.spyOn(console, 'log').mockImplementation((...args) => output.push(args.join(' ')))
    vi.spyOn(OAuth2Client.prototype, 'getToken').mockResolvedValue({ tokens: replacementTokens, res: null } as never)
    vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`process.exit(${code})`)
    }) as never)
    await runWithCliRuntime(runtime, () => saveTokens(previousTokens))
  })

  afterEach(async () => {
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000)
    vi.useRealTimers()
    vi.restoreAllMocks()
    await fs.rm(runtime.configDir, { recursive: true, force: true })
  })

  async function start() {
    const command = authCommand.subCommands!.login
    const result = runWithCliRuntime(runtime, () => command.run!({
      args: { force: true, browser: false, quiet: true },
      rawArgs: [],
      cmd: command,
    })).then(() => null, (error: Error) => error)
    let url: URL | undefined
    await vi.waitFor(() => {
      const printed = stripVTControlCharacters(output.join('\n')).match(/https:\/\/accounts\.google\.com\/\S+/)
      expect(printed, output.join('\n')).not.toBeNull()
      url = new URL(printed![0])
    }, { timeout: 1000 })
    const callback = new URL(url!.searchParams.get('redirect_uri')!)
    callback.searchParams.set('state', url!.searchParams.get('state')!)
    callback.searchParams.set('code', 'new-authorization-code')
    return { callback, result }
  }

  it.each(['denied', 'exchange-failed', 'timed-out'])('keeps working tokens when forced login is %s', async (failure) => {
    if (failure === 'exchange-failed')
      vi.mocked(OAuth2Client.prototype.getToken).mockRejectedValueOnce(new Error('Token exchange failed'))
    const { callback, result } = await start()
    if (failure === 'timed-out') {
      await vi.advanceTimersByTimeAsync(5 * 60 * 1000)
    }
    else {
      if (failure === 'denied') {
        callback.searchParams.delete('code')
        callback.searchParams.set('error', 'access_denied')
      }
      await fetch(callback).then(response => response.text())
    }

    expect(await result).toEqual(new Error('process.exit(1)'))
    expect(await runWithCliRuntime(runtime, loadTokens)).toEqual(previousTokens)
  })

  it('keeps working tokens until forced login succeeds, then saves the replacement', async () => {
    const { callback, result } = await start()
    const whileWaiting = await runWithCliRuntime(runtime, loadTokens)
    await fetch(callback).then(response => response.text())

    expect(await result).toBeNull()
    expect(whileWaiting).toEqual(previousTokens)
    expect(await runWithCliRuntime(runtime, loadTokens)).toEqual(replacementTokens)
  })
})

import type { CliRuntime } from '../../src/runtime'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { runCli } from '../../src/cli'
import { createCliRuntime } from '../../src/runtime'

// 2026-10-01 UX replay, run 3: a new account logged in with
// `gscdump auth login --mode hosted`. Cancel in the browser printed
// "Hosted login failed". After approval, the terminal and `auth status` said
// "Sites: 0" and named no next step.
const CODE = `S-${'A'.repeat(20)}`
const SESSION = 'a'.repeat(64)
const CONNECT = 'Next: connect a Site at https://gscdump.com/app/onboarding?step=connect-sites.'
const ACTIVATE = 'If Hosted access is not active, gscdump.com asks you to activate it first.'

describe('hosted login onboarding', () => {
  let runtime: CliRuntime
  let stdout: string[]
  let stderr: string
  let poll: () => Response
  let sites: { siteId: string, siteUrl: string }[]

  beforeEach(async () => {
    const configDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gscdump-hosted-onboarding-'))
    stderr = ''
    stdout = []
    sites = []
    poll = () => Response.json({ status: 'complete', sessionId: SESSION })
    runtime = createCliRuntime({
      configDir,
      environment: { GSCDUMP_CONFIG_DIR: configDir },
      stderr: {
        write: (chunk: string) => {
          stderr += chunk
          return true
        },
      } as unknown as NodeJS.WriteStream,
    })
    runtime.logger.level = 3
    vi.spyOn(console, 'log').mockImplementation((...args) => stdout.push(args.join(' ')))
    vi.spyOn(console, 'error').mockImplementation((...args) => {
      stderr += `${args.join(' ')}\n`
    })
    vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`process.exit(${code})`)
    }) as never)
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
      const url = new URL(input instanceof Request ? input.url : input)
      if (url.pathname === '/api/cli/auth/init')
        return Response.json({ code: CODE, expiresIn: 600 })
      if (url.pathname === '/api/cli/auth/poll')
        return poll()
      if (url.pathname === '/api/cli/me')
        return Response.json({ user: { publicId: 'u_me', email: 'user@example.com' }, sites })
      throw new Error(`Unexpected request: ${url.pathname}`)
    }))
  })

  afterEach(async () => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    await fs.rm(runtime.configDir, { recursive: true, force: true })
  })

  const run = (args: string[]) => runCli({ rawArgs: args, runtime, loadEnv: false })
  const login = () => run(['auth', 'login', '--mode', 'hosted', '--no-browser'])

  it('says the login was cancelled when the browser cancels it', async () => {
    poll = () => Response.json({
      statusCode: 403,
      message: 'Login cancelled in the browser.',
      data: { error: 'FORBIDDEN', message: 'Login cancelled in the browser.', details: { reason: 'login_cancelled' } },
    }, { status: 403 })

    await expect(login()).resolves.toBe(1)

    expect(stderr).toContain('Login cancelled in the browser.')
    expect(stderr).not.toContain('Hosted login failed')
    expect(stderr).not.toContain('Error:')
  })

  it('keeps the failure message for a refused poll that names no cancellation', async () => {
    poll = () => Response.json({ statusCode: 404, message: 'Code not found or expired' }, { status: 404 })

    await expect(login()).resolves.toBe(1)

    expect(stderr).toContain('Hosted login failed.')
  })

  it('names the connect step after a login whose record has no Sites', async () => {
    await expect(login()).resolves.toBe(0)

    expect(stderr).toContain('Hosted mode saved for user@example.com')
    expect(stderr).toContain(`${CONNECT} ${ACTIVATE}`)
  })

  it('names `gscdump sites` after a login whose record has Sites', async () => {
    sites = [{ siteId: 's_site', siteUrl: 'sc-domain:example.com' }]

    await expect(login()).resolves.toBe(0)

    expect(stderr).toContain('Next: run `gscdump sites` to see each Site and its sync state.')
    expect(stderr).not.toContain('connect a Site')
  })

  it('names the connect step in `auth status` when the record has no Sites', async () => {
    await fs.writeFile(path.join(runtime.configDir, 'authentication.json'), JSON.stringify({ _tag: 'Hosted', apiRoot: 'https://gscdump.com/api', sessionId: SESSION }))

    await expect(run(['auth', 'status'])).resolves.toBe(0)

    expect(stdout).toContain('  Sites: 0')
    expect(stdout).toContain(`  ${CONNECT} ${ACTIVATE}`)
  })
})

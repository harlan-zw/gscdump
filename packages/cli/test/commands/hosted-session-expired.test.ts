import type { CliRuntime } from '../../src/runtime'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { runCli } from '../../src/cli'
import { createCliRuntime } from '../../src/runtime'

// gscdump.com ends a CLI session 90 days after the browser login. It refuses
// the session with 401 and `details.reason: 'session_expired'`: in the h3 body
// of `/api/cli/*` (`data.details`) and in the v1 envelope (`error.details`).
// The CLI must say the session expired and name the login command.
const EXPIRED = 'Your gscdump.com session expired. Run `gscdump auth login --mode hosted`.'
const EXPIRED_STOP = { code: 'HOSTED_CREDENTIALS_REJECTED', message: EXPIRED, nextCommand: 'gscdump auth login --mode hosted' }

describe('an expired Hosted CLI session', () => {
  let runtime: CliRuntime
  let stdout: string[]
  let stderr: string
  let me: () => Response
  let rows: () => Response

  beforeEach(async () => {
    const configDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gscdump-session-expired-'))
    await fs.writeFile(path.join(configDir, 'config.json'), JSON.stringify({ dataDir: path.join(configDir, 'data') }))
    await fs.writeFile(path.join(configDir, 'authentication.json'), JSON.stringify({ _tag: 'Hosted', apiRoot: 'https://gscdump.com/api', sessionId: 'a'.repeat(64) }))
    stderr = ''
    stdout = []
    me = () => Response.json({
      user: { publicId: 'u_me', email: 'user@example.com' },
      sites: [{ siteId: 's_site', siteUrl: 'sc-domain:example.com', syncStatus: 'synced' }],
    })
    rows = () => Response.json({ error: { code: 'internal_error', message: 'Unexpected rows call', requestId: 'req_rows', retryable: false, details: {} } }, { status: 500 })
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
    vi.spyOn(console, 'log').mockImplementation((...args) => stdout.push(args.join(' ')))
    vi.spyOn(console, 'error').mockImplementation((...args) => {
      stderr += `${args.join(' ')}\n`
    })
    vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`process.exit(${code})`)
    }) as never)
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
      const url = new URL(input instanceof Request ? input.url : input)
      if (url.pathname === '/api/cli/me')
        return me()
      if (url.pathname === '/api/analytics/v1/sites/s_site/rows')
        return rows()
      throw new Error(`Unexpected request: ${url.pathname}`)
    }))
  })

  afterEach(async () => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    await fs.rm(runtime.configDir, { recursive: true, force: true })
  })

  const run = (args: string[]) => runCli({ rawArgs: args, runtime, loadEnv: false })
  const jsonError = () => JSON.parse(stdout.join('\n')).error

  it('says so when a CLI route refuses the session', async () => {
    me = () => Response.json({
      statusCode: 401,
      message: EXPIRED,
      data: { error: 'UNAUTHORIZED', message: EXPIRED, details: { reason: 'session_expired' } },
    }, { status: 401 })

    await expect(run(['indexing', 'summary', '--json'])).resolves.toBe(1)

    expect(jsonError()).toEqual(EXPIRED_STOP)
    expect(stderr).toContain(`Error: ${EXPIRED}`)
  })

  it('says so when the v1 API refuses the session', async () => {
    rows = () => Response.json({
      error: { code: 'unauthorized', message: EXPIRED, requestId: 'req_rows', retryable: false, details: { reason: 'session_expired' } },
    }, { status: 401 })

    await expect(run(['query', '--site', 'example.com', '--dimensions', 'date', '--limit', '7'])).resolves.toBe(1)

    expect(jsonError()).toEqual(EXPIRED_STOP)
    expect(stderr).toContain(`Error: ${EXPIRED}`)
    expect(stderr).not.toContain('Run `gscdump auth login` to sign in again.')
  })

  it('keeps the rejection message for a session refused for another reason', async () => {
    me = () => Response.json({ statusCode: 401, message: 'Invalid or revoked CLI session', data: { error: 'UNAUTHORIZED' } }, { status: 401 })

    await expect(run(['indexing', 'summary', '--json'])).resolves.toBe(1)

    expect(jsonError()).toEqual({
      code: 'HOSTED_CREDENTIALS_REJECTED',
      message: 'gscdump.com rejected the CLI session. Run `gscdump auth login --mode hosted` again.',
      nextCommand: 'gscdump auth login --mode hosted',
    })
  })
})

import type { CliRuntime } from '../../src/runtime'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { buildFleetSummary } from '@gscdump/sdk/fleet-summary'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { runCli } from '../../src/cli'
import { createCliRuntime } from '../../src/runtime'

const CODE = `S-${'D'.repeat(20)}`
const SESSION = 'd'.repeat(64)

describe('hosted CLI signup & Site setup UX', () => {
  let runtime: CliRuntime
  let stdout: string[]
  let stderr: string

  beforeEach(async () => {
    const configDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gscdump-hosted-signup-ux-'))
    stderr = ''
    stdout = []
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
  })

  afterEach(async () => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    await fs.rm(runtime.configDir, { recursive: true, force: true })
  })

  const run = (args: string[]) => runCli({ rawArgs: args, runtime, loadEnv: false })

  async function writeHostedSession() {
    await fs.writeFile(
      path.join(runtime.configDir, 'authentication.json'),
      JSON.stringify({ _tag: 'Hosted', apiRoot: 'https://gscdump.com/api', sessionId: SESSION }),
    )
  }

  it('prints auth URL to stderr and structured JSON to stdout on `auth login --mode hosted --json`', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
      const url = new URL(input instanceof Request ? input.url : input)
      if (url.pathname === '/api/cli/auth/init')
        return Response.json({ code: CODE, expiresIn: 600 })
      if (url.pathname === '/api/cli/auth/poll') {
        expect(url.searchParams.get('userAgent')).toContain('gscdump-cli/')
        return Response.json({ status: 'complete', sessionId: SESSION })
      }
      if (url.pathname === '/api/cli/me') {
        return Response.json({
          user: { publicId: 'u_1', email: 'dev@example.com' },
          hostedAccess: true,
          accountStatus: { hostedAccess: true, needsReauth: false, searchConsoleScopeGranted: true },
          sites: [],
        })
      }
      throw new Error(`Unexpected request: ${url.pathname}`)
    }))

    await expect(run(['auth', 'login', '--mode', 'hosted', '--no-browser', '--json'])).resolves.toBe(0)
    expect(stderr).toContain(`https://gscdump.com/app/cli/auth?code=${CODE}`)
    expect(stderr).toContain('Waiting for browser approval')
    const json = JSON.parse(stdout.join('\n'))
    expect(json).toMatchObject({
      authenticated: true,
      mode: 'hosted',
      account: 'dev@example.com',
      hostedAccess: true,
      sites: [],
    })
  })

  it('surfaces CLI session re-login guidance, account warnings, and Site holds in `auth status` and `doctor`', async () => {
    await writeHostedSession()
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ message: 'Upstream failed' }, { status: 503 })))

    await expect(run(['auth', 'status'])).resolves.toBe(0)
    expect(stderr).toContain('gscdump auth login --mode hosted')
    expect(stderr).not.toContain('the API key')

    stdout = []
    stderr = ''
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({
      user: { publicId: 'u_1', email: 'dev@example.com' },
      hostedAccess: false,
      accountStatus: { hostedAccess: false, needsReauth: false, searchConsoleScopeGranted: false },
      sites: [{
        siteId: 's_big',
        siteUrl: 'https://big.example.com/',
        syncStatus: 'idle',
        hold: 'size_limit',
        holdMessage: 'Use Local mode with your own Google keys for this Site.',
      }],
    })))

    await expect(run(['auth', 'status', '--json'])).resolves.toBe(0)
    const statusJson = JSON.parse(stdout.join('\n'))
    expect(statusJson.hostedAccess).toBe(false)
    expect(statusJson.warnings).toEqual(expect.arrayContaining([
      expect.stringContaining('https://gscdump.com/app/activate'),
      expect.stringContaining('Search Console read access is missing'),
    ]))
    expect(statusJson.hostedSync[0]).toMatchObject({
      hold: 'size_limit',
      holdMessage: expect.stringContaining('Local mode'),
    })

    stdout = []
    await expect(run(['doctor', '--json'])).resolves.toBe(0)
    const doctorJson = JSON.parse(stdout.join('\n'))
    expect(doctorJson.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'hosted.account', status: 'warn' }),
      expect.objectContaining({ name: 'hosted.holds', status: 'warn', detail: expect.stringContaining('size_limit') }),
    ]))
  })

  it('lists available properties and connects a Site by bare host or exact property in Hosted mode', async () => {
    await writeHostedSession()
    const connectBodies: unknown[] = []
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : input)
      if (url.pathname === '/api/cli/sites/available') {
        return Response.json({
          properties: [{
            propertyUrl: 'sc-domain:example.com',
            propertyType: 'domain',
            permissionLevel: 'siteOwner',
            canConnect: true,
            hostScope: 'domain',
            host: 'example.com',
            connected: false,
            connectedSites: [],
            estimate: { status: 'fits', lines: ['Fits beta allowance.'], inspectionDefault: true },
          }],
          sites: { used: 0, allowance: 10, remaining: 10 },
        })
      }
      if (url.pathname === '/api/cli/sites/connect') {
        connectBodies.push(JSON.parse(String(init?.body)))
        return Response.json({
          status: 'connected',
          message: 'Connected www.example.com as Site s_new.',
          site: { siteId: 's_new', siteUrl: 'www.example.com', propertyUrl: 'sc-domain:example.com', syncStatus: 'pending' },
          inspectionEnabled: true,
        })
      }
      throw new Error(`Unexpected request: ${url.pathname}`)
    }))

    await expect(run(['sites', 'available', '--json'])).resolves.toBe(0)
    expect(JSON.parse(stdout.join('\n')).properties[0].propertyUrl).toBe('sc-domain:example.com')

    stdout = []
    await expect(run(['sites', 'connect', 'www.example.com', '--json'])).resolves.toBe(0)
    expect(connectBodies[0]).toEqual({ propertyUrl: 'sc-domain:example.com', host: 'www.example.com' })
    expect(JSON.parse(stdout.join('\n'))).toMatchObject({ status: 'connected', site: { siteId: 's_new' } })

    stdout = []
    stderr = ''
    await expect(run(['sites', 'add', 'https://example.com/'])).resolves.toBe(1)
    expect(stderr).toContain('gscdump sites available')
    expect(stderr).toContain('gscdump sites connect')
  })

  it('stops `fleet` with NO_SITES on a 0-Site Hosted account instead of printing 0 unique Sites', async () => {
    await writeHostedSession()
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
      const url = new URL(input instanceof Request ? input.url : input)
      if (url.pathname === '/api/analytics/v1/fleet/summary') {
        return Response.json({
          data: buildFleetSummary({
            window: {
              startDate: '2026-10-01',
              endDate: '2026-10-28',
              days: 28,
              comparison: { startDate: '2026-09-03', endDate: '2026-09-30' },
            },
            searchType: 'web',
            sortBy: 'clicks',
            sortDir: 'desc',
            sites: [],
          }),
          meta: { requestId: 'req_empty', surface: 'analytics', version: '1.0' },
        })
      }
      if (url.pathname === '/api/cli/me')
        return Response.json({ user: { publicId: 'u_1', email: 'dev@example.com' }, sites: [] })
      throw new Error(`Unexpected request: ${url.pathname}`)
    }))

    await expect(run(['fleet', '--json'])).resolves.toBe(1)
    expect(JSON.parse(stdout.join('\n')).error.code).toBe('NO_SITES')
  })

  it('does not print a duplicate query Next block on `init --mode hosted` with 0 Sites', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
      const url = new URL(input instanceof Request ? input.url : input)
      if (url.pathname === '/api/cli/auth/init')
        return Response.json({ code: CODE, expiresIn: 600 })
      if (url.pathname === '/api/cli/auth/poll')
        return Response.json({ status: 'complete', sessionId: SESSION })
      if (url.pathname === '/api/cli/me')
        return Response.json({ user: { publicId: 'u_1', email: 'dev@example.com' }, sites: [] })
      throw new Error(`Unexpected request: ${url.pathname}`)
    }))

    await expect(run(['init', '--mode', 'hosted', '--no-browser'])).resolves.toBe(0)
    expect(stdout.join('\n')).not.toContain('gscdump query --site <site>')
  })

  it('isolates partner API keys in warnings and `sites add` without naming gscdump.com', async () => {
    await fs.writeFile(
      path.join(runtime.configDir, 'authentication.json'),
      JSON.stringify({ _tag: 'Hosted', apiRoot: 'https://gscdump.com/api', apiKey: 'gsd_user_partner_key' }),
    )
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({
      user: { publicId: 'u_partner', email: 'partner@example.com' },
      hostedAccess: false,
      accountStatus: { hostedAccess: false, needsReauth: true, searchConsoleScopeGranted: false },
      issuer: { _tag: 'partner', name: 'Request Indexing' },
      sites: [],
    })))

    await expect(run(['auth', 'status', '--json'])).resolves.toBe(0)
    const statusJson = JSON.parse(stdout.join('\n'))
    expect(statusJson.warnings).toEqual(['Google access expired. Reconnect Google in Request Indexing.'])
    expect(JSON.stringify(statusJson.warnings)).not.toContain('gscdump.com')

    stdout = []
    await expect(run(['doctor', '--json'])).resolves.toBe(0)
    const doctorJson = JSON.parse(stdout.join('\n'))
    expect(doctorJson.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'hosted.account', status: 'warn', detail: 'Google access expired. Reconnect Google in Request Indexing.' }),
    ]))

    stdout = []
    stderr = ''
    await expect(run(['sites', 'add', 'https://example.com/'])).resolves.toBe(1)
    expect(stderr).not.toContain('gscdump.com')
    expect(stderr).not.toContain('gscdump sites available')
  })

  it('does not misclassify Hosted 403 refusals as Google Search Console permission errors', async () => {
    await writeHostedSession()
    vi.stubGlobal('fetch', vi.fn(async () => Response.json(
      { data: { message: 'Hosted access is required before connecting Sites.' } },
      { status: 403 },
    )))

    await expect(run(['sites', 'connect', 'sc-domain:example.com', '--json'])).resolves.toBe(1)
    const json = JSON.parse(stdout.join('\n'))
    expect(json.error.message).toContain('Hosted access is required before connecting Sites.')
    expect(json.error.message).not.toContain('full user or owner')
    expect(stderr).not.toContain('Auth sources:')
  })

  it('handles `sites connect` edge cases: subpath exclusion, exact hostScope, trailing dots, case-insensitive sc-domain, and --no-inspect', async () => {
    await writeHostedSession()
    const connectBodies: unknown[] = []
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : input)
      if (url.pathname === '/api/cli/sites/available') {
        return Response.json({
          properties: [
            {
              propertyUrl: 'https://example.com/blog/',
              propertyType: 'url-prefix',
              permissionLevel: 'siteOwner',
              canConnect: true,
              hostScope: 'exact',
              host: 'example.com',
              connected: false,
              connectedSites: [],
            },
            {
              propertyUrl: 'https://example.com/',
              propertyType: 'url-prefix',
              permissionLevel: 'siteOwner',
              canConnect: true,
              hostScope: 'exact',
              host: 'example.com',
              connected: false,
              connectedSites: [],
            },
          ],
          sites: { used: 0, allowance: 10, remaining: 10 },
        })
      }
      if (url.pathname === '/api/cli/sites/connect') {
        connectBodies.push(JSON.parse(String(init?.body)))
        return Response.json({
          status: 'connected',
          message: 'Connected example.com.',
          site: { siteId: 's_1', siteUrl: 'https://example.com/', propertyUrl: 'https://example.com/' },
        })
      }
      throw new Error(`Unexpected request: ${url.pathname}`)
    }))

    // Bare host with trailing dot ignores `/blog/` subpath and does not send `host` for exact URL-prefix
    await expect(run(['sites', 'connect', 'example.com.', '--no-inspect', '--json'])).resolves.toBe(0)
    expect(connectBodies[0]).toEqual({ propertyUrl: 'https://example.com/', inspectionEnabled: false })

    // Case-insensitive SC-DOMAIN skips `/available` lookup and normalizes prefix
    stdout = []
    await expect(run(['sites', 'connect', 'SC-DOMAIN:example.com', '--json'])).resolves.toBe(0)
    expect(connectBodies[1]).toEqual({ propertyUrl: 'sc-domain:example.com' })

    // Rejects --host on URL-prefix property and rejects invalid bare host
    stdout = []
    await expect(run(['sites', 'connect', 'https://example.com/', '--host', 'www.example.com', '--json'])).resolves.toBe(1)
    expect(JSON.parse(stdout.join('\n')).error.code).toBe('USAGE')

    stdout = []
    await expect(run(['sites', 'connect', 'foo/bar.example.com', '--json'])).resolves.toBe(1)
    expect(JSON.parse(stdout.join('\n')).error.code).toBe('USAGE')
  })

  it('honors GSCDUMP_AUTH_MODE=hosted and GSCDUMP_API_KEY on `init`', async () => {
    runtime.environment.GSCDUMP_API_KEY = 'gsd_user_env_key'
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
      const url = new URL(input instanceof Request ? input.url : input)
      if (url.pathname === '/api/cli/me')
        return Response.json({ user: { publicId: 'u_env', email: 'env@example.com' }, sites: [] })
      throw new Error(`Unexpected request: ${url.pathname}`)
    }))

    await expect(run(['init', '--json'])).resolves.toBe(0)
    expect(JSON.parse(stdout.join('\n'))).toMatchObject({ authenticated: true, account: 'env@example.com' })
  })

  it('returns an empty summary for `fleet` when Hosted account has Sites but summary is empty', async () => {
    await writeHostedSession()
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
      const url = new URL(input instanceof Request ? input.url : input)
      if (url.pathname === '/api/analytics/v1/fleet/summary') {
        return Response.json({
          data: buildFleetSummary({
            window: {
              startDate: '2026-10-01',
              endDate: '2026-10-28',
              days: 28,
              comparison: { startDate: '2026-09-03', endDate: '2026-09-30' },
            },
            searchType: 'web',
            sortBy: 'clicks',
            sortDir: 'desc',
            sites: [],
          }),
          meta: { requestId: 'req_empty_with_sites', surface: 'analytics', version: '1.0' },
        })
      }
      if (url.pathname === '/api/cli/me')
        return Response.json({ user: { publicId: 'u_1', email: 'dev@example.com' }, sites: [{ siteId: 's_1', siteUrl: 'https://example.com/' }] })
      throw new Error(`Unexpected request: ${url.pathname}`)
    }))

    await expect(run(['fleet', '--json'])).resolves.toBe(0)
    expect(JSON.parse(stdout.join('\n')).sites).toEqual([])
  })

  it('classifies Hosted v1 401 and 403 errors without leaking Google hints or Local Auth config sources', async () => {
    await writeHostedSession()
    vi.stubGlobal('fetch', vi.fn(async () => Response.json(
      {
        error: { code: 'unauthorized', message: 'Invalid CLI session', requestId: 'req_401', retryable: false, details: {} },
      },
      { status: 401 },
    )))

    await expect(run(['fleet', '--json'])).resolves.toBe(1)
    expect(JSON.parse(stdout.join('\n')).error).toEqual({
      code: 'HOSTED_CREDENTIALS_REJECTED',
      message: 'gscdump.com rejected the CLI session. Run `gscdump auth login --mode hosted` again.',
      nextCommand: 'gscdump auth login --mode hosted',
    })
    expect(stderr).not.toContain('Auth config sources')

    stdout = []
    stderr = ''
    vi.stubGlobal('fetch', vi.fn(async () => Response.json(
      {
        error: { code: 'forbidden', message: 'Hosted access is required.', requestId: 'req_403', retryable: false, details: {} },
      },
      { status: 403 },
    )))

    await expect(run(['fleet', '--json'])).resolves.toBe(1)
    const err403 = JSON.parse(stdout.join('\n')).error
    expect(err403.message).toBe('Hosted access is required.')
    expect(err403.message).not.toContain('full user or owner')
    expect(stderr).not.toContain('Auth config sources')
  })
})

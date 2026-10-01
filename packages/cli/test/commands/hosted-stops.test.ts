import type { CliRuntime } from '../../src/runtime'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { runCli } from '../../src/cli'
import { createCliRuntime } from '../../src/runtime'

// 2026-10-01 UX replay: a partner user ran `gscdump indexing summary --json`
// with an API key from Request Indexing and an account with no Sites. stdout
// was empty, and stderr sent the user to gscdump.com, a product they never
// signed up for.
describe('hosted mode stops', () => {
  let runtime: CliRuntime
  let stdout: string[]
  let stderr: string
  let accountSites: { siteId: string, siteUrl: string }[]
  let meStatus: number

  beforeEach(async () => {
    const configDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gscdump-hosted-stops-'))
    await fs.writeFile(path.join(configDir, 'config.json'), JSON.stringify({ dataDir: path.join(configDir, 'data') }))
    stderr = ''
    stdout = []
    accountSites = []
    meStatus = 200
    runtime = createCliRuntime({
      configDir,
      environment: { GSCDUMP_API_KEY: 'gsd_user_partner', GSCDUMP_CONFIG_DIR: configDir },
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
      if (url.pathname === '/api/cli/me') {
        return meStatus === 200
          ? Response.json({ user: { publicId: 'u_me', email: 'user@example.com' }, sites: accountSites })
          : Response.json({ message: 'Invalid API key' }, { status: meStatus })
      }
      throw new Error(`Unexpected request: ${url.pathname}`)
    }))
  })

  afterEach(async () => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    await fs.rm(runtime.configDir, { recursive: true, force: true })
  })

  const run = (args: string[]) => runCli({ rawArgs: args, runtime })
  const jsonError = () => JSON.parse(stdout.join('\n')).error

  it.each([
    ['indexing summary', ['indexing', 'summary', '--json']],
    ['indexing urls', ['indexing', 'urls', '--format', 'json']],
    ['indexing watch list', ['indexing', 'watch', 'list', '--json']],
    ['sitemaps current', ['sitemaps', 'current', '--json']],
    ['query with its default JSON format', ['query', '-d', 'page']],
    ['bing inspect', ['bing', 'inspect', 'https://example.com/', '--site', 'example.com', '--json']],
  ])('%s prints NO_SITES on stdout and never names gscdump.com for an API key', async (_label, args) => {
    await expect(run(args)).resolves.toBe(1)

    expect(jsonError()).toEqual({
      code: 'NO_SITES',
      message: 'Your hosted record has no Sites. Connect a Site in the app that issued this API key. Then run the command again.',
      nextCommand: null,
    })
    expect(stderr).toContain('Error: Your hosted record has no Sites.')
    expect(stderr).not.toContain('gscdump.com')
  })

  it('names the gscdump.com onboarding page for a browser CLI session', async () => {
    runtime.environment = { GSCDUMP_CONFIG_DIR: runtime.configDir }
    await fs.writeFile(path.join(runtime.configDir, 'authentication.json'), JSON.stringify({ _tag: 'Hosted', apiRoot: 'https://gscdump.com/api', sessionId: 'a'.repeat(64) }))

    await expect(run(['indexing', 'summary', '--json'])).resolves.toBe(1)

    expect(jsonError()).toMatchObject({
      code: 'NO_SITES',
      message: 'Your hosted record has no Sites. Connect a Site at https://gscdump.com/app/onboarding?step=connect-sites. Then run the command again.',
    })
  })

  it.each([
    ['table output', ['indexing', 'summary']],
    ['CSV output', ['indexing', 'urls', '--format', 'csv']],
  ])('keeps stdout empty with %s', async (_label, args) => {
    await expect(run(args)).resolves.toBe(1)

    expect(stdout).toEqual([])
    expect(stderr).toContain('Error: Your hosted record has no Sites. Connect a Site in the app that issued this API key.')
  })

  it.each([
    ['SITE_NOT_FOUND', ['indexing', 'summary', '--site', 'missing.dev', '--json'], 'No hosted Site matches "missing.dev". Hosted Sites: sc-domain:example.com, https://other.dev/.'],
    ['SITE_REQUIRED', ['indexing', 'summary', '--json'], 'Pass --site. Hosted Sites: sc-domain:example.com, https://other.dev/.'],
  ])('prints %s with the command that lists the Sites', async (code, args, message) => {
    accountSites = [{ siteId: 's_site', siteUrl: 'sc-domain:example.com' }, { siteId: 's_other', siteUrl: 'https://other.dev/' }]

    await expect(run(args)).resolves.toBe(1)

    expect(jsonError()).toEqual({ code, message, nextCommand: 'gscdump sites --json' })
  })

  it('prints HOSTED_MODE_REQUIRED for a hosted command in Local mode', async () => {
    runtime.environment = { GSCDUMP_CONFIG_DIR: runtime.configDir }

    await expect(run(['indexing', 'summary', '--json'])).resolves.toBe(1)

    expect(jsonError()).toMatchObject({ code: 'HOSTED_MODE_REQUIRED', nextCommand: 'gscdump auth login --mode hosted' })
  })

  it('prints LOCAL_MODE_REQUIRED for a Google command in Hosted mode', async () => {
    await expect(run(['inspect', 'https://example.com/', '--site', 'example.com', '--json'])).resolves.toBe(1)

    expect(jsonError()).toMatchObject({ code: 'LOCAL_MODE_REQUIRED', nextCommand: 'gscdump auth login --mode local' })
  })

  it('prints HOSTED_CREDENTIALS_REJECTED when the host rejects the API key', async () => {
    meStatus = 401

    await expect(run(['indexing', 'summary', '--json'])).resolves.toBe(1)

    expect(jsonError()).toMatchObject({ code: 'HOSTED_CREDENTIALS_REJECTED', nextCommand: null })
  })
})

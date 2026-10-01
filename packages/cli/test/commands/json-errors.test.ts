import type { CliRuntime } from '../../src/runtime'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { runCli } from '../../src/cli'
import { createCliRuntime } from '../../src/runtime'

// 2026-10-01 UX replay: `query --format json` printed its failures as plain
// text, so an agent that parsed stdout read nothing. Under JSON output, every
// failure prints `{ error: { code, message, nextCommand } }` on stdout.
describe('json errors', () => {
  let runtime: CliRuntime
  let stdout: string[]
  let stderr: string
  let me: () => Response

  beforeEach(async () => {
    const configDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gscdump-json-errors-'))
    await fs.writeFile(path.join(configDir, 'config.json'), JSON.stringify({ dataDir: path.join(configDir, 'data') }))
    stderr = ''
    stdout = []
    me = () => Response.json({ user: { publicId: 'u_me', email: 'user@example.com' }, sites: [{ siteId: 's_site', siteUrl: 'sc-domain:example.com' }] })
    runtime = createCliRuntime({
      configDir,
      environment: { GSCDUMP_API_KEY: 'gsd_user_key', GSCDUMP_CONFIG_DIR: configDir },
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

  it.each([
    ['--limit', ['--limit', '0'], 'Invalid --limit. Use a positive safe integer, such as --limit 1000.'],
    ['--dimensions', ['--dimensions', 'keyword'], 'Invalid --dimensions. Use a comma-separated list from:'],
    ['--type', ['--type', 'shopping'], 'Invalid --type: shopping.'],
  ])('query --format json prints an invalid %s as a USAGE error', async (_flag, flags, message) => {
    await expect(run(['query', '--site', 'example.com', '--format', 'json', ...flags])).resolves.toBe(1)

    expect(jsonError()).toMatchObject({ code: 'USAGE', nextCommand: null })
    expect(jsonError().message).toContain(message)
    expect(stderr).toContain(message)
  })

  it('query --format json prints a failed hosted request as FAILED', async () => {
    me = () => Response.json({ message: 'Server error' }, { status: 500 })

    await expect(run(['query', '--site', 'example.com', '-d', 'page', '--format', 'json'])).resolves.toBe(1)

    expect(jsonError()).toEqual({
      code: 'FAILED',
      message: 'Hosted request failed (500) for /cli/me. Check `gscdump auth status`.',
      nextCommand: null,
    })
  })

  it('prints a usage error as JSON when the command line asks for JSON', async () => {
    await expect(run(['indexing', 'summary', '--json', '--no-such-flag'])).resolves.toBe(1)

    expect(jsonError()).toMatchObject({ code: 'USAGE', nextCommand: null })
  })

  it('keeps stdout empty for a failure without JSON output', async () => {
    me = () => Response.json({ message: 'Server error' }, { status: 500 })

    await expect(run(['query', '--site', 'example.com', '-d', 'page', '--format', 'table'])).resolves.toBe(1)

    expect(stdout).toEqual([])
    expect(stderr).toContain('Hosted request failed (500)')
  })
})

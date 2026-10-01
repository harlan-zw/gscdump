import type { CliRuntime } from '../../src/runtime'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { runCli } from '../../src/cli'
import { createCliRuntime } from '../../src/runtime'

// 2026-10-01 replay: a Hosted `query` right after the first Sync printed
// `total: 0` and exited 0, because the host answered an unreadable record
// with an empty 200. The host now refuses that read with a typed 409. The CLI
// must say why in plain words, name the next step, and exit non-zero.
describe('hosted query when the Site\'s record cannot serve the read', () => {
  let runtime: CliRuntime
  let stdout: string[]
  let stderr: string
  let refusal: Record<string, unknown>

  beforeEach(async () => {
    const configDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gscdump-hosted-refusal-'))
    await fs.writeFile(path.join(configDir, 'config.json'), JSON.stringify({ dataDir: path.join(configDir, 'data') }))
    stderr = ''
    stdout = []
    runtime = createCliRuntime({
      configDir,
      environment: { GSCDUMP_API_KEY: 'gsd_user_private', GSCDUMP_CONFIG_DIR: configDir },
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
      if (url.origin !== 'https://gscdump.com')
        throw new Error(`Hosted mode called ${url.origin}`)
      if (url.pathname === '/api/cli/me') {
        return Response.json({
          user: { publicId: 'u_me', email: 'user@example.com' },
          sites: [{ siteId: 's_site', siteUrl: 'sc-domain:harlanzw.com', syncStatus: 'synced' }],
        })
      }
      if (url.pathname === '/api/analytics/v1/sites/s_site/rows') {
        return Response.json({
          error: { code: 'invalid_request', message: 'The record for this Site is not readable yet. Try again in a few minutes.', requestId: 'req_rows', retryable: false, details: refusal },
        }, { status: 409 })
      }
      throw new Error(`Unexpected request: ${url.pathname}`)
    }))
  })

  afterEach(async () => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    await fs.rm(runtime.configDir, { recursive: true, force: true })
  })

  const query = () => runCli({ rawArgs: ['query', '--site', 'harlanzw.com', '--dimensions', 'date', '--limit', '7'], runtime, loadEnv: false })

  it('says the record is not readable yet, when Sync finished, and exits non-zero', async () => {
    refusal = { reason: 'record_not_ready', syncStatus: 'synced', lastSyncAt: 1790824592, oldestDateSynced: '2025-05-30', newestDateSynced: '2026-09-29' }

    await expect(query()).resolves.toBe(1)

    expect(stderr).toContain('Error: The Site\'s record is not readable yet.')
    expect(stderr).toContain('Sync finished at 2026-10-01 03:16 UTC. gscdump prepares the record for reads after Sync. Try again in a few minutes.')
    expect(stdout.join('\n')).not.toContain('No results')
  })

  it('prints the refusal as a JSON stop with a code in the default JSON format', async () => {
    refusal = { reason: 'range_not_synced', missingStart: '2026-09-03', missingEnd: '2026-09-12', syncStatus: 'syncing', oldestDateSynced: '2026-09-13', newestDateSynced: '2026-09-29' }

    await expect(query()).resolves.toBe(1)

    expect(JSON.parse(stdout.join('\n'))).toEqual({
      error: {
        code: 'RANGE_NOT_SYNCED',
        message: 'The Site\'s record does not hold 2026-09-03 to 2026-09-12. Sync covers 2026-09-13 to 2026-09-29. Sync is still running. Try again when it finishes.',
        nextCommand: null,
      },
    })
  })

  it('names the missing days and waits for a running Sync', async () => {
    refusal = { reason: 'range_not_synced', missingStart: '2026-09-03', missingEnd: '2026-09-12', syncStatus: 'syncing', oldestDateSynced: '2026-09-13', newestDateSynced: '2026-09-29' }

    await expect(query()).resolves.toBe(1)

    expect(stderr).toContain('Error: The Site\'s record does not hold 2026-09-03 to 2026-09-12.')
    expect(stderr).toContain('Sync covers 2026-09-13 to 2026-09-29. Sync is still running. Try again when it finishes.')
  })

  // Production, 2026-10-01: the Site reported Sync through 2026-09-29 while the
  // record stopped at 2026-09-28. The hint said the record held 2026-09-29.
  it('does not claim the record holds days Sync covered but the record lacks', async () => {
    refusal = { reason: 'range_not_synced', missingStart: '2026-09-29', missingEnd: '2026-09-29', syncStatus: 'synced', lastSyncAt: 1790824592, oldestDateSynced: '2025-05-30', newestDateSynced: '2026-09-29' }

    await expect(query()).resolves.toBe(1)

    expect(stderr).toContain('Error: The Site\'s record does not hold 2026-09-29.')
    expect(stderr).toContain('Sync covers these days, but the record does not hold them yet. Pick an earlier end date with --end, or try again later.')
    expect(stderr).not.toContain('holds 2025-05-30 to 2026-09-29')
  })

  it('points a finished Sync at the dates it covers', async () => {
    refusal = { reason: 'range_not_synced', missingStart: '2026-07-01', missingEnd: '2026-07-31', syncStatus: 'synced', oldestDateSynced: '2026-09-01', newestDateSynced: '2026-09-29' }

    await expect(query()).resolves.toBe(1)

    expect(stderr).toContain('Sync covers 2026-09-01 to 2026-09-29. Pick dates in that range with --start and --end.')
  })
})

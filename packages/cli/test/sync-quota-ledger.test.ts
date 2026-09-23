import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { resetNodeDuckDB } from '@gscdump/engine/node'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { runCli } from '../src/cli'

// The shared setup file mocks ofetch; this test drives the real client over a stubbed fetch.
vi.mock('ofetch', async () => await vi.importActual('ofetch'))

const SITES = { siteEntry: [{ siteUrl: 'sc-domain:example.com', permissionLevel: 'siteOwner' }] }

describe('sync quota budget', () => {
  let root: string
  let queryCalls: number

  beforeEach(async () => {
    resetNodeDuckDB()
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'gscdump-sync-quota-'))
    await fs.writeFile(path.join(root, 'config.json'), JSON.stringify({ dataDir: path.join(root, 'data') }))
    queryCalls = 0
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
      const url = String(input instanceof Request ? input.url : input)
      if (url.includes('/searchAnalytics/query')) {
        queryCalls++
        return Response.json({ error: { code: 403, message: 'Search Analytics load quota exceeded.', errors: [{ reason: 'quotaExceeded' }] } }, { status: 403 })
      }
      return url.endsWith('/webmasters/v3/sites') ? Response.json(SITES) : Response.json({})
    }))
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
  })

  afterEach(async () => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    resetNodeDuckDB()
    await fs.rm(root, { recursive: true, force: true })
  })

  it('sends a quota-refused call once and lets the ledger stop the run', async () => {
    const code = await runCli({
      rawArgs: ['sync', '--site', 'example.com', '--tables', 'pages', '--types', 'web', '--start', '2026-08-01', '--end', '2026-08-01', '--no-sitemaps', '--no-inspections', '--concurrency', '1', '--json'],
      environment: { GSCDUMP_CONFIG_DIR: root, GSC_ACCESS_TOKEN: 'token', GSCDUMP_AUTH_MODE: 'local' },
      loadEnv: false,
    })

    expect(code).toBe(0)
    expect(queryCalls).toBe(1)
  }, 20_000)
})

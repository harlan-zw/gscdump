import type { TableName } from '../../src/local-store'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { resetNodeDuckDB } from '@gscdump/engine/node'
import { getNextPstMidnight } from 'gscdump/dates'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { runCli } from '../../src/cli'
import { createLocalStore } from '../../src/local-store'
import { recordStoreSite } from '../../src/store-sites'

// The shared setup file mocks ofetch; these tests drive the real client over a stubbed fetch.
vi.mock('ofetch', async () => await vi.importActual('ofetch'))

const SITE = 'sc-domain:example.com'
const SITES = { siteEntry: [{ siteUrl: SITE, permissionLevel: 'siteOwner' }] }
const LIVE_ROWS = { rows: [{ keys: ['https://example.com/live'], clicks: 7, impressions: 70, ctr: 0.1, position: 2 }] }
const RANGE = ['--start', '2026-08-01', '--end', '2026-08-03']

interface Run { code: number, stdout: string, stderr: string }

describe('read routing', () => {
  let root: string
  let dataDir: string
  let analyticsCalls: number

  beforeEach(async () => {
    resetNodeDuckDB()
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'gscdump-routing-'))
    dataDir = path.join(root, 'data')
    await fs.writeFile(path.join(root, 'config.json'), JSON.stringify({ dataDir }))
    analyticsCalls = 0
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
      const url = String(input instanceof Request ? input.url : input)
      if (url.includes('/searchAnalytics/query')) {
        analyticsCalls++
        return Response.json(analyticsCalls === 1 ? LIVE_ROWS : {})
      }
      if (url.endsWith('/webmasters/v3/sites'))
        return Response.json(SITES)
      throw new Error(`Unexpected request: ${url}`)
    }))
  })

  afterEach(async () => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    resetNodeDuckDB()
    await fs.rm(root, { recursive: true, force: true })
  })

  async function seed(table: TableName, dates: string[]): Promise<void> {
    const store = createLocalStore({ dataDir })
    const scope = { userId: store.userId, siteId: store.siteIdFor(SITE), table }
    for (const date of dates) {
      await store.engine.writeDay({ ...scope, date }, [{ date, url: '/stored', clicks: 1, impressions: 10, sum_position: 0 }])
      await store.engine.setSyncState({ ...scope, date }, 'done')
    }
    expect((await recordStoreSite(dataDir, SITE)).ok).toBe(true)
  }

  async function writeSyncRun(heartbeatAgoMs: number): Promise<void> {
    const now = Date.now()
    await fs.mkdir(dataDir, { recursive: true })
    await fs.writeFile(path.join(dataDir, 'sync-run.json'), JSON.stringify({ pid: process.pid, startedAt: now - 60_000, heartbeatAt: now - heartbeatAgoMs, sites: [SITE], site: SITE, planned: 90, done: 41 }))
  }

  async function cli(args: string[], auth: 'google' | 'none' = 'google'): Promise<Run> {
    const stdout: string[] = []
    const stderr: string[] = []
    vi.spyOn(console, 'log').mockImplementation((...values: unknown[]) => stdout.push(values.map(String).join(' ')))
    for (const method of ['error', 'warn', 'info'] as const)
      vi.spyOn(console, method).mockImplementation((...values: unknown[]) => stderr.push(values.map(String).join(' ')))
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => {
      stderr.push(String(chunk))
      return true
    })
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    const code = await runCli({
      rawArgs: args,
      environment: { GSCDUMP_CONFIG_DIR: root, GSCDUMP_AUTH_MODE: 'local', NO_COLOR: '1', ...(auth === 'google' ? { GSC_ACCESS_TOKEN: 'token' } : {}) },
      loadEnv: false,
    })
    vi.restoreAllMocks()
    return { code, stdout: stdout.join('\n'), stderr: stderr.join('\n') }
  }

  const query = (...extra: string[]) => ['query', '--site', 'example.com', '-d', 'page', ...RANGE, '-f', 'json', ...extra]

  it('asks to connect Google when there is no auth and no data', async () => {
    const run = await cli(query(), 'none')
    expect(run.code).toBe(1)
    expect(run.stderr).toContain('Run `gscdump init`')
    expect(JSON.parse(run.stdout).error).toMatchObject({ code: 'NOT_CONNECTED', nextCommand: 'gscdump init' })
    expect(analyticsCalls).toBe(0)
  })

  it('answers from the live API when the Site has no Store data, and says so', async () => {
    const run = await cli(query())
    expect(run.code, run.stderr).toBe(0)
    expect(run.stderr).toContain('No synced data for sc-domain:example.com; answering from the live Search Console API.')
    const payload = JSON.parse(run.stdout)
    expect(payload.meta).toEqual({ source: 'live' })
    expect(payload.data).toEqual([{ page: 'https://example.com/live', clicks: 7, impressions: 70, ctr: 0.1, position: 2 }])
  })

  it('marks an analyzer run from the live API as meta.source live', async () => {
    const run = await cli(['analyze', 'striking-distance', '--site', 'example.com', ...RANGE, '--json'])
    expect(run.code, run.stderr).toBe(0)
    expect(run.stderr).toContain('answering from the live Search Console API')
    expect(JSON.parse(run.stdout).meta.source).toBe('live')
  })

  it('asks to sync the missing days when coverage is partial', async () => {
    await seed('pages', ['2026-08-01', '2026-08-03'])
    const run = await cli(query())
    expect(run.code).toBe(1)
    expect(run.stderr).toContain('The Store has 2 of 3 days for sc-domain:example.com.')
    expect(JSON.parse(run.stdout).error).toMatchObject({
      code: 'STORE_RANGE_NOT_COVERED',
      missingDates: ['2026-08-02'],
      nextCommand: 'gscdump sync --site example.com --start 2026-08-02 --end 2026-08-02 --tables pages',
    })
    expect(analyticsCalls).toBe(0)
  })

  it('shows sync progress when a running sync has not covered the range', async () => {
    await seed('pages', ['2026-08-01'])
    await writeSyncRun(1_000)
    const run = await cli(query())
    expect(run.code).toBe(1)
    expect(run.stderr).toContain('Sync running: 41 of 90 days done. Run again when it finishes, or pass --live.')
    expect(JSON.parse(run.stdout).error).toMatchObject({ code: 'SYNC_RUNNING', sync: { done: 41, total: 90 } })
  })

  it('answers from the Store while a sync runs when the range is covered', async () => {
    await seed('pages', ['2026-08-01', '2026-08-02', '2026-08-03'])
    await writeSyncRun(1_000)
    const run = await cli(query())
    expect(run.code, run.stderr).toBe(0)
    expect(JSON.parse(run.stdout)).toMatchObject({ meta: { source: 'local' }, data: [{ page: '/stored', clicks: 3 }] })
    expect(analyticsCalls).toBe(0)
  })

  it('treats a sync without a recent heartbeat as not running', async () => {
    await seed('pages', ['2026-08-01'])
    await writeSyncRun(10 * 60_000)
    const run = await cli(query())
    expect(run.code).toBe(1)
    expect(run.stderr).not.toContain('Sync running')
    expect(JSON.parse(run.stdout).error.code).toBe('STORE_RANGE_NOT_COVERED')
  })

  it('goes live with --live even when the Store covers the range', async () => {
    await seed('pages', ['2026-08-01', '2026-08-02', '2026-08-03'])
    const run = await cli(query('--live'))
    expect(run.code, run.stderr).toBe(0)
    expect(run.stderr).not.toContain('No synced data')
    expect(JSON.parse(run.stdout).meta).toEqual({ source: 'live' })
    expect(analyticsCalls).toBeGreaterThan(0)
  })

  it('asks to sync before --sql when the Store has no data', async () => {
    const run = await cli(['query', '--sql', 'SELECT SUM(clicks) AS clicks FROM pages', '--site', 'example.com', '-f', 'json'])
    expect(run.code).toBe(1)
    expect(JSON.parse(run.stdout).error).toMatchObject({ code: 'NO_SYNCED_DATA', nextCommand: 'gscdump sync --site example.com --tables pages' })
    expect(analyticsCalls).toBe(0)
  })

  it('says when the quota resets instead of calling Google', async () => {
    const until = getNextPstMidnight(new Date())
    await fs.mkdir(dataDir, { recursive: true })
    await fs.writeFile(path.join(dataDir, 'quota-ledger.json'), JSON.stringify({
      version: 1,
      usage: [{ api: 'searchAnalytics', site: SITE, day: '2026-01-01', used: 1, blockedUntil: until, reason: '403 Search Analytics load quota exceeded.' }],
    }))
    for (const args of [query(), ['analyze', 'striking-distance', '--site', 'example.com', ...RANGE, '--json']]) {
      const run = await cli(args)
      expect(run.code).toBe(1)
      expect(run.stderr).toContain('The Google Search Analytics quota for sc-domain:example.com is used up')
      expect(run.stderr).toContain('It resets at')
      expect(run.stderr).not.toContain('Error:')
    }
    expect(analyticsCalls).toBe(0)
  })
})

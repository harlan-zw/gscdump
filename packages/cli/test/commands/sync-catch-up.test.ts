import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { createNodeHarness, resetNodeDuckDB } from '@gscdump/engine/node'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { runCli } from '../../src/cli'

const state: { dataDir: string, configDir: string } = { dataDir: '', configDir: '' }
const SITE = 'sc-domain:example.com'
const OTHER = 'https://other.example.com/'

const querySpy = vi.fn()
const sitesSpy = vi.fn()

vi.mock('gscdump/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('gscdump/client')>()
  return {
    ...actual,
    googleSearchConsole: vi.fn(() => ({
      sites: sitesSpy,
      searchAnalytics: { query: querySpy },
      sitemaps: { list: vi.fn(async () => []) },
      inspect: vi.fn(),
    })),
  }
})

vi.mock('../../src/auth', () => ({
  getAuth: vi.fn(() => Promise.resolve({})),
  resolveAuth: vi.fn(() => Promise.resolve({})),
  resolveBYOK: vi.fn(() => null),
}))

vi.mock('../../src/config', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/config')>()
  return {
    ...actual,
    loadConfig: vi.fn(() => Promise.resolve({ dataDir: state.dataDir })),
    loadResolvedConfig: vi.fn(() => Promise.resolve({ config: { dataDir: state.dataDir }, dataDir: state.dataDir })),
  }
})

afterAll(() => {
  resetNodeDuckDB()
})

function row(params: { startDate: string, dimensions?: string[] }) {
  const keys = (params.dimensions ?? []).map(dim => dim === 'date' ? params.startDate : dim === 'page' ? 'https://example.com/a' : 'x')
  return { keys, clicks: 1, impressions: 10, ctr: 0.1, position: 2 }
}

function googleError(status: number, message: string, reason: string): Error {
  return Object.assign(new Error(`[POST] "https://searchconsole.googleapis.com": ${status}`), {
    status,
    statusCode: status,
    data: { error: { code: status, message, errors: [{ reason, message }] } },
  })
}

interface Run {
  exitCode: number | undefined
  stdout: string[]
  json: () => any
}

async function sync(...flags: string[]): Promise<Run> {
  const stdout: string[] = []
  const result: Run = {
    exitCode: undefined,
    stdout,
    json: () => JSON.parse(stdout.find(line => line.trimStart().startsWith('{'))!),
  }
  const log = vi.spyOn(console, 'log').mockImplementation(value => stdout.push(String(value)))
  const exit = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    result.exitCode = code ?? 0
    // The Ctrl+C handler exits from a promise chain; record the code and let the run finish.
    if (code === 130)
      return undefined as never
    throw new Error(`process.exit(${code})`)
  }) as never)
  // runCli catches every failure and returns 1; a mocked exit keeps its own code.
  const code = await runCli({
    rawArgs: ['sync', ...flags],
    loadEnv: false,
    environment: { GSCDUMP_CONFIG_DIR: state.configDir, GSCDUMP_AUTH_MODE: 'local' },
  })
  if (code !== 0)
    result.exitCode ??= code
  log.mockRestore()
  exit.mockRestore()
  return result
}

const QUIET = ['--tables', 'pages', '--types', 'web', '--no-sitemaps', '--no-inspections', '--no-rollups', '--requests-per-minute', '1000000']

function fetchedDates(site = SITE): string[] {
  return querySpy.mock.calls.filter(([siteUrl]) => siteUrl === site).map(([, params]) => params.startDate as string)
}

async function states(table = 'pages') {
  const harness = createNodeHarness({ dataDir: state.dataDir })
  return harness.engine.getSyncStates({ userId: harness.userId, siteId: harness.siteIdFor(SITE), table: table as 'pages' })
}

describe('sync catch-up', () => {
  beforeEach(async () => {
    state.dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gscdump-catchup-'))
    state.configDir = path.join(state.dataDir, 'config')
    querySpy.mockReset()
    querySpy.mockImplementation(async (_site, params) => ({ rows: [row(params)] }))
    sitesSpy.mockReset()
    sitesSpy.mockResolvedValue([{ siteUrl: SITE, permissionLevel: 'siteOwner' }])
    // 02:00 UTC is 19:00 the day before in Los Angeles. Only Date is faked, so timers still run.
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-09-23T02:00:00Z'))
  })

  afterEach(async () => {
    vi.useRealTimers()
    vi.restoreAllMocks()
    await fs.rm(state.dataDir, { recursive: true, force: true })
  })

  it('ends a plain sync at the latest date Google finalized in PST, newest first', async () => {
    await sync('--site', SITE, ...QUIET, '--quiet')

    const dates = fetchedDates()
    // UTC says 2026-09-20 is 3 days old; in PST it is only 2 days old.
    expect(dates).not.toContain('2026-09-20')
    expect(dates[0]).toBe('2026-09-19')
    // A first sync covers 28 days.
    expect(dates).toHaveLength(28)
    expect(dates.at(-1)).toBe('2026-08-23')
  })

  it('fills every date since the oldest synced date after missed runs', async () => {
    await sync('--site', SITE, ...QUIET, '--start', '2026-06-01', '--end', '2026-06-03', '--quiet')
    querySpy.mockClear()

    await sync('--site', SITE, ...QUIET, '--quiet')

    const dates = fetchedDates()
    expect(dates).not.toContain('2026-06-02')
    expect(dates).toContain('2026-06-04')
    expect(new Set(dates).size).toBe(108)
  }, 60_000)

  it('keeps a day Google still updates pending, and fetches it again next time', async () => {
    const day = '2026-09-19'
    querySpy.mockImplementation(async (_site, params) => ({
      rows: (params.startRow ?? 0) > 0 ? [] : [{ keys: [`${day}T10:00:00-07:00`, 'https://example.com/a'], clicks: 1, impressions: 3, position: 1 }],
      metadata: { first_incomplete_hour: `${day}T18:00:00-07:00` },
    }))
    const flags = ['--site', SITE, '--tables', 'hourly_pages', '--types', 'web', '--no-sitemaps', '--no-inspections', '--no-rollups', '--start', day, '--end', day, '--quiet']

    await sync(...flags)
    expect((await states('hourly_pages')).map(s => s.state)).toEqual(['pending'])

    querySpy.mockClear()
    await sync(...flags)
    expect(querySpy).toHaveBeenCalled()
  })

  it('keeps a still-updating day pending for search appearance context tables', async () => {
    const day = '2026-09-19'
    querySpy.mockImplementation(async (_site, params) => ({
      rows: (params.startRow ?? 0) > 0
        ? []
        : params.dimensions.join(',') === 'searchAppearance'
          ? [{ keys: ['VIDEO'], clicks: 1, impressions: 3, position: 1 }]
          : [row(params)],
      metadata: { first_incomplete_hour: `${day}T18:00:00-07:00` },
    }))
    const flags = ['--site', SITE, '--tables', 'search_appearance_pages', '--types', 'web', '--no-sitemaps', '--no-inspections', '--no-rollups', '--start', day, '--end', day, '--quiet']

    await sync(...flags)
    expect((await states('search_appearance_pages')).map(s => s.state)).toEqual(['pending'])

    querySpy.mockClear()
    await sync(...flags)
    expect(querySpy).toHaveBeenCalled()
  })

  it('stops on a Google quota refusal, keeps the rest pending, and exits 0', async () => {
    querySpy.mockImplementation(async (_site, params) => {
      if (params.startDate === '2026-09-17')
        throw googleError(403, 'Search Analytics load quota exceeded.', 'quotaExceeded')
      return { rows: [row(params)] }
    })

    const run = await sync('--site', SITE, ...QUIET, '--days', '5', '--concurrency', '1', '--json')

    expect(run.exitCode).toBeUndefined()
    const report = run.json()
    expect(report.status).toBe('partial')
    expect(report.stopped).toMatchObject({ kind: 'quota', reason: '403 Search Analytics load quota exceeded.' })
    const byDate = Object.fromEntries((await states()).map(s => [s.date, s.state]))
    expect(byDate).toEqual({
      '2026-09-19': 'done',
      '2026-09-18': 'done',
      '2026-09-17': 'pending',
      '2026-09-16': 'pending',
      '2026-09-15': 'pending',
    })

    // The ledger remembers the refusal, so the next run does not call Google yet.
    querySpy.mockClear()
    const again = await sync('--site', SITE, ...QUIET, '--json')
    expect(querySpy).not.toHaveBeenCalled()
    expect(again.json().stopped.kind).toBe('quota')
  })

  it('records Google\'s reason for a real failure and exits 1', async () => {
    querySpy.mockRejectedValue(googleError(403, 'User does not have sufficient permission for site.', 'forbidden'))

    const run = await sync('--site', SITE, ...QUIET, '--days', '1', '--quiet')

    expect(run.exitCode).toBe(1)
    expect(await states()).toEqual([expect.objectContaining({ state: 'failed', error: '403 User does not have sufficient permission for site.' })])
  })

  it('spends at most --max-calls, then continues in the next run', async () => {
    const first = await sync('--site', SITE, ...QUIET, '--days', '5', '--max-calls', '2', '--concurrency', '1', '--json')

    expect(querySpy).toHaveBeenCalledTimes(2)
    expect(first.exitCode).toBeUndefined()
    expect(first.json().stopped).toEqual({ kind: 'budget', maxCalls: 2 })

    querySpy.mockClear()
    await sync('--site', SITE, ...QUIET, '--days', '5', '--quiet')
    expect(fetchedDates()).toEqual(['2026-09-17', '2026-09-16', '2026-09-15'])
  })

  it('plans at least one call per plain table day and three per dates day', async () => {
    const run = await sync('--site', SITE, '--tables', 'pages,dates', '--types', 'web', '--days', '2', '--dry-run', '--json')

    expect(run.json().minimumCalls).toBe(8)
    expect(querySpy).not.toHaveBeenCalled()
  })

  it('syncs every Site one after another with --all-sites', async () => {
    sitesSpy.mockResolvedValue([{ siteUrl: SITE, permissionLevel: 'siteOwner' }, { siteUrl: OTHER, permissionLevel: 'siteOwner' }])

    await sync('--all-sites', ...QUIET, '--days', '2', '--quiet')

    const order = querySpy.mock.calls.map(([site]) => site)
    expect(order).toEqual([SITE, SITE, OTHER, OTHER])
  })

  it('prints a resume hint and exits 130 on Ctrl+C', async () => {
    let release: () => void = () => {}
    const interrupted = new Promise<void>((resolve) => {
      querySpy.mockImplementation(async (_site, params) => {
        process.emit('SIGINT')
        resolve()
        await new Promise<void>((done) => {
          release = done
        })
        return { rows: [row(params)] }
      })
    })
    const warnings: string[] = []
    vi.spyOn(console, 'warn').mockImplementation(value => warnings.push(String(value)))
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      warnings.push(String(chunk))
      return true
    })

    const pending = sync('--site', SITE, ...QUIET, '--days', '1')
    await interrupted
    await vi.waitFor(() => expect(warnings.join('\n')).toContain('Sync interrupted. Run the same command to resume.'))
    await new Promise(resolve => setTimeout(resolve, 50))
    release()
    const run = await pending

    expect(run.exitCode).toBe(130)
  })
})

describe('sync --status', () => {
  beforeEach(async () => {
    state.dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gscdump-status-'))
    state.configDir = path.join(state.dataDir, 'config')
    querySpy.mockReset()
    querySpy.mockImplementation(async (_site, params) => ({ rows: [row(params)] }))
    sitesSpy.mockResolvedValue([{ siteUrl: SITE, permissionLevel: 'siteOwner' }])
  })

  afterEach(async () => {
    vi.restoreAllMocks()
    await fs.rm(state.dataDir, { recursive: true, force: true })
  })

  it('shows missing dates per table, not just the first and last date', async () => {
    const latest = new Date(Date.now() - 5 * 86_400_000).toISOString().slice(0, 10)
    const older = new Date(Date.now() - 12 * 86_400_000).toISOString().slice(0, 10)
    await sync('--site', SITE, ...QUIET, '--start', older, '--end', older, '--quiet')
    await sync('--site', SITE, ...QUIET, '--start', latest, '--end', latest, '--quiet')

    const run = await sync('--status', '--site', SITE, '--json')

    const gap = run.json().gaps.find((entry: { table: string }) => entry.table === 'pages')
    expect(gap.done).toBe(2)
    expect(gap.missing).toBeGreaterThan(0)
  })

  it('reports a sync whose process died as stale', async () => {
    await fs.mkdir(state.dataDir, { recursive: true })
    await fs.writeFile(path.join(state.dataDir, 'sync-run.json'), JSON.stringify({
      pid: 2 ** 22 + 12345,
      startedAt: Date.now() - 60_000,
      heartbeatAt: Date.now() - 1000,
      sites: [SITE],
      planned: 10,
      done: 3,
    }))

    const run = await sync('--status', '--site', SITE)

    expect(run.stdout.join('\n')).toContain('The last sync stopped without finishing')
  })

  it('refuses a --site that is in neither the Store nor the last sync run', async () => {
    await fs.mkdir(state.dataDir, { recursive: true })
    await fs.writeFile(path.join(state.dataDir, 'sync-run.json'), JSON.stringify({
      pid: 2 ** 22 + 12345,
      startedAt: Date.now() - 60_000,
      heartbeatAt: Date.now() - 1000,
      sites: [SITE],
      planned: 10,
      done: 3,
    }))

    const run = await sync('--status', '--site', 'other.com')

    expect(run.exitCode).toBe(1)
    expect(run.stdout).toEqual([])
  })
})

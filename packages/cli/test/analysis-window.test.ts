import type { TableName } from '../src/local-store'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { runCli } from '../src/cli'
import { createLocalStore } from '../src/local-store'

const SITE = 'sc-domain:example.com'

let directory: string
let stdout: string[]
let stderr: string[]

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'gscdump-window-'))
  await writeFile(join(directory, 'config.json'), JSON.stringify({ dataDir: join(directory, 'store') }))
  stdout = []
  stderr = []
  vi.spyOn(console, 'log').mockImplementation((...values) => stdout.push(values.join(' ')))
  for (const method of ['error', 'warn'] as const)
    vi.spyOn(console, method).mockImplementation((...values) => stderr.push(values.join(' ')))
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => {
    stderr.push(String(chunk))
    return true
  })
  vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    throw new Error(`exit ${code}`)
  }) as never)
})

afterEach(async () => {
  vi.restoreAllMocks()
  await rm(directory, { recursive: true, force: true })
})

/** Write rows for each date and mark the day synced, like `gscdump sync`. */
async function seed(table: TableName, dates: string[], rows: (date: string) => Record<string, unknown>[]) {
  const store = createLocalStore({ dataDir: join(directory, 'store') })
  const scope = { userId: store.userId, siteId: store.siteIdFor(SITE), table }
  for (const date of dates) {
    await store.engine.writeDay({ ...scope, date }, rows(date) as never)
    await store.engine.setSyncState({ ...scope, date }, 'done')
  }
}

function days(end: string, count: number): string[] {
  return Array.from({ length: count }, (_, i) => new Date(Date.parse(`${end}T00:00:00Z`) - i * 86_400_000).toISOString().slice(0, 10)).reverse()
}

/** Run one CLI invocation and return its exit code, as the command shell does. */
async function cli(...args: string[]): Promise<number> {
  return runCli({
    rawArgs: ['--config-dir', directory, ...args],
    // Local Store reads build auth but never contact Google.
    environment: { HOME: directory, GSC_ACCESS_TOKEN: 'unused-offline-token', NO_COLOR: '1' },
    loadEnv: false,
  })
}

describe('local windows anchor on the newest synced day', () => {
  it('ends a default query window on the newest synced day, not on today', async () => {
    const synced = days('2026-03-20', 28)
    await seed('pages', synced, date => [{ date, url: '/a', clicks: 1, impressions: 10, sum_position: 0 }])

    await cli('query', '--site', SITE, '-d', 'page', '-f', 'json', '--quiet')

    const payload = JSON.parse(stdout.join('\n'))
    expect(payload.dateRange).toEqual({ start: synced[0], end: '2026-03-20' })
    expect(payload.data).toEqual([{ page: '/a', clicks: 28, impressions: 280, ctr: 0.1, position: 1 }])
  })

  it('ends a default analyze window on the newest synced day of the table it reads', async () => {
    await seed('page_queries', days('2026-03-20', 28), date => [{ date, url: '/a', query: 'near miss', clicks: 1, impressions: 50, sum_position: 250 }])

    await cli('analyze', 'striking-distance', '--site', SITE)

    expect(stdout.join('\n')).toContain('2026-02-21 to 2026-03-20')
    expect(stdout.join('\n')).toContain('near miss')
  })
})

describe('local --page filters', () => {
  it('matches a full URL against stored paths and reads page_queries for -d query', async () => {
    const synced = days('2026-03-20', 28)
    await seed('page_queries', synced, date => [
      { date, url: '/a', query: 'alpha', clicks: 2, impressions: 20, sum_position: 0 },
      { date, url: '/b', query: 'beta', clicks: 1, impressions: 10, sum_position: 0 },
    ])

    await cli('query', '--site', SITE, '-d', 'query', '--page', 'https://example.com/a', '-f', 'json', '--quiet')

    const payload = JSON.parse(stdout.join('\n'))
    expect(payload.data).toEqual([{ query: 'alpha', clicks: 56, impressions: 560, ctr: 0.1, position: 1 }])
  })

  it('rejects a dimension and filter pair no Store table holds', async () => {
    await expect(cli('query', '--site', SITE, '-d', 'query', '--country', 'usa', '-f', 'json')).resolves.toBe(1)
    expect(stderr.join('')).toContain('No Store table holds query with country')
  })
})

describe('local sync coverage', () => {
  const queryRows = (date: string) => [{ date, url: '/a', query: 'alpha', clicks: 2, impressions: 50, sum_position: 0 }]
  const pageRows = (date: string) => [{ date, url: '/a', clicks: 2, impressions: 50, sum_position: 0 }]

  it('stops when the current window has a gap and names the sync command', async () => {
    const synced = days('2026-03-20', 28)
    const gap = ['2026-03-05', '2026-03-06', '2026-03-07']
    await seed('page_queries', synced.filter(date => !gap.includes(date)), queryRows)
    // A failed day counts as a gap, the same as a day never synced.
    const store = createLocalStore({ dataDir: join(directory, 'store') })
    await store.engine.setSyncState({ userId: store.userId, siteId: store.siteIdFor(SITE), table: 'page_queries', date: '2026-03-06' }, 'failed')

    await expect(cli('analyze', 'striking-distance', '--site', SITE)).resolves.toBe(1)

    const message = stderr.join('\n')
    expect(message).toContain('current window 2026-02-21 to 2026-03-20')
    expect(message).toContain('page_queries misses 3 of 28 days')
    expect(message).toContain(`gscdump sync --site example.com --start 2026-03-05 --end 2026-03-07 --tables page_queries`)
    expect(message).toContain('--live')
    expect(stdout.join('\n')).not.toContain('alpha')
  })

  it('stops when the comparison window is only partially synced', async () => {
    // 29 days ending 2026-03-20: the 28-day window is fully synced, but its
    // comparison window holds exactly one synced day (2026-02-20).
    await seed('page_queries', days('2026-03-20', 29), queryRows)

    await expect(cli('analyze', 'movers', '--site', SITE, '--json')).resolves.toBe(1)

    const message = stderr.join('\n')
    expect(message).toContain('comparison window 2026-01-24 to 2026-02-20')
    expect(message).toContain('page_queries misses 27 of 28 days')
    expect(message).toContain(`gscdump sync --site example.com --start 2026-01-24 --end 2026-02-19 --tables page_queries`)
    expect(message).not.toContain('current window')
    // --json prints the stop, never results.
    expect(JSON.parse(stdout.join('\n'))).toMatchObject({ error: { code: 'STORE_RANGE_NOT_COVERED' } })
  })

  it('stops report movers on a comparison gap and names only the tables it misses', async () => {
    // page_queries misses the comparison window; pages covers it fully.
    await seed('page_queries', days('2026-03-20', 28), queryRows)
    await seed('pages', days('2026-03-20', 56), pageRows)

    await expect(cli('report', 'movers', '--site', SITE, '--period', '28d', '--json')).resolves.toBe(1)

    const message = stderr.join('\n')
    expect(message).toContain('comparison window 2026-01-24 to 2026-02-20: page_queries misses 28 of 28 days')
    expect(message).toContain(`gscdump sync --site example.com --start 2026-01-24 --end 2026-02-20 --tables page_queries`)
    expect(message).not.toContain('pages misses')
    expect(JSON.parse(stdout.join('\n'))).toMatchObject({ error: { code: 'STORE_RANGE_NOT_COVERED' } })
  })

  it('runs an explicit range that the Store fully covers', async () => {
    // Synced 2026-02-01 to 2026-03-20; the run reads 2026-03-01 to 2026-03-14
    // and its comparison 2026-02-15 to 2026-02-28.
    await seed('page_queries', days('2026-03-20', 48), queryRows)

    await cli('analyze', 'movers', '--site', SITE, '--start', '2026-03-01', '--end', '2026-03-14', '--json')

    expect(JSON.parse(stdout.join('\n')).results).toBeInstanceOf(Array)
    expect(stderr.join('\n')).not.toContain('misses')
  })

  it('runs a default comparison window once both windows are synced', async () => {
    await seed('page_queries', days('2026-03-20', 56), queryRows)
    await seed('pages', days('2026-03-20', 56), pageRows)

    await cli('report', 'movers', '--site', SITE, '--json')

    expect(JSON.parse(stdout.join('\n')).window).toMatchObject({ start: '2026-03-14', end: '2026-03-20' })
    expect(stderr.join('\n')).not.toContain('misses')
  })
})

describe('report window flags', () => {
  it('treats --start/--end without --period as a custom window', async () => {
    await cli('report', 'opportunities', '--start', '2026-01-01', '--end', '2026-01-10', '--explain')

    expect(JSON.parse(stdout.join('\n')).window).toEqual({ start: '2026-01-01', end: '2026-01-10', days: 10 })
  })

  it('rejects --prev-start without --prev-end', async () => {
    await expect(cli('report', 'movers', '--prev-start', '2026-01-01', '--explain')).resolves.toBe(1)
    expect(stderr.join('\n')).toContain('Pass --prev-start and --prev-end together.')
  })
})

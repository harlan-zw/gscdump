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

async function cli(...args: string[]): Promise<void> {
  await runCli({
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
    await expect(cli('query', '--site', SITE, '-d', 'query', '--country', 'usa', '-f', 'json')).rejects.toThrow('exit 1')
    expect(stderr.join('')).toContain('No Store table holds query with country')
  })
})

describe('report window flags', () => {
  it('treats --start/--end without --period as a custom window', async () => {
    await cli('report', 'opportunities', '--start', '2026-01-01', '--end', '2026-01-10', '--explain')

    expect(JSON.parse(stdout.join('\n')).window).toEqual({ start: '2026-01-01', end: '2026-01-10', days: 10 })
  })

  it('rejects --prev-start without --prev-end', async () => {
    await expect(cli('report', 'movers', '--prev-start', '2026-01-01', '--explain')).rejects.toThrow()
    expect(stderr.join('\n')).toContain('Pass --prev-start and --prev-end together.')
  })
})

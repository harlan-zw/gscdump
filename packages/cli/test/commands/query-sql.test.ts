import type { LocalStore } from '../../src/local-store'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resetNodeDuckDB } from '@gscdump/engine/node'
import { runCommand } from 'citty'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { queryCommand } from '../../src/commands/query'
import { createLocalStore } from '../../src/local-store'
import { logger } from '../../src/utils'

const state = vi.hoisted(() => ({ store: undefined as LocalStore | undefined }))

vi.mock('../../src/config', () => ({
  loadConfig: vi.fn(async () => ({})),
}))

vi.mock('../../src/context', () => ({
  createCommandContext: vi.fn(async () => ({
    config: {},
    store: state.store,
    resolveSite: vi.fn(async (hint: string) => hint),
  })),
}))

vi.mock('../../src/utils', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/utils')>()
  return { ...actual, logger: { debug: vi.fn(), info: vi.fn(), success: vi.fn(), warn: vi.fn(), error: vi.fn() } }
})

const SITE_A = 'sc-domain:a.example'
const SITE_B = 'https://b.example/'

describe('query --sql views', () => {
  let dataDir: string
  let output: string[]
  const originalLog = console.log

  beforeEach(async () => {
    resetNodeDuckDB()
    vi.clearAllMocks()
    dataDir = await mkdtemp(join(tmpdir(), 'gscdump-sql-views-'))
    const store = createLocalStore({ dataDir })
    state.store = store
    const a = store.siteIdFor(SITE_A)
    const b = store.siteIdFor(SITE_B)
    const pages = (siteId: string, searchType: 'web' | 'image', url: string, clicks: number, impressions: number, sum_position: number) =>
      store.engine.writeDay({ userId: store.userId, siteId, table: 'pages', date: '2026-04-10', searchType }, [{ url, date: '2026-04-10', clicks, impressions, sum_position }])
    await pages(a, 'web', '/x', 3, 20, 40)
    await pages(a, 'image', '/x', 0, 2, 8)
    await pages(b, 'web', '/y', 1, 5, 5)
    await store.engine.writeDay({ userId: store.userId, siteId: a, table: 'page_queries', date: '2026-04-10' }, [
      { url: '/x', query: 'x one', date: '2026-04-10', clicks: 2, impressions: 12, sum_position: 12 },
      { url: '/x', query: 'x two', date: '2026-04-10', clicks: 1, impressions: 8, sum_position: 28 },
    ])
    output = []
    console.log = (...args: unknown[]) => {
      output.push(args.map(String).join(' '))
    }
  })

  afterEach(async () => {
    console.log = originalLog
    resetNodeDuckDB()
    await rm(dataDir, { recursive: true, force: true })
  })

  async function sql(query: string, ...flags: string[]) {
    await runCommand(queryCommand, { rawArgs: ['--quiet', '--sql', query, '--format', 'json', ...flags] })
    return JSON.parse(output.join('\n'))
  }

  it('splits totals by Site and search type', async () => {
    const result = await sql('SELECT site, search_type, SUM(impressions) AS impressions FROM pages GROUP BY ALL ORDER BY ALL')

    expect(result).toEqual({
      total: 3,
      data: [
        { site: SITE_B, search_type: 'web', impressions: 5 },
        { site: SITE_A, search_type: 'image', impressions: 2 },
        { site: SITE_A, search_type: 'web', impressions: 20 },
      ],
    })
  })

  it('joins two tables and weights position with gsc_position', async () => {
    const result = await sql(`
      SELECT p.page, SUM(q.impressions) AS query_impressions, gsc_position(q.sum_position, q.impressions) AS position
      FROM pages p JOIN page_queries q USING (site, search_type, url, date)
      WHERE p.search_type = 'web'
      GROUP BY p.page`)

    // (12 + 28) / (12 + 8) + 1
    expect(result.data).toEqual([{ page: '/x', query_impressions: 20, position: 3 }])
  })

  it('renders dates as ISO strings', async () => {
    const result = await sql('SELECT DISTINCT date FROM pages')

    expect(result.data).toEqual([{ date: '2026-04-10' }])
  })

  it('keeps integers past 2^53 exact as strings', async () => {
    const result = await sql('SELECT 9007199254740993::BIGINT AS exact, 45::HUGEINT AS small')

    expect(result.data).toEqual([{ exact: '9007199254740993', small: 45 }])
  })

  it('limits the views to one search type with --type', async () => {
    const result = await sql('SELECT search_type, SUM(impressions) AS impressions FROM pages GROUP BY ALL', '--type', 'image')

    expect(result.data).toEqual([{ search_type: 'image', impressions: 2 }])
  })

  it('warns when a query names a table with no synced data', async () => {
    const result = await sql('SELECT COUNT(*) AS n FROM countries')

    expect(result.data).toEqual([{ n: 0 }])
    expect(result.warnings).toEqual([expect.stringContaining('No synced data for table countries')])
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('countries'))
  })

  it('reads only web rows in a builder query without --type', async () => {
    const store = state.store!
    await store.engine.setSyncState({ userId: store.userId, siteId: store.siteIdFor(SITE_A), table: 'pages', date: '2026-04-10' }, 'done')

    await runCommand(queryCommand, { rawArgs: ['--quiet', '--site', SITE_A, '--dimensions', 'page', '--start', '2026-04-10', '--end', '2026-04-10', '--format', 'json'] })

    expect(JSON.parse(output.join('\n')).data).toEqual([expect.objectContaining({ page: '/x', impressions: 20 })])
  })

  it('lists every view with its columns and date range', async () => {
    await runCommand(queryCommand, { rawArgs: ['--quiet', '--schema', '--format', 'json'] })
    const views = JSON.parse(output.join('\n')).data

    const pages = views.find((view: { view: string }) => view.view === 'pages')
    expect(pages).toMatchObject({ search_types: 'web, image', rows: 3, start: '2026-04-10', end: '2026-04-10' })
    expect(pages.columns).toBe('site VARCHAR, search_type VARCHAR, url VARCHAR, page VARCHAR, date DATE, clicks INTEGER, impressions INTEGER, sum_position DOUBLE')
    expect(views.find((view: { view: string }) => view.view === 'countries')).toMatchObject({ rows: 0, start: null })
  })
})

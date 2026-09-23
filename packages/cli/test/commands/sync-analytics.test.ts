import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { createEmptyTypesStore } from '@gscdump/engine/entities'
import { createNodeHarness, resetNodeDuckDB } from '@gscdump/engine/node'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { dumpSites } from '../../src/commands/dump'
import { syncCommand } from '../../src/commands/sync'
import { createLocalStore } from '../../src/local-store'
import { listStoreSites } from '../../src/store-sites'
import { logger } from '../../src/utils'

const configState: { dataDir: string | null } = { dataDir: null }

const SITE = 'sc-domain:example.com'

const gscSites = [{ siteUrl: SITE, permissionLevel: 'siteOwner' }]

function buildRawResponse(params: { startDate: string, dimensions?: string[] }): {
  rows: Array<{ keys?: string[], clicks: number, impressions: number, ctr: number, position: number }>
} {
  const dims = params.dimensions ?? []
  const keys = dims.map((dim) => {
    if (dim === 'page')
      return 'https://example.com/guide'
    if (dim === 'query')
      return 'best practices'
    if (dim === 'country')
      return 'usa'
    if (dim === 'device')
      return 'desktop'
    if (dim === 'date')
      return params.startDate
    return ''
  })
  return {
    rows: [{
      keys,
      clicks: 5,
      impressions: 50,
      ctr: 0.1,
      position: 3.4,
    }],
  }
}

const rawQuerySpy = vi.fn()
const clientSitesSpy = vi.fn()
const sitemapsListSpy = vi.fn()
const inspectSpy = vi.fn()
const loadSitemapUrlsSpy = vi.fn()

vi.mock('../../src/sitemap', () => ({
  loadSitemapUrls: (...args: unknown[]) => loadSitemapUrlsSpy(...args),
}))

vi.mock('gscdump/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('gscdump/client')>()
  return {
    ...actual,
    googleSearchConsole: vi.fn(() => ({
      sites: clientSitesSpy,
      searchAnalytics: { query: rawQuerySpy },
      sitemaps: { list: sitemapsListSpy },
      inspect: inspectSpy,
    })),
  }
})

vi.mock('../../src/auth', () => ({
  getAuth: vi.fn(() => Promise.resolve({})),
  resolveAuth: vi.fn(() => Promise.resolve({})),
  resolveBYOK: vi.fn(() => null),
}))

vi.mock('../../src/utils', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/utils')>()
  return {
    ...actual,
    logger: {
      info: vi.fn(),
      success: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      start: vi.fn(),
    },
    progressBar: vi.fn(() => ''),
    clearLine: vi.fn(),
  }
})

vi.mock('../../src/config', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/config')>()
  const config = () => ({ dataDir: configState.dataDir ?? undefined })
  return {
    ...actual,
    loadConfig: vi.fn(() => Promise.resolve(config())),
    loadResolvedConfig: vi.fn(() => Promise.resolve({
      config: config(),
      dataDir: actual.resolveDataDir(config()),
    })),
  }
})

afterAll(() => {
  resetNodeDuckDB()
})

describe('sync command (local analytics)', () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gscdump-sync-'))
    configState.dataDir = tmpDir
    rawQuerySpy.mockReset()
    clientSitesSpy.mockReset()
    rawQuerySpy.mockImplementation((_siteUrl, params) => {
      if ((params.startRow ?? 0) > 0)
        return Promise.resolve({ rows: [] })
      return Promise.resolve(buildRawResponse(params))
    })
    clientSitesSpy.mockResolvedValue(gscSites)
    sitemapsListSpy.mockReset()
    sitemapsListSpy.mockResolvedValue([])
    inspectSpy.mockReset()
    inspectSpy.mockResolvedValue({ inspectionResult: { indexStatusResult: { verdict: 'PASS', coverageState: 'Submitted and indexed' } } })
    loadSitemapUrlsSpy.mockReset()
  })

  afterEach(async () => {
    vi.restoreAllMocks()
    await fs.rm(tmpDir, { recursive: true, force: true })
    configState.dataDir = null
  })

  it('writes a manifest entry per (table, date) and persists Parquet on disk', async () => {
    const start = '2026-04-01'
    const end = '2026-04-03'

    await syncCommand.run!({
      args: {
        site: SITE,
        start,
        end,
        tables: 'pages,queries',
        types: 'web',
        quiet: true,
      },
      rawArgs: [],
      cmd: syncCommand,
    })

    expect(rawQuerySpy).toHaveBeenCalled()
    // 3 days x 2 tables; a short page is the last page, so one call each
    expect(rawQuerySpy).toHaveBeenCalledTimes(6)

    const harness = createNodeHarness({ dataDir: configState.dataDir! })
    const siteId = harness.siteIdFor(SITE)

    const pages = await harness.engine.listLive({
      userId: harness.userId,
      siteId,
      table: 'pages',
    })
    expect(pages).toHaveLength(3)
    const pagePartitions = pages.map(e => e.partition).sort()
    expect(pagePartitions).toEqual([
      'daily/2026-04-01',
      'daily/2026-04-02',
      'daily/2026-04-03',
    ])
    expect(pages.every(e => e.rowCount === 1)).toBe(true)

    const keywords = await harness.engine.listLive({
      userId: harness.userId,
      siteId,
      table: 'queries',
    })
    expect(keywords).toHaveLength(3)

    for (const entry of pages) {
      const full = path.join(configState.dataDir!, entry.objectKey)
      const stat = await fs.stat(full)
      expect(stat.size).toBeGreaterThan(0)
    }
  })

  it('resolves a written Site and records its Site URL in the Store', async () => {
    await syncCommand.run!({
      args: { site: 'https://Example.com', start: '2026-04-01', end: '2026-04-01', tables: 'pages', quiet: true },
      rawArgs: [],
      cmd: syncCommand,
    })
    expect(rawQuerySpy.mock.calls.every(([siteUrl]) => siteUrl === SITE)).toBe(true)
    expect(await listStoreSites(configState.dataDir!)).toEqual([{ siteId: 'd_example.com', siteUrl: SITE }])
  })

  it('refuses a Site whose Store ID already holds another Site', async () => {
    clientSitesSpy.mockResolvedValue([
      { siteUrl: 'https://example.com/', permissionLevel: 'siteOwner' },
      { siteUrl: 'http://example.com/', permissionLevel: 'siteOwner' },
    ])
    const sync = (site: string) => syncCommand.run!({
      args: { site, start: '2026-04-01', end: '2026-04-01', tables: 'pages', quiet: true },
      rawArgs: [],
      cmd: syncCommand,
    })
    await sync('https://example.com/')
    rawQuerySpy.mockClear()
    vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`__exit_${code}__`)
    }) as never)
    await expect(sync('http://example.com/')).rejects.toThrow('__exit_1__')
    expect(vi.mocked(logger.error)).toHaveBeenCalledWith(expect.stringContaining('The Store keeps https://example.com/ under the same ID as http://example.com/'))
    expect(rawQuerySpy).not.toHaveBeenCalled()
  })

  it('replacing a day retires the prior version via writeDay atomicity', async () => {
    const day = '2026-04-05'
    // force=true so the second run re-syncs even though the first marked this date done.
    const args = { site: SITE, start: day, end: day, tables: 'pages', types: 'web', quiet: true, force: true }

    await syncCommand.run!({ args, rawArgs: [], cmd: syncCommand })
    await syncCommand.run!({ args, rawArgs: [], cmd: syncCommand })

    const harness = createNodeHarness({ dataDir: configState.dataDir! })
    const siteId = harness.siteIdFor(SITE)
    const live = await harness.engine.listLive({
      userId: harness.userId,
      siteId,
      table: 'pages',
    })
    expect(live).toHaveLength(1)

    const all = await harness.engine.listAll({
      userId: harness.userId,
      siteId,
      table: 'pages',
    })
    expect(all).toHaveLength(2)
    expect(all.filter(e => e.retiredAt !== undefined)).toHaveLength(1)
  })

  it('skips dates already marked done on a second run (idempotent resume)', async () => {
    const day = '2026-04-06'
    const args = { site: SITE, start: day, end: day, tables: 'pages', types: 'web', quiet: true }

    await syncCommand.run!({ args, rawArgs: [], cmd: syncCommand })
    expect(rawQuerySpy).toHaveBeenCalledTimes(1)

    rawQuerySpy.mockClear()
    await syncCommand.run!({ args, rawArgs: [], cmd: syncCommand })
    // Second run should see state=done and skip; no API calls.
    expect(rawQuerySpy).not.toHaveBeenCalled()

    const harness = createNodeHarness({ dataDir: configState.dataDir! })
    const states = await harness.engine.getSyncStates({
      userId: harness.userId,
      siteId: harness.siteIdFor(SITE),
      table: 'pages',
    })
    expect(states).toHaveLength(1)
    expect(states[0].state).toBe('done')
  })

  it('records failed state when the API throws, exits non-zero', async () => {
    const day = '2026-04-07'
    rawQuerySpy.mockRejectedValueOnce(new Error('quota exceeded'))

    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`process.exit(${code})`)
    }) as never)

    await expect(syncCommand.run!({
      args: { site: SITE, start: day, end: day, tables: 'pages', types: 'web', quiet: true },
      rawArgs: [],
      cmd: syncCommand,
    })).rejects.toThrow('process.exit(1)')

    const harness = createNodeHarness({ dataDir: configState.dataDir! })
    const states = await harness.engine.getSyncStates({
      userId: harness.userId,
      siteId: harness.siteIdFor(SITE),
      table: 'pages',
    })
    expect(states).toHaveLength(1)
    expect(states[0].state).toBe('failed')
    expect(states[0].error).toContain('quota exceeded')

    exitSpy.mockRestore()
  })

  it('keeps populated search types enabled after a repeat and syncs new dates', async () => {
    const args = {
      site: SITE,
      start: '2026-04-01',
      end: '2026-04-07',
      tables: 'pages',
      types: 'image',
      quiet: true,
      rollups: false,
    }
    await syncCommand.run!({ args, rawArgs: [], cmd: syncCommand })
    rawQuerySpy.mockClear()
    await syncCommand.run!({ args, rawArgs: [], cmd: syncCommand })
    expect(rawQuerySpy).not.toHaveBeenCalled()

    await syncCommand.run!({ args: { ...args, end: '2026-04-08' }, rawArgs: [], cmd: syncCommand })
    const harness = createNodeHarness({ dataDir: tmpDir })
    const result = await harness.runRawSql({
      siteUrl: SITE,
      table: 'pages',
      searchType: 'image',
      sql: 'SELECT COUNT(*)::DOUBLE AS count, SUM(clicks)::DOUBLE AS clicks FROM read_parquet({{FILES}})',
    })
    expect(result.rows).toEqual([{ count: 8, clicks: 40 }])
  })

  it('repairs existing empty markers when the Store has rows for that search type', async () => {
    const args = {
      site: SITE,
      start: '2026-04-01',
      end: '2026-04-01',
      tables: 'pages',
      types: 'image',
      quiet: true,
      rollups: false,
    }
    await syncCommand.run!({ args, rawArgs: [], cmd: syncCommand })
    const harness = createNodeHarness({ dataDir: tmpDir })
    const scope = { userId: harness.userId, siteId: harness.siteIdFor(SITE) }
    const emptyTypes = createEmptyTypesStore({ dataSource: harness.dataSource })
    await emptyTypes.mark(scope, ['image'])

    await syncCommand.run!({ args: { ...args, end: '2026-04-02' }, rawArgs: [], cmd: syncCommand })
    expect((await emptyTypes.load(scope)).emptyTypes).toEqual([])
    const result = await harness.runRawSql({
      siteUrl: SITE,
      table: 'pages',
      searchType: 'image',
      sql: 'SELECT COUNT(*)::DOUBLE AS count, SUM(clicks)::DOUBLE AS clicks FROM read_parquet({{FILES}})',
    })
    expect(result.rows).toEqual([{ count: 2, clicks: 10 }])
  })

  it('does not infer an empty search type from skipped dates and one fresh empty day', async () => {
    rawQuerySpy.mockResolvedValue({ rows: [] })
    const args = {
      site: SITE,
      start: '2026-04-01',
      end: '2026-04-06',
      tables: 'pages',
      types: 'image',
      quiet: true,
      rollups: false,
    }
    await syncCommand.run!({ args, rawArgs: [], cmd: syncCommand })
    await syncCommand.run!({ args: { ...args, end: '2026-04-07' }, rawArgs: [], cmd: syncCommand })

    const harness = createNodeHarness({ dataDir: tmpDir })
    const doc = await createEmptyTypesStore({ dataSource: harness.dataSource }).load({
      userId: harness.userId,
      siteId: harness.siteIdFor(SITE),
    })
    expect(doc.emptyTypes).toEqual([])
  })

  it('re-probes the whole window of a marked-empty type with --force-types', async () => {
    rawQuerySpy.mockResolvedValue({ rows: [] })
    const args = {
      site: SITE,
      start: '2026-04-01',
      end: '2026-04-07',
      tables: 'pages',
      types: 'image',
      quiet: true,
      rollups: false,
    }
    await syncCommand.run!({ args, rawArgs: [], cmd: syncCommand })
    rawQuerySpy.mockClear()
    await syncCommand.run!({ args: { ...args, end: '2026-04-08' }, rawArgs: [], cmd: syncCommand })
    expect(rawQuerySpy).not.toHaveBeenCalled()

    // Data shows up. The re-probe refetches the type's done days too: their
    // 0-row fetches are the evidence the marker claims, so they must be
    // re-checked. Other, unmarked types still resume.
    rawQuerySpy.mockImplementation((_siteUrl, params) => {
      if ((params.startRow ?? 0) > 0)
        return Promise.resolve({ rows: [] })
      if (params.startDate === '2026-04-08')
        return Promise.resolve(buildRawResponse(params))
      return Promise.resolve({ rows: [] })
    })
    await syncCommand.run!({ args: { ...args, 'end': '2026-04-08', 'force-types': true }, rawArgs: [], cmd: syncCommand })
    const probed = rawQuerySpy.mock.calls
      .filter(([, params]) => (params.startRow ?? 0) === 0)
      .map(([, params]) => params.startDate as string)
      .sort()
    expect(probed).toEqual([
      '2026-04-01',
      '2026-04-02',
      '2026-04-03',
      '2026-04-04',
      '2026-04-05',
      '2026-04-06',
      '2026-04-07',
      '2026-04-08',
    ])
    const harness = createNodeHarness({ dataDir: tmpDir })
    const doc = await createEmptyTypesStore({ dataSource: harness.dataSource }).load({
      userId: harness.userId,
      siteId: harness.siteIdFor(SITE),
    })
    expect(doc.emptyTypes).toEqual([])
    const result = await harness.runRawSql({
      siteUrl: SITE,
      table: 'pages',
      searchType: 'image',
      sql: 'SELECT SUM(clicks)::DOUBLE AS clicks FROM read_parquet({{FILES}})',
    })
    expect(result.rows).toEqual([{ clicks: 5 }])
  })

  it('re-probes a marked-empty type when every date in its window is done', async () => {
    rawQuerySpy.mockResolvedValue({ rows: [] })
    const args = {
      site: SITE,
      start: '2026-04-01',
      end: '2026-04-07',
      tables: 'pages',
      types: 'image',
      quiet: true,
      rollups: false,
    }
    await syncCommand.run!({ args, rawArgs: [], cmd: syncCommand })
    const harness = createNodeHarness({ dataDir: tmpDir })
    const scope = { userId: harness.userId, siteId: harness.siteIdFor(SITE) }
    expect((await createEmptyTypesStore({ dataSource: harness.dataSource }).load(scope)).emptyTypes).toEqual(['image'])

    // Data arrives, but no new date extends the window. The re-probe must
    // still fetch the type's done days: resume alone would skip them all and
    // the marker could never heal.
    rawQuerySpy.mockImplementation((_siteUrl, params) => {
      if ((params.startRow ?? 0) > 0)
        return Promise.resolve({ rows: [] })
      return Promise.resolve(buildRawResponse(params))
    })
    rawQuerySpy.mockClear()
    await syncCommand.run!({ args: { ...args, 'force-types': true }, rawArgs: [], cmd: syncCommand })

    const probed = rawQuerySpy.mock.calls
      .filter(([, params]) => (params.startRow ?? 0) === 0)
      .map(([, params]) => params.startDate as string)
    expect(probed).toHaveLength(7)
    expect((await createEmptyTypesStore({ dataSource: harness.dataSource }).load(scope)).emptyTypes).toEqual([])
  })

  it('re-probes an empty-marked type with --force-types while done dates stay skipped', async () => {
    const day = '2026-04-09'
    const args = { site: SITE, start: day, end: day, tables: 'pages', types: 'web', quiet: true, rollups: false }
    await syncCommand.run!({ args, rawArgs: [], cmd: syncCommand })
    // A stale marker claims image has no data; the store has done web dates.
    const harness = createNodeHarness({ dataDir: configState.dataDir! })
    const scope = { userId: harness.userId, siteId: harness.siteIdFor(SITE) }
    await createEmptyTypesStore({ dataSource: harness.dataSource }).mark(scope, ['image'])

    rawQuerySpy.mockClear()
    await syncCommand.run!({ args: { ...args, 'types': 'web,image', 'force-types': true }, rawArgs: [], cmd: syncCommand })

    const firstPages = rawQuerySpy.mock.calls.filter(([, params]) => (params.startRow ?? 0) === 0)
    const queriedDates = (type: string): string[] => firstPages
      .filter(([, params]) => params.searchType === type)
      .map(([, params]) => params.startDate as string)
    // --force-types is not --force: done dates stay skipped.
    expect(queriedDates('web')).toEqual([])
    // The wrongly marked-empty type is still re-probed.
    expect(queriedDates('image')).toEqual([day])
  })

  it('stores true daily totals, device metrics, and anonymized impressions with the default tables', async () => {
    const day = '2026-04-10'
    rawQuerySpy.mockImplementation((_siteUrl, params) => {
      if ((params.startRow ?? 0) > 0)
        return Promise.resolve({ rows: [] })
      if (params.dimensions.join(',') === 'date') {
        return Promise.resolve({ rows: [{ keys: [day], clicks: 20, impressions: 200, position: 4 }] })
      }
      if (params.dimensions.join(',') === 'date,device') {
        return Promise.resolve({ rows: [
          { keys: [day, 'DESKTOP'], clicks: 12, impressions: 120, position: 3 },
          { keys: [day, 'MOBILE'], clicks: 6, impressions: 60, position: 5 },
          { keys: [day, 'TABLET'], clicks: 2, impressions: 20, position: 7 },
        ] })
      }
      return Promise.resolve(buildRawResponse(params))
    })
    vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`process.exit(${code})`)
    }) as never)

    await syncCommand.run!({
      args: { site: SITE, start: day, end: day, types: 'web', quiet: true, rollups: false },
      rawArgs: [],
      cmd: syncCommand,
    })
    const harness = createNodeHarness({ dataDir: tmpDir })
    const result = await harness.runRawSql({
      siteUrl: SITE,
      table: 'dates',
      sql: 'SELECT * REPLACE (date::VARCHAR AS date) FROM read_parquet({{FILES}})',
    })
    expect(result.rows).toEqual([{
      date: day,
      clicks: 20,
      impressions: 200,
      sum_position: 600,
      anonymized_impressions_pct: 0.75,
      clicks_desktop: 12,
      clicks_mobile: 6,
      clicks_tablet: 2,
      impressions_desktop: 120,
      impressions_mobile: 60,
      impressions_tablet: 20,
      sum_position_desktop: 240,
      sum_position_mobile: 240,
      sum_position_tablet: 120,
    }])
  })

  it('preserves URL variant metrics across a forced repeat sync', async () => {
    const day = '2026-09-01'
    const first = { keys: ['https://example.com/guide#first', day], clicks: 2, impressions: 10, position: 2 }
    const second = { keys: ['https://docs.example.com/guide#second', day], clicks: 3, impressions: 20, position: 4 }
    rawQuerySpy.mockImplementation((_siteUrl, params) => Promise.resolve({
      rows: params.startRow === 0 ? [first, second, first] : [],
    }))
    const args = { site: SITE, start: day, end: day, tables: 'pages', types: 'web', quiet: true, rollups: false, force: true }
    for (let sync = 0; sync < 2; sync++)
      await syncCommand.run!({ args, rawArgs: [], cmd: syncCommand })

    const harness = createNodeHarness({ dataDir: tmpDir })
    const result = await harness.runRawSql({
      siteUrl: SITE,
      table: 'pages',
      sql: 'SELECT url, clicks, impressions, sum_position FROM read_parquet({{FILES}})',
    })
    expect(result.rows).toEqual([{ url: '/guide', clicks: 5, impressions: 30, sum_position: 70 }])
  })

  it('leaves daily totals empty when Google returns no totals', async () => {
    rawQuerySpy.mockResolvedValue({ rows: [] })
    const day = '2026-04-10'
    await syncCommand.run!({
      args: { site: SITE, start: day, end: day, tables: 'dates', types: 'web', quiet: true, rollups: false },
      rawArgs: [],
      cmd: syncCommand,
    })
    const harness = createNodeHarness({ dataDir: tmpDir })
    const result = await harness.runRawSql({
      siteUrl: SITE,
      table: 'dates',
      sql: 'SELECT * FROM read_parquet({{FILES}})',
    })
    expect(result.rows).toEqual([])
    expect(rawQuerySpy).toHaveBeenCalledTimes(1)
  })

  it('keeps existing daily totals if a device fetch fails during a forced sync', async () => {
    const day = '2026-04-10'
    const args = { site: SITE, start: day, end: day, tables: 'dates', types: 'web', quiet: true, rollups: false }
    await syncCommand.run!({ args, rawArgs: [], cmd: syncCommand })
    rawQuerySpy.mockImplementation((_siteUrl, params) => {
      if (params.dimensions.includes('device'))
        return Promise.reject(new Error('device quota exceeded'))
      if ((params.startRow ?? 0) > 0)
        return Promise.resolve({ rows: [] })
      return Promise.resolve({ rows: [{ keys: [day], clicks: 99, impressions: 999, position: 5 }] })
    })
    vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`process.exit(${code})`)
    }) as never)
    await expect(syncCommand.run!({
      args: { ...args, force: true },
      rawArgs: [],
      cmd: syncCommand,
    })).rejects.toThrow('process.exit(1)')

    const harness = createNodeHarness({ dataDir: tmpDir })
    const result = await harness.runRawSql({
      siteUrl: SITE,
      table: 'dates',
      sql: 'SELECT clicks, impressions FROM read_parquet({{FILES}})',
    })
    expect(result.rows).toEqual([{ clicks: 5, impressions: 50 }])
    const states = await harness.engine.getSyncStates({
      userId: harness.userId,
      siteId: harness.siteIdFor(SITE),
      table: 'dates',
    })
    expect(states).toEqual([expect.objectContaining({ date: day, state: 'failed', error: 'device quota exceeded' })])
  })
  async function runSyncJson(args: Record<string, unknown>): Promise<Record<string, any>> {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    await syncCommand.run!({ args: { site: SITE, start: '2026-04-01', end: '2026-04-01', tables: 'pages', types: 'web', json: true, rollups: false, ...args }, rawArgs: [], cmd: syncCommand })
    const output = log.mock.calls.map(call => String(call[0])).find(line => line.trimStart().startsWith('{'))
    log.mockRestore()
    return JSON.parse(output!)
  }

  it('saves sitemaps and URL Inspection results that dump can export', async () => {
    sitemapsListSpy.mockResolvedValue([{
      path: 'https://example.com/sitemap.xml',
      type: 'sitemap',
      isPending: false,
      lastSubmitted: '2026-03-01T00:00:00.000Z',
      warnings: '0',
      errors: '2',
      contents: [{ type: 'web', submitted: '3' }],
    }])
    loadSitemapUrlsSpy.mockResolvedValue({
      _tag: 'ok',
      value: {
        urls: [],
        entries: [{ loc: 'https://example.com/guide' }, { loc: 'https://example.com/a', lastmod: '2026-03-02' }, { loc: 'https://other.com/x' }],
        complete: true,
        documentsRead: 1,
      },
    })

    const result = await runSyncJson({ 'inspect-limit': '2' })

    expect(result.status).toBe('completed')
    expect(result.sitemaps).toMatchObject({ _tag: 'saved', sitemaps: 1, urls: 3, generation: 'published' })
    // The traffic page comes first; the off-property sitemap URL is never inspected.
    expect(result.inspections).toMatchObject({ _tag: 'inspected', inspected: 2, failed: 0, deferred: 0 })
    expect(inspectSpy.mock.calls.map(call => call[1])).toEqual(['https://example.com/guide', 'https://example.com/a'])

    const store = createLocalStore({ dataDir: tmpDir })
    const { sites: [summary] } = await dumpSites({
      store,
      targets: [{ site: SITE, siteId: store.siteIdFor(SITE) }],
      outDir: path.join(tmpDir, 'out'),
      format: 'json',
      tables: new Set(['inspections', 'sitemaps', 'sitemap_urls']),
    })
    expect(Object.fromEntries(summary!.datasets.map(dataset => [dataset.dataset, dataset.rows]))).toEqual({ inspections: 2, sitemaps: 1, sitemap_urls: 3 })

    // A second run finds nothing due: both URLs were just inspected.
    inspectSpy.mockClear()
    const again = await runSyncJson({ 'inspect-limit': '2' })
    expect(again.inspections).toMatchObject({ _tag: 'nothing_due' })
    expect(inspectSpy).not.toHaveBeenCalled()
  })

  it('reports a sitemap list failure without failing the analytics sync', async () => {
    sitemapsListSpy.mockRejectedValue(new Error('403 Forbidden'))
    inspectSpy.mockRejectedValue(new Error('quota exceeded'))

    const result = await runSyncJson({})

    expect(result.status).toBe('completed')
    expect(result.totals.pages.rows).toBe(1)
    expect(result.sitemaps).toEqual({ _tag: 'failed', reason: 'Search Console sitemap list failed: 403 Forbidden' })
    expect(result.inspections).toMatchObject({ _tag: 'inspected', inspected: 0, failed: 1 })
    expect(result.inspections.failures[0].error).toBe('quota exceeded')
  })

  it('skips both steps with --no-sitemaps and --no-inspections', async () => {
    const result = await runSyncJson({ sitemaps: false, inspections: false })

    expect(result.sitemaps).toEqual({ _tag: 'disabled' })
    expect(result.inspections).toEqual({ _tag: 'disabled' })
    expect(sitemapsListSpy).not.toHaveBeenCalled()
    expect(inspectSpy).not.toHaveBeenCalled()
  })

  it('syncs every table and search type Google can answer, with search appearance filters and hourly data', async () => {
    const day = new Date(Date.now() - 4 * 86_400_000).toISOString().slice(0, 10)
    rawQuerySpy.mockImplementation((_siteUrl, params) => {
      if ((params.startRow ?? 0) > 0)
        return Promise.resolve({ rows: [] })
      const dims = params.dimensions.join(',')
      if (dims === 'searchAppearance')
        return Promise.resolve({ rows: [{ keys: ['VIDEO'], clicks: 4, impressions: 40, position: 2 }] })
      if (dims === 'hour,page')
        return Promise.resolve({ rows: [{ keys: [`${day}T15:00:00-07:00`, 'https://example.com/guide'], clicks: 1, impressions: 9, position: 2 }] })
      return Promise.resolve(buildRawResponse(params))
    })

    await syncCommand.run!({
      args: { 'site': SITE, 'start': day, 'end': day, 'quiet': true, 'rollups': false, 'sitemaps': false, 'inspections': false, 'requests-per-minute': '1000000' },
      rawArgs: [],
      cmd: syncCommand,
    })

    const calls = rawQuerySpy.mock.calls.map(([, params]) => params).filter(params => (params.startRow ?? 0) === 0)
    const typeOf = (params: any): string => params.type ?? params.searchType
    // Discover and Google News have no query or country breakdown.
    for (const type of ['discover', 'googleNews'])
      expect(new Set(calls.filter(params => typeOf(params) === type).map(params => params.dimensions.join(',')))).toEqual(new Set(['page,date', 'hour,page']))
    // Search appearance groups alone, then filters each appearance for its context.
    const webCalls = calls.filter(params => typeOf(params) === 'web')
    expect(webCalls.some(params => params.dimensions.join(',') === 'searchAppearance,date')).toBe(false)
    const filtered = webCalls.filter(params => params.dimensionFilterGroups?.[0]?.filters?.[0]?.dimension === 'searchAppearance')
    expect(filtered.map(params => params.dimensions.join(',')).sort()).toEqual(['page,date', 'page,query,date', 'query,date'])
    expect(filtered.every(params => params.dimensionFilterGroups[0].filters[0].expression === 'VIDEO')).toBe(true)
    expect(webCalls.find(params => params.dimensions.join(',') === 'hour,page')?.dataState).toBe('hourly_all')

    const harness = createNodeHarness({ dataDir: tmpDir })
    const appearance = await harness.runRawSql({
      siteUrl: SITE,
      table: 'search_appearance_pages',
      searchType: 'web',
      sql: 'SELECT searchAppearance, url FROM read_parquet({{FILES}})',
    })
    expect(appearance.rows).toEqual([{ searchAppearance: 'VIDEO', url: '/guide' }])
    const hourly = await harness.runRawSql({
      siteUrl: SITE,
      table: 'hourly_pages',
      searchType: 'web',
      sql: 'SELECT hour, url, impressions FROM read_parquet({{FILES}})',
    })
    expect(hourly.rows).toEqual([{ hour: 15, url: '/guide', impressions: 9 }])
  })

  it('leaves hourly dates outside Google\'s hourly window out of the plan', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    await syncCommand.run!({
      args: { 'site': SITE, 'start': '2026-01-01', 'end': '2026-01-02', 'tables': 'pages,hourly_pages', 'types': 'web', 'dry-run': true, 'json': true },
      rawArgs: [],
      cmd: syncCommand,
    })
    const plan = JSON.parse(String(log.mock.calls[0]![0]))
    log.mockRestore()
    expect(plan.plan.map((item: { table: string }) => item.table)).toEqual(['pages', 'pages'])
  })

  it('counts a date that failed on Google quota as failed in the dump manifest', async () => {
    rawQuerySpy.mockImplementation((_siteUrl, params) => {
      if (params.startDate === '2026-04-02')
        return Promise.reject(new Error('[POST] 403 Search Analytics load quota exceeded'))
      if ((params.startRow ?? 0) > 0)
        return Promise.resolve({ rows: [] })
      return Promise.resolve(buildRawResponse(params))
    })
    vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`process.exit(${code})`)
    }) as never)

    await expect(syncCommand.run!({
      args: { site: SITE, start: '2026-04-01', end: '2026-04-03', tables: 'pages', types: 'web', quiet: true, rollups: false, sitemaps: false, inspections: false },
      rawArgs: [],
      cmd: syncCommand,
    })).rejects.toThrow('process.exit(1)')

    const store = createLocalStore({ dataDir: tmpDir })
    const outDir = path.join(tmpDir, 'out')
    await dumpSites({ store, targets: [{ site: SITE, siteId: store.siteIdFor(SITE) }], outDir, format: 'parquet', tables: new Set(['pages']) })
    const manifest = JSON.parse(await fs.readFile(path.join(outDir, 'manifest.json'), 'utf8'))
    const pages = manifest.sites[0].coverage.analytics.find((entry: { table: string }) => entry.table === 'pages')
    expect(pages).toMatchObject({ from: '2026-04-01', coverage: { kind: 'partial', done: 2, failed: 1 } })
  })

  it('keeps Search Analytics requests from all tables under one in-flight cap', async () => {
    let active = 0
    let peak = 0
    rawQuerySpy.mockImplementation(async (_siteUrl, params) => {
      active++
      peak = Math.max(peak, active)
      await new Promise(resolve => setTimeout(resolve, 2))
      active--
      if ((params.startRow ?? 0) > 0)
        return { rows: [] }
      return buildRawResponse(params)
    })

    await syncCommand.run!({
      args: { 'site': SITE, 'start': '2026-04-01', 'end': '2026-04-10', 'tables': 'pages,queries,countries,page_queries', 'types': 'web', 'quiet': true, 'rollups': false, 'sitemaps': false, 'inspections': false, 'requests-per-minute': '1000000' },
      rawArgs: [],
      cmd: syncCommand,
    })

    expect(peak).toBeLessThanOrEqual(8)
  })

  it('retries earlier failed dates on a plain re-run', async () => {
    const store = createLocalStore({ dataDir: tmpDir })
    const old = new Date(Date.now() - 100 * 86_400_000).toISOString().slice(0, 10)
    const scope = { userId: store.userId, siteId: store.siteIdFor(SITE), table: 'pages' as const, date: old }
    await store.engine.setSyncState(scope, 'failed', { error: 'Lock file is already being held' })

    await syncCommand.run!({
      args: { site: SITE, tables: 'pages', types: 'web', quiet: true, rollups: false, sitemaps: false, inspections: false },
      rawArgs: [],
      cmd: syncCommand,
    })

    expect(rawQuerySpy.mock.calls.some(([, params]) => params.startDate === old)).toBe(true)
    const [state] = await store.engine.getSyncStates({ ...scope, state: undefined })
      .then(states => states.filter(s => s.date === old))
    expect(state?.state).toBe('done')
  })
})

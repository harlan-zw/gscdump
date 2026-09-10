import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createEmptyTypesStore } from '@gscdump/engine/entities'
import { createNodeHarness, resetNodeDuckDB } from '@gscdump/engine/node'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { syncCommand } from '../../src/commands/sync'

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

vi.mock('gscdump/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('gscdump/client')>()
  return {
    ...actual,
    googleSearchConsole: vi.fn(() => ({
      sites: clientSitesSpy,
      searchAnalytics: { query: rawQuerySpy },
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
        quiet: true,
      },
      rawArgs: [],
      cmd: syncCommand,
    })

    expect(rawQuerySpy).toHaveBeenCalled()
    // 3 days x 2 tables x (data page + empty terminal page) = 12 calls
    expect(rawQuerySpy).toHaveBeenCalledTimes(12)

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

  it('replacing a day retires the prior version via writeDay atomicity', async () => {
    const day = '2026-04-05'
    // force=true so the second run re-syncs even though the first marked this date done.
    const args = { site: SITE, start: day, end: day, tables: 'pages', quiet: true, force: true }

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
    const args = { site: SITE, start: day, end: day, tables: 'pages', quiet: true }

    await syncCommand.run!({ args, rawArgs: [], cmd: syncCommand })
    expect(rawQuerySpy).toHaveBeenCalledTimes(2)

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
      args: { site: SITE, start: day, end: day, tables: 'pages', quiet: true },
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
      'site': SITE,
      'start': '2026-04-01',
      'end': '2026-04-07',
      'tables': 'pages',
      'types': 'image',
      'quiet': true,
      'no-rollups': true,
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
      'site': SITE,
      'start': '2026-04-01',
      'end': '2026-04-01',
      'tables': 'pages',
      'types': 'image',
      'quiet': true,
      'no-rollups': true,
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
      'site': SITE,
      'start': '2026-04-01',
      'end': '2026-04-06',
      'tables': 'pages',
      'types': 'image',
      'quiet': true,
      'no-rollups': true,
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

  it('skips freshly probed empty types and re-probes their dates with force-types', async () => {
    rawQuerySpy.mockResolvedValue({ rows: [] })
    const args = {
      'site': SITE,
      'start': '2026-04-01',
      'end': '2026-04-07',
      'tables': 'pages',
      'types': 'image',
      'quiet': true,
      'no-rollups': true,
    }
    await syncCommand.run!({ args, rawArgs: [], cmd: syncCommand })
    rawQuerySpy.mockClear()
    await syncCommand.run!({ args: { ...args, end: '2026-04-08' }, rawArgs: [], cmd: syncCommand })
    expect(rawQuerySpy).not.toHaveBeenCalled()

    rawQuerySpy.mockImplementation((_siteUrl, params) => {
      if ((params.startRow ?? 0) > 0)
        return Promise.resolve({ rows: [] })
      return Promise.resolve(buildRawResponse(params))
    })
    await syncCommand.run!({ args: { ...args, 'force-types': true }, rawArgs: [], cmd: syncCommand })
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
    expect(result.rows).toEqual([{ clicks: 35 }])
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
      args: { 'site': SITE, 'start': day, 'end': day, 'quiet': true, 'no-rollups': true },
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

  it('leaves daily totals empty when Google returns no totals', async () => {
    rawQuerySpy.mockResolvedValue({ rows: [] })
    const day = '2026-04-10'
    await syncCommand.run!({
      args: { 'site': SITE, 'start': day, 'end': day, 'tables': 'dates', 'quiet': true, 'no-rollups': true },
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
    const args = { 'site': SITE, 'start': day, 'end': day, 'tables': 'dates', 'quiet': true, 'no-rollups': true }
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
})

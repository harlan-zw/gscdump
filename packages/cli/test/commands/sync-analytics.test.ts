import type { DriverQueryParams, DriverQueryResult, DriverSite } from 'gscdump/driver'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { resetNodeDuckDB } from '../../../gscdump/src/analytics/adapters/duckdb-node'
import { createAnalyticsHarness } from '../../src/analytics'
import { syncCommand } from '../../src/commands/sync'

const configState: { dataDir: string | null } = { dataDir: null }

const SITE = 'sc-domain:example.com'

const siteList: DriverSite[] = [{ siteUrl: SITE, permissionLevel: 'siteOwner' }]

function buildQueryResult(_siteUrl: string, params: DriverQueryParams): DriverQueryResult {
  const dims = params.dimensions ?? []
  const row: Record<string, unknown> = {
    date: params.startDate,
    clicks: 5,
    impressions: 50,
    position: 3.4,
    ctr: 0.1,
  }
  if (dims.includes('page'))
    row.page = 'https://example.com/guide'
  if (dims.includes('query'))
    row.query = 'best practices'
  if (dims.includes('country'))
    row.country = 'usa'
  if (dims.includes('device'))
    row.device = 'desktop'
  return {
    rows: [row],
    meta: {
      siteUrl: SITE,
      dimensions: dims,
      dateRange: { startDate: params.startDate, endDate: params.endDate },
      rowCount: 1,
      hasMore: false,
    },
  }
}

const querySpy = vi.fn<(siteUrl: string, params: DriverQueryParams) => Promise<DriverQueryResult>>()
const sitesSpy = vi.fn<() => Promise<DriverSite[]>>()

const mockDriver = {
  mode: 'local' as const,
  sites: sitesSpy,
  query: querySpy,
}

vi.mock('../../src/driver', () => ({
  getDriver: vi.fn(() => Promise.resolve(mockDriver)),
}))

vi.mock('../../src/auth', () => ({
  getAuth: vi.fn(() => Promise.resolve({})),
}))

vi.mock('gscdump/driver', async (importOriginal) => {
  const actual = await importOriginal<typeof import('gscdump/driver')>()
  return {
    ...actual,
    isCloudDriver: vi.fn(() => false),
  }
})

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
  return {
    ...actual,
    loadConfig: vi.fn(() => Promise.resolve({ mode: 'local', dataDir: configState.dataDir ?? undefined })),
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
    querySpy.mockReset()
    sitesSpy.mockReset()
    querySpy.mockImplementation((siteUrl, params) => Promise.resolve(buildQueryResult(siteUrl, params)))
    sitesSpy.mockResolvedValue(siteList)
  })

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true }).catch(() => {})
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
        tables: 'pages,keywords',
        quiet: true,
      },
      rawArgs: [],
      cmd: syncCommand,
    })

    expect(querySpy).toHaveBeenCalled()
    // 3 days x 2 tables = 6 calls
    expect(querySpy).toHaveBeenCalledTimes(6)

    const harness = createAnalyticsHarness({ mode: 'local', dataDir: configState.dataDir! })
    const siteId = harness.siteIdFor(SITE)

    const pages = await harness.manifestStore.listLive({
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

    const keywords = await harness.manifestStore.listLive({
      userId: harness.userId,
      siteId,
      table: 'keywords',
    })
    expect(keywords).toHaveLength(3)

    // files exist on disk under the tenant prefix
    for (const entry of pages) {
      const full = path.join(configState.dataDir!, entry.objectKey)
      const stat = await fs.stat(full)
      expect(stat.size).toBeGreaterThan(0)
    }
  })

  it('replacing a day retires the prior version via writeDay atomicity', async () => {
    const day = '2026-04-05'
    const args = { site: SITE, start: day, end: day, tables: 'pages', quiet: true }

    await syncCommand.run!({ args, rawArgs: [], cmd: syncCommand })
    await syncCommand.run!({ args, rawArgs: [], cmd: syncCommand })

    const harness = createAnalyticsHarness({ mode: 'local', dataDir: configState.dataDir! })
    const siteId = harness.siteIdFor(SITE)
    const live = await harness.manifestStore.listLive({
      userId: harness.userId,
      siteId,
      table: 'pages',
    })
    expect(live).toHaveLength(1)

    const all = await harness.manifestStore.listAll({
      userId: harness.userId,
      siteId,
      table: 'pages',
    })
    expect(all).toHaveLength(2)
    expect(all.filter(e => e.retiredAt !== undefined)).toHaveLength(1)
  })
})

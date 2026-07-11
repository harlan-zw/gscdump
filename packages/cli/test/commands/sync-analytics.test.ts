import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
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

vi.mock('gscdump/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('gscdump/api')>()
  return {
    ...actual,
    googleSearchConsole: vi.fn(() => ({
      sites: clientSitesSpy,
      _rawQuery: rawQuerySpy,
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
})

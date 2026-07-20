import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { queryCommand } from '../../src/commands/query'

const mocks = vi.hoisted(() => ({
  rawQuery: vi.fn(),
  resolveSite: vi.fn(),
  loadConfig: vi.fn(() => Promise.resolve({})),
  storeQuery: vi.fn(),
  storeWatermarks: vi.fn(),
  storeRunRawSql: vi.fn(),
}))

vi.mock('gscdump', async (importOriginal) => {
  const actual = await importOriginal<typeof import('gscdump')>()
  return {
    ...actual,
    googleSearchConsole: vi.fn(() => ({
      sites: vi.fn().mockResolvedValue([{ siteUrl: 'https://example.com/', permissionLevel: 'siteOwner' }]),
      searchAnalytics: { query: mocks.rawQuery },
    })),
  }
})

vi.mock('../../src/auth', () => ({
  resolveAuth: vi.fn().mockResolvedValue({ clientId: 'x', clientSecret: 'y' }),
  getAuth: vi.fn().mockResolvedValue({ clientId: 'x', clientSecret: 'y' }),
  resolveBYOK: vi.fn(() => null),
}))

vi.mock('../../src/config', () => ({
  loadConfig: mocks.loadConfig,
  resolveDataDir: vi.fn(() => '/tmp/gscdump-query-test'),
}))

vi.mock('../../src/context', () => ({
  createCommandContext: vi.fn(async () => ({
    config: {},
    auth: {},
    client: {
      sites: vi.fn().mockResolvedValue([{ siteUrl: 'https://example.com/', permissionLevel: 'siteOwner' }]),
      searchAnalytics: { query: mocks.rawQuery },
    },
    store: {
      userId: 'u',
      siteIdFor: () => 'site',
      engine: {
        query: mocks.storeQuery,
        getWatermarks: mocks.storeWatermarks,
      },
      runRawSql: mocks.storeRunRawSql,
    },
    loadSites: vi.fn().mockResolvedValue([{ siteUrl: 'https://example.com/', permissionLevel: 'siteOwner' }]),
    resolveSite: mocks.resolveSite,
  })),
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
    },
  }
})

describe('query command', () => {
  let consoleOutput: string[] = []
  const originalLog = console.log
  let exitSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    consoleOutput = []
    console.log = (...args: unknown[]) => {
      consoleOutput.push(args.map(String).join(' '))
    }
    vi.clearAllMocks()
    mocks.resolveSite.mockResolvedValue('https://example.com/')
    mocks.loadConfig.mockResolvedValue({})
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`__exit_${code}__`)
    }) as never)
  })

  afterEach(() => {
    console.log = originalLog
    exitSpy.mockRestore()
  })

  it('has correct metadata', () => {
    expect(queryCommand.meta?.name).toBe('query')
    expect(queryCommand.meta?.description).toContain('search analytics')
  })

  it('exposes core flags', () => {
    expect(queryCommand.args?.site).toBeDefined()
    expect(queryCommand.args?.dimensions).toBeDefined()
    expect(queryCommand.args?.start).toBeDefined()
    expect(queryCommand.args?.end).toBeDefined()
    expect(queryCommand.args?.limit).toBeDefined()
    expect(queryCommand.args?.live).toBeDefined()
    expect(queryCommand.args?.sql).toBeDefined()
    expect(queryCommand.args?.format).toBeDefined()
    expect(queryCommand.args?.explain).toBeDefined()
  })

  it('--explain in --live mode prints request body and exits without calling API', async () => {
    await queryCommand.run!({
      args: {
        site: 'https://example.com/',
        dimensions: 'page,query',
        start: '2026-04-01',
        end: '2026-04-07',
        live: true,
        explain: true,
        format: 'json',
        limit: '100',
        quiet: true,
      },
      rawArgs: [],
      cmd: queryCommand,
    } as any)

    const jsonLine = consoleOutput.find(l => l.startsWith('{'))
    expect(jsonLine).toBeDefined()
    const parsed = JSON.parse(jsonLine!)
    expect(parsed).toHaveProperty('siteUrl', 'https://example.com/')
    expect(parsed.body).toMatchObject({
      startDate: '2026-04-01',
      endDate: '2026-04-07',
      dimensions: ['page', 'query'],
      rowLimit: 100,
    })
    expect(mocks.rawQuery).not.toHaveBeenCalled()
  })

  it('--live mode pages through GSC API and emits JSON output', async () => {
    mocks.rawQuery
      .mockResolvedValueOnce({
        rows: [{ keys: ['/a', 'foo'], clicks: 10, impressions: 100, ctr: 0.1, position: 5 }],
      })
      .mockResolvedValueOnce({ rows: [] })

    await queryCommand.run!({
      args: {
        site: 'https://example.com/',
        dimensions: 'page,query',
        start: '2026-04-01',
        end: '2026-04-07',
        live: true,
        format: 'json',
        limit: '1000',
        quiet: true,
      },
      rawArgs: [],
      cmd: queryCommand,
    } as any)

    expect(mocks.rawQuery).toHaveBeenCalledTimes(2)
    expect(mocks.rawQuery.mock.calls[1]![1]).toMatchObject({ rowLimit: 999, startRow: 1 })
    const jsonLine = consoleOutput.find(l => l.startsWith('{'))
    expect(jsonLine).toBeDefined()
    const parsed = JSON.parse(jsonLine!)
    expect(parsed.siteUrl).toBe('https://example.com/')
    expect(parsed.dimensions).toEqual(['page', 'query'])
    expect(parsed.data[0]).toMatchObject({ page: '/a', query: 'foo', clicks: 10 })
  })

  it('rejects invalid --data-state', async () => {
    await expect(queryCommand.run!({
      args: {
        'site': 'https://example.com/',
        'live': true,
        'data-state': 'bogus',
        'format': 'json',
        'limit': '100',
        'quiet': true,
      },
      rawArgs: [],
      cmd: queryCommand,
    } as any)).rejects.toThrow('__exit_1__')

    expect(exitSpy).toHaveBeenCalledWith(1)
  })

  it('scopes local --type coverage checks and query execution', async () => {
    mocks.storeWatermarks.mockResolvedValue([{
      newestDateSynced: '2026-04-30',
      oldestDateSynced: '2026-01-01',
    }])
    mocks.storeQuery.mockResolvedValue({ rows: [] })

    await queryCommand.run!({
      args: {
        site: 'https://example.com/',
        type: 'image',
        start: '2026-04-01',
        end: '2026-04-07',
        live: false,
        format: 'json',
        limit: '100',
        quiet: true,
      },
      rawArgs: [],
      cmd: queryCommand,
    } as any)

    expect(exitSpy).not.toHaveBeenCalled()
    expect(mocks.storeWatermarks).toHaveBeenCalledWith(expect.objectContaining({ searchType: 'image' }))
    expect(mocks.storeQuery.mock.calls[0]![0]).toMatchObject({ searchType: 'image' })
  })
})

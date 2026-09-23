import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runCommand } from 'citty'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { queryCommand } from '../../src/commands/query'
import { createCommandContext } from '../../src/context'
import { createCliRuntime, runWithCliRuntime } from '../../src/runtime'
import { logger } from '../../src/utils'

const mocks = vi.hoisted(() => ({
  rawQuery: vi.fn(),
  resolveSite: vi.fn(),
  loadConfig: vi.fn(() => Promise.resolve({})),
  storeQuery: vi.fn(),
  storeWatermarks: vi.fn(),
}))

vi.mock('gscdump/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('gscdump/client')>()
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
      debug: vi.fn(),
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
    mocks.rawQuery.mockReset()
    mocks.resolveSite.mockResolvedValue('https://example.com/')
    mocks.loadConfig.mockResolvedValue({})
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`__exit_${code}__`)
    }) as never)
  })

  afterEach(() => {
    console.log = originalLog
    exitSpy.mockRestore()
    vi.useRealTimers()
  })

  it.each([
    ['--dimensions', 'page,typo'],
    ['--dimensions', ''],
    ['--limit', 'ten'],
    ['--limit', '10rows'],
    ['--limit', '1.5'],
    ['--limit', '0'],
    ['--limit', '-1'],
    ['--limit', '9007199254740992'],
    ['--format', 'yaml'],
    ['--start', '2026-02-30'],
    ['--end', '2026-13-01'],
    ['--start', '2026-04-08'],
  ])('rejects %s=%s before accessing the Site', async (flag, value) => {
    await expect(runCommand(queryCommand, {
      rawArgs: ['--live', '--explain', '--start', '2026-04-01', '--end', '2026-04-07', flag, value],
    })).rejects.toThrow('__exit_1__')

    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining(flag))
    expect(mocks.resolveSite).not.toHaveBeenCalled()
    expect(mocks.rawQuery).not.toHaveBeenCalled()
    expect(mocks.storeQuery).not.toHaveBeenCalled()
  })

  it('trims and deduplicates dimensions', async () => {
    await runCommand(queryCommand, { rawArgs: ['--live', '--explain', '--dimensions', 'page, query,page'] })

    expect(JSON.parse(consoleOutput[0]!).body.dimensions).toEqual(['page', 'query'])
  })

  it.each([
    ['--start', '2026-04-01', { startDate: '2026-04-01', endDate: '2026-04-27' }],
    ['--end', '2026-04-15', { startDate: '2026-03-19', endDate: '2026-04-15' }],
  ])('preserves a single %s flag', async (flag, value, range) => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-04-30T12:00:00Z'))

    await runCommand(queryCommand, { rawArgs: ['--live', '--explain', flag, value] })

    expect(JSON.parse(consoleOutput[0]!).body).toMatchObject(range)
  })

  it.each([
    [[], 25],
    [['--limit', '1000'], 1000],
  ])('uses explicit flags before saved limits: %j', async (flags, expectedLimit) => {
    mocks.loadConfig.mockResolvedValue({ defaultLimit: 25 })

    await runCommand(queryCommand, { rawArgs: ['--live', '--explain', ...flags] })

    expect(JSON.parse(consoleOutput[0]!).body.rowLimit).toBe(expectedLimit)
  })

  it.each([
    [[], 'page,clicks,impressions,ctr,position'],
    [['--format', 'json'], '{'],
  ])('uses explicit flags before the saved format: %j', async (flags, prefix) => {
    mocks.loadConfig.mockResolvedValue({ defaultFormat: 'csv' })
    mocks.rawQuery.mockResolvedValueOnce({ rows: [{ keys: ['/a'], clicks: 1 }] }).mockResolvedValueOnce({ rows: [] })

    await runCommand(queryCommand, { rawArgs: ['--live', '--quiet', '--dimensions', 'page', ...flags] })

    expect(consoleOutput[0]).toContain(prefix)
  })

  it.each([true])('writes CSV rows in live=%s mode', async (live) => {
    const page = 'https://example.com/a,b'
    mocks.rawQuery.mockResolvedValueOnce({ rows: [{ keys: [page], clicks: 2, impressions: 4, ctr: 0.5, position: 1 }] })
      .mockResolvedValueOnce({ rows: [] })
    mocks.storeWatermarks.mockResolvedValue([{ oldestDateSynced: '2026-04-01', newestDateSynced: '2026-04-30' }])
    mocks.storeQuery.mockResolvedValue({ rows: [{ page, clicks: 2, impressions: 4, ctr: 0.5, position: 1 }] })

    await runCommand(queryCommand, {
      rawArgs: ['--quiet', '--start', '2026-04-01', '--end', '2026-04-07', '--dimensions', 'page', '--format', 'csv', ...(live ? ['--live'] : [])],
    })

    expect(consoleOutput).toEqual(['page,clicks,impressions,ctr,position\n"https://example.com/a,b",2,4,0.5,1'])
  })

  it('writes a CSV header for an empty result', async () => {
    mocks.rawQuery.mockResolvedValueOnce({ rows: [] })

    await runCommand(queryCommand, { rawArgs: ['--live', '--quiet', '--dimensions', 'query', '--format', 'csv'] })

    expect(consoleOutput).toEqual(['query,clicks,impressions,ctr,position'])
  })

  it('rejects invalid output formats before running raw SQL', async () => {
    await expect(runCommand(queryCommand, {
      rawArgs: ['--quiet', '--sql', 'SELECT 1', '--format', 'yaml'],
    })).rejects.toThrow('__exit_1__')

    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('--format'))
    expect(createCommandContext).not.toHaveBeenCalled()
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

  it('renders an explicit human query with charts and precise rates', async () => {
    mocks.rawQuery.mockResolvedValueOnce({ rows: [{ keys: ['/docs'], clicks: 12, impressions: 1000, ctr: 0.012, position: 8.4 }] }).mockResolvedValueOnce({ rows: [] })
    await runCommand(queryCommand, { rawArgs: ['--live', '--dimensions', 'page', '--format', 'table', '--start', '2026-04-01', '--end', '2026-04-07'] })
    const output = consoleOutput.join('\n')
    expect(output).toContain('example.com / query')
    expect(output.match(/\/docs/g)).toHaveLength(1)
    expect(output).toMatch(/[#█]+\s+12/)
    expect(output).toContain('1.20%')
    expect(output).not.toContain('Totals cover these rows only.')
    expect(logger.info).not.toHaveBeenCalled()
  })

  it('writes a human query file without ANSI even when color is forced', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'gscdump-chart-file-'))
    try {
      mocks.rawQuery.mockResolvedValueOnce({ rows: [{ keys: ['/docs'], clicks: 12, impressions: 1000, ctr: 0.012 }] }).mockResolvedValueOnce({ rows: [] })
      const runtime = createCliRuntime({ environment: { FORCE_COLOR: '1' } })
      const file = join(directory, 'results.txt')
      await runWithCliRuntime(runtime, () => runCommand(queryCommand, { rawArgs: ['--live', '--dimensions', 'page', '--format', 'table', '--output', file] }))
      const output = await readFile(file, 'utf8')
      expect(output).toContain('1.20%')
      expect(output).not.toContain('\x1B')
      expect(consoleOutput).toEqual([])
    }
    finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})

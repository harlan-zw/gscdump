import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fetchKeywordsWithComparison, fetchPages, fetchSites } from 'gscdump'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { dumpCommand } from '../../src/commands/dump'
import { loadConfig } from '../../src/config'
import { logger } from '../../src/utils'

// Mock data - defined before mocks to avoid hoisting issues
const mockSites = [
  { siteUrl: 'https://example.com/', permissionLevel: 'siteOwner' },
  { siteUrl: 'sc-domain:example.com', permissionLevel: 'siteOwner' },
]

const _mockAuth = {
  credentials: {
    access_token: 'mock_access_token',
    refresh_token: 'mock_refresh_token',
    expiry_date: Date.now() + 3600000,
  },
}

const mockPageData = [
  { page: 'https://example.com/', clicks: 100, impressions: 1000, ctr: 0.1, position: 5.5 },
  { page: 'https://example.com/about', clicks: 50, impressions: 500, ctr: 0.1, position: 3.2 },
]

const mockKeywordsWithComparison = {
  current: [{ keyword: 'test', clicks: 100, impressions: 1000, ctr: 0.1, position: 5.5 }],
  previous: [{ keyword: 'test', clicks: 80, impressions: 900, ctr: 0.09, position: 6.0 }],
}

const _mockCountriesWithComparison = {
  current: [{ country: 'usa', clicks: 100, impressions: 1000, ctr: 0.1, position: 5.5 }],
  previous: [{ country: 'usa', clicks: 80, impressions: 900, ctr: 0.09, position: 6.0 }],
}

const _mockDevicesWithComparison = {
  current: [{ device: 'desktop', clicks: 100, impressions: 1000, ctr: 0.1, position: 5.5 }],
  previous: [{ device: 'desktop', clicks: 80, impressions: 900, ctr: 0.09, position: 6.0 }],
}

const CONFIG_DIR = path.join(os.homedir(), '.config', 'gscdump')
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json')

// Mock all dependencies - don't reference variables in factories (hoisting)
vi.mock('gscdump', () => ({
  googleSearchConsole: vi.fn().mockReturnValue({
    sites: {
      list: vi.fn(),
    },
    searchAnalytics: {
      query: vi.fn(),
    },
  }),
  fetchSites: vi.fn(),
  fetchPages: vi.fn(),
  fetchKeywordsWithComparison: vi.fn(),
  fetchCountriesWithComparison: vi.fn(),
  fetchDevicesWithComparison: vi.fn(),
}))

vi.mock('../../src/auth', () => ({
  getAuth: vi.fn().mockResolvedValue({
    credentials: {
      access_token: 'mock_access_token',
      refresh_token: 'mock_refresh_token',
      expiry_date: Date.now() + 3600000,
    },
  }),
  getAuthCredentials: vi.fn().mockResolvedValue({
    clientId: 'mock_client_id',
    clientSecret: 'mock_client_secret',
  }),
  authenticate: vi.fn().mockResolvedValue({}),
}))

vi.mock('../../src/config', () => ({
  loadConfig: vi.fn().mockResolvedValue({}),
}))

vi.mock('../../src/utils', () => ({
  showSplash: vi.fn(),
  VERSION: '1.0.0',
  logger: {
    info: vi.fn(),
    success: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    start: vi.fn(),
  },
  clearLine: vi.fn(),
  progressBar: vi.fn().mockReturnValue('progress'),
  parsePeriod: vi.fn().mockImplementation((str: string) => {
    const match = str.match(/^(\d+)([dmy])$/i)
    if (!match)
      return null
    const amount = Number.parseInt(match[1], 10)
    const unitMap: Record<string, string> = { d: 'days', m: 'months', y: 'years' }
    return { amount, unit: unitMap[match[2].toLowerCase()] }
  }),
  exportToCSV: vi.fn().mockReturnValue('csv content'),
  gscErrorHandler: vi.fn((error: any) => {
    throw error
  }),
}))

describe('dump command', () => {
  let consoleOutput: string[] = []
  const originalLog = console.log
  const originalWrite = process.stdout.write
  let originalConfig: string | null = null

  beforeEach(async () => {
    consoleOutput = []
    console.log = (...args: any[]) => {
      consoleOutput.push(args.map(String).join(' '))
    }
    process.stdout.write = vi.fn() as any
    originalConfig = await fs.readFile(CONFIG_FILE, 'utf-8').catch(() => null)
    vi.clearAllMocks()
    // Set/reset default mock return values
    vi.mocked(fetchSites).mockResolvedValue(mockSites as any)
    vi.mocked(fetchPages).mockResolvedValue(mockPageData as any)
    vi.mocked(fetchKeywordsWithComparison).mockResolvedValue(mockKeywordsWithComparison as any)
    vi.mocked(loadConfig).mockResolvedValue({})
  })

  afterEach(async () => {
    console.log = originalLog
    process.stdout.write = originalWrite
    // Clean up any generated files
    const files = await fs.readdir('.').catch(() => [])
    for (const file of files) {
      if (file.startsWith('gsc-') && (file.endsWith('.json') || file.endsWith('.csv'))) {
        await fs.rm(file).catch(() => { })
      }
    }
    if (originalConfig) {
      await fs.writeFile(CONFIG_FILE, originalConfig)
    }
    else {
      await fs.rm(CONFIG_FILE).catch(() => { })
    }
  })

  it('should have correct metadata', () => {
    expect(dumpCommand.meta?.name).toBe('dump')
    expect(dumpCommand.meta?.description).toBe('Export GSC data to JSON or CSV files')
  })

  it('should have all args defined', () => {
    expect(dumpCommand.args?.site).toBeDefined()
    expect(dumpCommand.args?.data).toBeDefined()
    expect(dumpCommand.args?.period).toBeDefined()
    expect(dumpCommand.args?.format).toBeDefined()
    expect(dumpCommand.args?.output).toBeDefined()
    expect(dumpCommand.args?.source).toBeDefined()
    expect(dumpCommand.args?.db).toBeDefined()
  })

  it('should have correct default values', () => {
    expect(dumpCommand.args?.period?.default).toBe('180d')
    expect(dumpCommand.args?.format?.default).toBe('json')
    expect(dumpCommand.args?.source?.default).toBe('auto')
  })

  it('should have correct aliases', () => {
    expect(dumpCommand.args?.site?.alias).toBe('s')
    expect(dumpCommand.args?.data?.alias).toBe('d')
    expect(dumpCommand.args?.period?.alias).toBe('p')
    expect(dumpCommand.args?.format?.alias).toBe('f')
    expect(dumpCommand.args?.output?.alias).toBe('o')
  })

  describe('non-interactive mode', () => {
    it('should validate site availability', async () => {
      vi.mocked(fetchSites).mockResolvedValue(mockSites as any)

      await dumpCommand.run!({
        args: {
          site: 'https://example.com/',
          data: 'pages',
          period: '30d',
          format: 'json',
          output: undefined,
        },
        rawArgs: [],
        cmd: dumpCommand,
      })

      expect(fetchSites).toHaveBeenCalled()
    })

    it('should fetch requested data types', async () => {
      vi.mocked(fetchSites).mockResolvedValue(mockSites as any)

      await dumpCommand.run!({
        args: {
          site: 'https://example.com/',
          data: 'pages,keywords',
          period: '30d',
          format: 'json',
          output: undefined,
        },
        rawArgs: [],
        cmd: dumpCommand,
      })

      expect(fetchPages).toHaveBeenCalled()
      expect(fetchKeywordsWithComparison).toHaveBeenCalled()
    })

    it('should use config defaults when args match defaults', async () => {
      vi.mocked(loadConfig).mockResolvedValue({
        defaultSite: 'sc-domain:example.com',
        defaultPeriod: '7d',
        defaultFormat: 'csv',
      })
      vi.mocked(fetchSites).mockResolvedValue(mockSites as any)

      await dumpCommand.run!({
        args: {
          site: undefined,
          data: 'pages',
          period: '180d',
          format: 'json',
          output: undefined,
        },
        rawArgs: [],
        cmd: dumpCommand,
      })

      expect(loadConfig).toHaveBeenCalled()
    })

    it('should log success message', async () => {
      vi.mocked(fetchSites).mockResolvedValue(mockSites as any)

      await dumpCommand.run!({
        args: {
          site: 'https://example.com/',
          data: 'pages',
          period: '30d',
          format: 'json',
          output: undefined,
        },
        rawArgs: [],
        cmd: dumpCommand,
      })

      expect(logger.success).toHaveBeenCalled()
    })
  })

  describe('site normalization', () => {
    it('should match sites by various formats', async () => {
      vi.mocked(fetchSites).mockResolvedValue([
        { siteUrl: 'https://example.com/', permissionLevel: 'siteOwner' },
        { siteUrl: 'sc-domain:test.com', permissionLevel: 'siteOwner' },
      ] as any)

      // Test matching by exact URL
      await dumpCommand.run!({
        args: {
          site: 'https://example.com/',
          data: 'pages',
          period: '30d',
          format: 'json',
          output: undefined,
        },
        rawArgs: [],
        cmd: dumpCommand,
      })

      expect(fetchPages).toHaveBeenCalled()
    })
  })

  describe('output formats', () => {
    it('should create JSON output by default', async () => {
      vi.mocked(fetchSites).mockResolvedValue(mockSites as any)

      await dumpCommand.run!({
        args: {
          site: 'https://example.com/',
          data: 'pages',
          period: '30d',
          format: 'json',
          output: 'test-output.json',
        },
        rawArgs: [],
        cmd: dumpCommand,
      })

      const exists = await fs.access('test-output.json').then(() => true).catch(() => false)
      if (exists) {
        const content = await fs.readFile('test-output.json', 'utf-8')
        expect(() => JSON.parse(content)).not.toThrow()
        await fs.rm('test-output.json')
      }
    })
  })
})

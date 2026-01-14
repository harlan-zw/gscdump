import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { syncCountries, syncDevices, syncKeywords, syncPages, syncSites } from '@gscdump/db'
import { fetchGscSites } from 'gscdump'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { syncCommand } from '../../src/commands/sync'
import { loadConfig } from '../../src/config'
import { logger } from '../../src/utils'

// Keep fetchGscSites reference for eslint
void fetchGscSites

// Mock data - defined before mocks to avoid hoisting issues
const mockSites = [
  { siteUrl: 'https://example.com/', permissionLevel: 'siteOwner' },
  { siteUrl: 'sc-domain:example.com', permissionLevel: 'siteOwner' },
]

const mockAuth = {
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

const TEST_DB = '/tmp/gscdump-test.db'
const CONFIG_DIR = path.join(os.homedir(), '.config', 'gscdump')
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json')

// Mock all dependencies - don't reference variables in factories (hoisting)
vi.mock('@gscdump/db', () => ({
  createGscDb: vi.fn().mockReturnValue({}),
  getSiteByProperty: vi.fn(),
  syncCountries: vi.fn(),
  syncDevices: vi.fn(),
  syncKeywordPaths: vi.fn(),
  syncKeywords: vi.fn(),
  syncPages: vi.fn(),
  syncSites: vi.fn(),
  updateLastSynced: vi.fn(),
}))

vi.mock('db0/connectors/better-sqlite3', () => ({
  default: vi.fn().mockReturnValue({}),
}))

vi.mock('gscdump', () => ({
  fetchGscSites: vi.fn(),
  userPeriodRange: vi.fn().mockReturnValue({
    period: { startDate: '2024-01-01', endDate: '2024-01-31' },
    prevPeriod: { startDate: '2023-12-01', endDate: '2023-12-31' },
  }),
}))

vi.mock('../../src/auth', () => ({
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
}))

describe('sync command', () => {
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
    // Set default mock return values
    vi.mocked(fetchGscSites).mockResolvedValue(mockSites as any)
    vi.mocked(syncSites).mockResolvedValue([{ siteId: 1, property: 'https://example.com/' }] as any)
    vi.mocked(syncPages).mockResolvedValue(mockPageData as any)
    vi.mocked(syncKeywords).mockResolvedValue([{ keyword: 'test' }] as any)
    vi.mocked(syncCountries).mockResolvedValue([{ country: 'usa' }] as any)
    vi.mocked(syncDevices).mockResolvedValue([{ device: 'desktop' }] as any)
  })

  afterEach(async () => {
    console.log = originalLog
    process.stdout.write = originalWrite
    await fs.rm(TEST_DB).catch(() => {})
    if (originalConfig) {
      await fs.writeFile(CONFIG_FILE, originalConfig)
    }
    else {
      await fs.rm(CONFIG_FILE).catch(() => {})
    }
  })

  it('should have correct metadata', () => {
    expect(syncCommand.meta?.name).toBe('sync')
    expect(syncCommand.meta?.description).toBe('Sync GSC data to SQLite database')
  })

  it('should have all args defined', () => {
    expect(syncCommand.args?.db).toBeDefined()
    expect(syncCommand.args?.site).toBeDefined()
    expect(syncCommand.args?.period).toBeDefined()
    expect(syncCommand.args?.granular).toBeDefined()
    expect(syncCommand.args?.quiet).toBeDefined()
    expect(syncCommand.args?.json).toBeDefined()
    expect(syncCommand.args?.incremental).toBeDefined()
    expect(syncCommand.args?.since).toBeDefined()
  })

  it('should have correct default values', () => {
    expect(syncCommand.args?.db?.default).toBe('./gscdump.db')
    expect(syncCommand.args?.period?.default).toBe('90d')
    expect(syncCommand.args?.granular?.default).toBe(false)
    expect(syncCommand.args?.quiet?.default).toBe(false)
    expect(syncCommand.args?.json?.default).toBe(false)
    expect(syncCommand.args?.incremental?.default).toBe(false)
    expect(syncCommand.args?.since?.default).toBeUndefined()
  })

  describe('sync execution', () => {
    it('should sync sites first', async () => {
      await syncCommand.run!({
        args: { db: TEST_DB, period: '30d', granular: false, quiet: false, json: false },
        rawArgs: [],
        cmd: syncCommand,
      })

      expect(syncSites).toHaveBeenCalled()
    })

    it('should sync all data types', async () => {
      await syncCommand.run!({
        args: { db: TEST_DB, period: '30d', granular: false, quiet: false, json: false },
        rawArgs: [],
        cmd: syncCommand,
      })

      expect(syncPages).toHaveBeenCalled()
      expect(syncKeywords).toHaveBeenCalled()
      expect(syncCountries).toHaveBeenCalled()
      expect(syncDevices).toHaveBeenCalled()
    })

    it('should output JSON report when --json is set', async () => {
      await syncCommand.run!({
        args: { db: TEST_DB, period: '30d', granular: false, quiet: false, json: true },
        rawArgs: [],
        cmd: syncCommand,
      })

      const jsonOutput = consoleOutput.find(line => line.includes('"database"'))
      expect(jsonOutput).toBeDefined()
      const report = JSON.parse(jsonOutput!)
      expect(report).toHaveProperty('database')
      expect(report).toHaveProperty('period')
      expect(report).toHaveProperty('sites')
      expect(report).toHaveProperty('totalRows')
    })

    it('should suppress output when --quiet is set', async () => {
      await syncCommand.run!({
        args: { db: TEST_DB, period: '30d', granular: false, quiet: true, json: false },
        rawArgs: [],
        cmd: syncCommand,
      })

      expect(logger.info).not.toHaveBeenCalled()
      expect(logger.success).not.toHaveBeenCalled()
    })

    it('should use config defaults', async () => {
      vi.mocked(loadConfig).mockResolvedValue({
        defaultDb: '/custom/path.db',
        defaultPeriod: '7d',
      })

      await syncCommand.run!({
        args: { db: './gscdump.db', period: '90d', granular: false, quiet: true, json: false },
        rawArgs: [],
        cmd: syncCommand,
      })

      // Config defaults should be applied when args match defaults
      expect(loadConfig).toHaveBeenCalled()
    })
  })

  describe('jSON report structure', () => {
    it('should include all expected fields in report', async () => {
      await syncCommand.run!({
        args: { db: TEST_DB, period: '30d', granular: false, quiet: false, json: true },
        rawArgs: [],
        cmd: syncCommand,
      })

      const jsonOutput = consoleOutput.find(line => line.includes('"database"'))
      const report = JSON.parse(jsonOutput!)

      expect(report.database).toContain('gscdump-test.db')
      expect(report.period).toHaveProperty('start')
      expect(report.period).toHaveProperty('end')
      expect(report.sites).toBeInstanceOf(Array)
      expect(typeof report.totalRows).toBe('number')
    })

    it('should include row counts per site', async () => {
      await syncCommand.run!({
        args: { db: TEST_DB, period: '30d', granular: false, quiet: false, json: true },
        rawArgs: [],
        cmd: syncCommand,
      })

      const jsonOutput = consoleOutput.find(line => line.includes('"database"'))
      const report = JSON.parse(jsonOutput!)

      expect(report.sites[0]).toHaveProperty('site')
      expect(report.sites[0]).toHaveProperty('rows')
      expect(report.sites[0].rows).toHaveProperty('pages')
      expect(report.sites[0].rows).toHaveProperty('keywords')
      expect(report.sites[0].rows).toHaveProperty('countries')
      expect(report.sites[0].rows).toHaveProperty('devices')
      expect(report.sites[0].rows).toHaveProperty('total')
    })
  })
})

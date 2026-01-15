import { fetchSites } from 'gscdump'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { sitesCommand } from '../../src/commands/sites'

// Mock data - defined before mocks
const mockSites = [
  { siteUrl: 'https://example.com/', permissionLevel: 'siteOwner' },
  { siteUrl: 'sc-domain:example.com', permissionLevel: 'siteOwner' },
  { siteUrl: 'https://test.example.com/', permissionLevel: 'siteFullUser' },
]

// Mock modules - must not reference external variables
vi.mock('gscdump', () => ({
  googleSearchConsole: vi.fn().mockReturnValue({
    sites: {
      list: vi.fn(),
    },
  }),
  fetchSites: vi.fn(),
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
  gscErrorHandler: vi.fn((error: any) => {
    throw error
  }),
}))

describe('sites command', () => {
  let consoleOutput: string[] = []
  const originalLog = console.log

  beforeEach(() => {
    consoleOutput = []
    console.log = (...args: any[]) => {
      consoleOutput.push(args.map(String).join(' '))
    }
    vi.clearAllMocks()
  })

  afterEach(() => {
    console.log = originalLog
  })

  it('should have correct metadata', () => {
    expect(sitesCommand.meta?.name).toBe('sites')
    expect(sitesCommand.meta?.description).toBe('List available GSC sites')
  })

  it('should have json flag', () => {
    expect(sitesCommand.args?.json).toBeDefined()
    expect(sitesCommand.args?.json?.type).toBe('boolean')
    expect(sitesCommand.args?.json?.default).toBe(false)
  })

  it('should list sites in human-readable format', async () => {
    vi.mocked(fetchSites).mockResolvedValue(mockSites as any)

    await sitesCommand.run!({
      args: { json: false },
      rawArgs: [],
      cmd: sitesCommand,
    })

    expect(fetchSites).toHaveBeenCalled()
  })

  it('should output JSON when --json flag is set', async () => {
    vi.mocked(fetchSites).mockResolvedValue(mockSites as any)

    await sitesCommand.run!({
      args: { json: true },
      rawArgs: [],
      cmd: sitesCommand,
    })

    const jsonOutput = consoleOutput.find(line => line.startsWith('['))
    expect(jsonOutput).toBeDefined()
    const parsed = JSON.parse(jsonOutput!)
    expect(Array.isArray(parsed)).toBe(true)
    expect(parsed).toHaveLength(3)
    expect(parsed[0]).toHaveProperty('url')
    expect(parsed[0]).toHaveProperty('permission')
  })

  it('should filter out unverified sites', async () => {
    const sitesWithUnverified = [
      ...mockSites,
      { siteUrl: 'https://unverified.com/', permissionLevel: 'siteUnverifiedUser' },
    ]
    vi.mocked(fetchSites).mockResolvedValue(sitesWithUnverified as any)

    await sitesCommand.run!({
      args: { json: true },
      rawArgs: [],
      cmd: sitesCommand,
    })

    const jsonOutput = consoleOutput.find(line => line.startsWith('['))
    const parsed = JSON.parse(jsonOutput!)
    expect(parsed).toHaveLength(3) // Should not include unverified
    expect(parsed.find((s: any) => s.url === 'https://unverified.com/')).toBeUndefined()
  })

  it('should filter out sites without URL', async () => {
    const sitesWithNull = [
      ...mockSites,
      { siteUrl: null, permissionLevel: 'siteOwner' },
      { siteUrl: undefined, permissionLevel: 'siteOwner' },
    ]
    vi.mocked(fetchSites).mockResolvedValue(sitesWithNull as any)

    await sitesCommand.run!({
      args: { json: true },
      rawArgs: [],
      cmd: sitesCommand,
    })

    const jsonOutput = consoleOutput.find(line => line.startsWith('['))
    const parsed = JSON.parse(jsonOutput!)
    expect(parsed).toHaveLength(3)
  })

  it('should handle empty sites list', async () => {
    vi.mocked(fetchSites).mockResolvedValue([])

    await sitesCommand.run!({
      args: { json: false },
      rawArgs: [],
      cmd: sitesCommand,
    })

    // Should not throw, just show warning
    expect(fetchSites).toHaveBeenCalled()
  })
})

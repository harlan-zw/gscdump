import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { sitesCommand } from '../../src/commands/sites'
import { getDriver } from '../../src/driver'

const mockSites = [
  { siteUrl: 'https://example.com/', permissionLevel: 'siteOwner' },
  { siteUrl: 'sc-domain:example.com', permissionLevel: 'siteOwner' },
  { siteUrl: 'https://test.example.com/', permissionLevel: 'siteFullUser' },
]

vi.mock('gscdump/driver', async (importOriginal) => {
  const actual = await importOriginal<typeof import('gscdump/driver')>()
  return {
    ...actual,
    isCloudDriver: vi.fn(() => false),
  }
})

vi.mock('../../src/driver', () => ({
  getDriver: vi.fn(),
}))

vi.mock('../../src/utils', () => ({
  showSplash: vi.fn(),
  VERSION: '1.0.0',
  progressBar: vi.fn(() => ''),
  logger: {
    info: vi.fn(),
    success: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    start: vi.fn(),
  },
}))

function mockLocalDriver(sites: unknown[]): void {
  vi.mocked(getDriver).mockResolvedValue({
    sites: vi.fn().mockResolvedValue(sites),
  } as never)
}

describe('sites command', () => {
  let consoleOutput: string[] = []
  const originalLog = console.log

  beforeEach(() => {
    consoleOutput = []
    console.log = (...args: unknown[]) => {
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
    mockLocalDriver(mockSites)

    await sitesCommand.run!({
      args: { json: false },
      rawArgs: [],
      cmd: sitesCommand,
    })

    const output = consoleOutput.join('\n')
    expect(output).toContain('https://example.com/')
    expect(output).toContain('sc-domain:example.com')
    expect(output).toContain('https://test.example.com/')
  })

  it('should output JSON when --json flag is set', async () => {
    mockLocalDriver(mockSites)

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
    expect(parsed[0]).toHaveProperty('siteUrl')
    expect(parsed[0]).toHaveProperty('permissionLevel')
  })

  it('should handle empty sites list', async () => {
    mockLocalDriver([])

    await sitesCommand.run!({
      args: { json: false },
      rawArgs: [],
      cmd: sitesCommand,
    })

    expect(getDriver).toHaveBeenCalled()
  })
})

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { inspectCommand } from '../../src/commands/inspect'

const inspectMock = vi.fn()

vi.mock('gscdump', async (importOriginal) => {
  const actual = await importOriginal<typeof import('gscdump')>()
  return {
    ...actual,
    googleSearchConsole: vi.fn(() => ({
      inspect: inspectMock,
      sites: vi.fn().mockResolvedValue([{ siteUrl: 'https://example.com/', permissionLevel: 'siteOwner' }]),
    })),
    batchInspectUrls: vi.fn(async (_c, _site, urls) => urls.map((url: string) => ({
      url,
      isIndexed: url.includes('indexed'),
      inspection: { indexStatusResult: { verdict: url.includes('indexed') ? 'PASS' : 'FAIL' } },
    }))),
  }
})

vi.mock('../../src/auth', () => ({
  resolveAuth: vi.fn().mockResolvedValue('mock-token'),
  getAuth: vi.fn().mockResolvedValue({ clientId: 'x', clientSecret: 'y' }),
  resolveBYOK: vi.fn(() => null),
}))

vi.mock('../../src/config', () => ({
  loadConfig: vi.fn().mockResolvedValue({ defaultSite: 'https://example.com/' }),
  loadResolvedConfig: vi.fn().mockResolvedValue({
    config: { defaultSite: 'https://example.com/' },
    dataDir: '/tmp/gscdump-test',
  }),
  resolveDataDir: vi.fn(() => '/tmp/gscdump-test'),
}))

vi.mock('../../src/error-handler', () => ({
  gscErrorHandler: vi.fn((e: unknown) => { throw e }),
}))

vi.mock('../../src/utils', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/utils')>()
  return {
    ...actual,
    showSplash: vi.fn(),
    VERSION: '1.0.0',
    logger: {
      info: vi.fn(),
      success: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      start: vi.fn(),
    },
  }
})

describe('inspect command', () => {
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

  it('has correct metadata and batch subcommand', () => {
    expect(inspectCommand.meta?.name).toBe('inspect')
    expect(inspectCommand.subCommands).toHaveProperty('batch')
  })

  it('emits json for single URL inspect when --json', async () => {
    inspectMock.mockResolvedValue({
      inspectionResult: { indexStatusResult: { verdict: 'PASS', coverageState: 'Submitted and indexed' } },
    })
    await inspectCommand.run!({
      args: { url: 'https://example.com/x', site: 'https://example.com/', json: true },
      rawArgs: [],
      cmd: inspectCommand,
    })
    const json = JSON.parse(consoleOutput[0])
    expect(json.url).toBe('https://example.com/x')
    expect(json.verdict).toBe('PASS')
    expect(json.isIndexed).toBe(true)
  })

  it('does not present deprecated mobile usability data', async () => {
    inspectMock.mockResolvedValue({
      inspectionResult: {
        indexStatusResult: { verdict: 'PASS' },
        mobileUsabilityResult: { verdict: 'FAIL', issues: [{ issueType: 'LEGACY' }] },
      },
    })
    await inspectCommand.run!({
      args: { url: 'https://example.com/x', site: 'https://example.com/', json: false },
      rawArgs: [],
      cmd: inspectCommand,
    })

    expect(consoleOutput.join('\n')).not.toContain('Mobile usability')
    expect(consoleOutput.join('\n')).not.toContain('LEGACY')
  })

  it('batch invokes batchInspectUrls for each URL', async () => {
    const batch = inspectCommand.subCommands!.batch as any
    await batch.run({
      args: {
        'urls': ['https://example.com/indexed', 'https://example.com/missing'],
        'site': 'https://example.com/',
        'delay-ms': '0',
        'quiet': true,
        'json': true,
      },
      rawArgs: [],
      cmd: batch,
    })
    const json = JSON.parse(consoleOutput[0])
    expect(json).toHaveLength(2)
    expect(json[0].isIndexed).toBe(true)
    expect(json[1].isIndexed).toBe(false)
  })
})

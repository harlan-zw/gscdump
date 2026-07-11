import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { sitesCommand } from '../../src/commands/sites'

const mockSites = [
  { siteUrl: 'https://example.com/', permissionLevel: 'siteOwner' },
  { siteUrl: 'sc-domain:example.com', permissionLevel: 'siteOwner' },
  { siteUrl: 'https://test.example.com/', permissionLevel: 'siteFullUser' },
  { siteUrl: 'https://unverified.example.com/', permissionLevel: 'siteUnverifiedUser' },
]

const clientSitesMock = vi.fn()
const sitesAddMock = vi.fn()
const sitesDeleteMock = vi.fn()
const verificationGetTokenMock = vi.fn()
const verificationInsertMock = vi.fn()

vi.mock('gscdump/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('gscdump/api')>()
  return {
    ...actual,
    googleSearchConsole: vi.fn(() => {
      // Build lazily so the mock vars exist by the time this runs.
      const sites = Object.assign((...args: unknown[]) => clientSitesMock(...args), {
        list: clientSitesMock,
        add: sitesAddMock,
        delete: sitesDeleteMock,
      })
      return {
        sites,
        verification: {
          getToken: verificationGetTokenMock,
          insert: verificationInsertMock,
          list: vi.fn(),
          get: vi.fn(),
          delete: vi.fn(),
        },
      }
    }),
  }
})

vi.mock('../../src/auth', () => ({
  getAuth: vi.fn().mockResolvedValue({ clientId: 'x', clientSecret: 'y' }),
  resolveAuth: vi.fn().mockResolvedValue({ clientId: 'x', clientSecret: 'y' }),
  resolveBYOK: vi.fn(() => null),
}))

vi.mock('../../src/error-handler', () => ({
  gscErrorHandler: vi.fn((e: unknown) => { throw e }),
}))

vi.mock('../../src/utils', () => ({
  OUTPUT_ARGS: { json: { type: 'boolean', default: false, description: 'Output as JSON' }, quiet: { type: 'boolean', alias: 'q', default: false, description: 'Suppress info/success output' } },
  applyOutputMode: vi.fn((a: any) => ({ json: Boolean(a?.json), quiet: Boolean(a?.json) || Boolean(a?.quiet) })),
  showSplash: vi.fn(),
  VERSION: '1.0.0',
  progressBar: vi.fn(() => ''),
  setQuiet: vi.fn(),
  setNoColor: vi.fn(),
  logger: {
    info: vi.fn(),
    success: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    start: vi.fn(),
  },
}))

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
    expect(sitesCommand.meta?.description).toContain('List')
  })

  it('should expose add/delete/verify-token/verify subcommands', () => {
    expect(sitesCommand.subCommands?.add).toBeDefined()
    expect(sitesCommand.subCommands?.delete).toBeDefined()
    expect(sitesCommand.subCommands?.['verify-token']).toBeDefined()
    expect(sitesCommand.subCommands?.verify).toBeDefined()
  })

  it('should have json flag', () => {
    expect(sitesCommand.args?.json).toBeDefined()
    expect(sitesCommand.args?.json?.type).toBe('boolean')
    expect(sitesCommand.args?.json?.default).toBe(false)
  })

  it('should list sites in human-readable format', async () => {
    clientSitesMock.mockResolvedValue(mockSites)

    await sitesCommand.run!({
      args: { json: false },
      rawArgs: [],
      cmd: sitesCommand,
    })

    const output = consoleOutput.join('\n')
    expect(output).toContain('https://example.com/')
    expect(output).toContain('sc-domain:example.com')
    expect(output).toContain('https://test.example.com/')
    expect(output).not.toContain('unverified.example.com')
  })

  it('should output JSON when --json flag is set', async () => {
    clientSitesMock.mockResolvedValue(mockSites)

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
    clientSitesMock.mockResolvedValue([])

    await sitesCommand.run!({
      args: { json: false },
      rawArgs: [],
      cmd: sitesCommand,
    })

    expect(clientSitesMock).toHaveBeenCalled()
  })
})

describe('sites add', () => {
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

  it('calls client.sites.add and emits JSON', async () => {
    sitesAddMock.mockResolvedValue(undefined)
    const cmd = sitesCommand.subCommands!.add
    await cmd.run!({
      args: { url: 'https://example.com/', json: true, quiet: false },
      rawArgs: [],
      cmd,
    } as any)

    expect(sitesAddMock).toHaveBeenCalledWith('https://example.com/')
    const jsonOutput = consoleOutput.find(l => l.startsWith('{'))
    expect(jsonOutput).toBeDefined()
    const parsed = JSON.parse(jsonOutput!)
    expect(parsed).toEqual({ siteUrl: 'https://example.com/', status: 'added', verified: false })
  })

  it('handles sc-domain: properties', async () => {
    sitesAddMock.mockResolvedValue(undefined)
    const cmd = sitesCommand.subCommands!.add
    await cmd.run!({
      args: { url: 'sc-domain:example.com', json: true, quiet: false },
      rawArgs: [],
      cmd,
    } as any)

    expect(sitesAddMock).toHaveBeenCalledWith('sc-domain:example.com')
  })
})

describe('sites delete', () => {
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

  it('calls client.sites.delete with --yes (no prompt)', async () => {
    sitesDeleteMock.mockResolvedValue(undefined)
    const cmd = sitesCommand.subCommands!.delete
    await cmd.run!({
      args: { url: 'https://example.com/', yes: true, json: true, quiet: false },
      rawArgs: [],
      cmd,
    } as any)

    expect(sitesDeleteMock).toHaveBeenCalledWith('https://example.com/')
    const jsonOutput = consoleOutput.find(l => l.startsWith('{'))
    expect(jsonOutput).toBeDefined()
    const parsed = JSON.parse(jsonOutput!)
    expect(parsed.status).toBe('deleted')
  })
})

describe('sites verify-token', () => {
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

  it('defaults to META for URL-prefix and DNS_TXT for sc-domain:', async () => {
    verificationGetTokenMock.mockResolvedValue({ method: 'META', token: 'meta-tok' })
    const cmd = sitesCommand.subCommands!['verify-token']

    await cmd.run!({
      args: { url: 'https://example.com/', json: true, quiet: false },
      rawArgs: [],
      cmd,
    } as any)

    expect(verificationGetTokenMock).toHaveBeenCalledWith({
      site: { type: 'SITE', identifier: 'https://example.com/' },
      verificationMethod: 'META',
    })

    verificationGetTokenMock.mockResolvedValue({ method: 'DNS_TXT', token: 'google-site-verification=dns-tok' })
    await cmd.run!({
      args: { url: 'sc-domain:example.com', json: true, quiet: false },
      rawArgs: [],
      cmd,
    } as any)

    expect(verificationGetTokenMock).toHaveBeenLastCalledWith({
      site: { type: 'INET_DOMAIN', identifier: 'example.com' },
      verificationMethod: 'DNS_TXT',
    })
  })

  it('rejects invalid method/site combinations', async () => {
    const cmd = sitesCommand.subCommands!['verify-token']
    const exit = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`__exit_${code}__`)
    }) as never)

    await expect(cmd.run!({
      args: { url: 'sc-domain:example.com', method: 'META', json: true, quiet: false },
      rawArgs: [],
      cmd,
    } as any)).rejects.toThrow('__exit_1__')

    expect(exit).toHaveBeenCalledWith(1)
    exit.mockRestore()
  })

  it('emits placement instructions for META', async () => {
    verificationGetTokenMock.mockResolvedValue({ method: 'META', token: 'abc123' })
    const cmd = sitesCommand.subCommands!['verify-token']

    await cmd.run!({
      args: { url: 'https://example.com/', method: 'META', json: false, quiet: false },
      rawArgs: [],
      cmd,
    } as any)

    const output = consoleOutput.join('\n')
    expect(output).toContain('google-site-verification')
    expect(output).toContain('abc123')
  })
})

describe('sites verify', () => {
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

  it('calls verification.insert with resolved site shape', async () => {
    verificationInsertMock.mockResolvedValue({
      id: 'https://example.com/',
      site: { type: 'SITE', identifier: 'https://example.com/' },
      owners: ['user@example.com'],
    })
    const cmd = sitesCommand.subCommands!.verify

    await cmd.run!({
      args: { url: 'https://example.com/', method: 'META', json: true, quiet: false },
      rawArgs: [],
      cmd,
    } as any)

    expect(verificationInsertMock).toHaveBeenCalledWith({
      site: { type: 'SITE', identifier: 'https://example.com/' },
      verificationMethod: 'META',
    })

    const jsonOutput = consoleOutput.find(l => l.startsWith('{'))
    expect(jsonOutput).toBeDefined()
    const parsed = JSON.parse(jsonOutput!)
    expect(parsed.resource.owners).toEqual(['user@example.com'])
  })
})

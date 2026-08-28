import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { doctorCommand } from '../../src/commands/doctor'

const mocks = vi.hoisted(() => ({
  resolveBYOK: vi.fn(() => null),
  loadTokens: vi.fn(() => Promise.resolve(null)),
  resolveAuth: vi.fn(),
  loadConfig: vi.fn(() => Promise.resolve({})),
  loadResolvedConfig: vi.fn(() => Promise.resolve({ config: {}, dataDir: '/tmp/gscdump-doctor-test' })),
  resolveDataDir: vi.fn(() => '/tmp/gscdump-doctor-test'),
  parseEnvFile: vi.fn(() => null),
  ofetchRaw: vi.fn(),
  ofetch: vi.fn(),
  googleSearchConsole: vi.fn(() => ({
    sites: vi.fn().mockResolvedValue([
      { siteUrl: 'https://example.com/', permissionLevel: 'siteOwner' },
    ]),
  })),
  fsStat: vi.fn(() => Promise.resolve(null)),
  fsWriteFile: vi.fn().mockResolvedValue(undefined),
  fsRm: vi.fn().mockResolvedValue(undefined),
  createLocalStore: vi.fn(() => ({
    engine: {
      getWatermarks: vi.fn().mockResolvedValue([]),
    },
  })),
}))

vi.mock('../../src/auth', () => ({
  resolveBYOK: mocks.resolveBYOK,
  loadTokens: mocks.loadTokens,
  resolveAuth: (...args: unknown[]) => mocks.resolveAuth(...args),
}))

vi.mock('../../src/config', () => ({
  loadConfig: mocks.loadConfig,
  loadResolvedConfig: mocks.loadResolvedConfig,
  resolveDataDir: mocks.resolveDataDir,
}))

vi.mock('../../src/env-file', () => ({
  parseEnvFile: mocks.parseEnvFile,
}))

vi.mock('../../src/local-store', () => ({
  createLocalStore: mocks.createLocalStore,
}))

vi.mock('../../src/utils', () => ({
  OUTPUT_ARGS: { json: { type: 'boolean', default: false, description: 'Output as JSON' }, quiet: { type: 'boolean', alias: 'q', default: false, description: 'Suppress info/success output' } },
  applyOutputMode: vi.fn((a: any) => ({ json: Boolean(a?.json), quiet: Boolean(a?.json) || Boolean(a?.quiet) })),
  displayPath: (p: string) => p,
  logger: {
    info: vi.fn(),
    success: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}))

vi.mock('ofetch', () => {
  const fn = (...args: unknown[]) => mocks.ofetch(...args)
  ;(fn as any).raw = (...args: unknown[]) => mocks.ofetchRaw(...args)
  return { ofetch: fn }
})

vi.mock('node:fs/promises', () => ({
  default: {
    stat: (...args: unknown[]) => mocks.fsStat(...args),
    writeFile: (...args: unknown[]) => mocks.fsWriteFile(...args),
    rm: (...args: unknown[]) => mocks.fsRm(...args),
  },
  stat: (...args: unknown[]) => mocks.fsStat(...args),
  writeFile: (...args: unknown[]) => mocks.fsWriteFile(...args),
  rm: (...args: unknown[]) => mocks.fsRm(...args),
}))

vi.mock('gscdump/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('gscdump/client')>()
  return {
    ...actual,
    googleSearchConsole: mocks.googleSearchConsole,
  }
})

describe('doctor command', () => {
  let consoleOutput: string[] = []
  const originalLog = console.log
  let exitSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    consoleOutput = []
    console.log = (...args: unknown[]) => {
      consoleOutput.push(args.map(String).join(' '))
    }
    vi.clearAllMocks()
    exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined as never) as never)

    // Default: no env, no auth, dataDir missing, APIs reachable.
    mocks.parseEnvFile.mockReturnValue(null)
    mocks.resolveBYOK.mockReturnValue(null)
    mocks.loadTokens.mockResolvedValue(null)
    mocks.resolveAuth.mockResolvedValue(null)
    mocks.fsStat.mockResolvedValue(null)
    mocks.ofetchRaw.mockResolvedValue({
      headers: { get: () => new Date().toUTCString() },
    })
    mocks.ofetch.mockResolvedValue({
      scope: 'https://www.googleapis.com/auth/webmasters https://www.googleapis.com/auth/indexing https://www.googleapis.com/auth/siteverification',
      email: 'user@example.com',
    })
  })

  afterEach(() => {
    console.log = originalLog
    exitSpy.mockRestore()
  })

  it('has correct metadata', () => {
    expect(doctorCommand.meta?.name).toBe('doctor')
    expect(doctorCommand.meta?.description).toContain('checks')
  })

  it('exposes --json flag', () => {
    expect(doctorCommand.args?.json).toBeDefined()
    expect(doctorCommand.args?.json?.type).toBe('boolean')
  })

  it('emits JSON shape with checks array', async () => {
    await doctorCommand.run!({ args: { json: true }, rawArgs: [], cmd: doctorCommand } as any)

    const jsonLine = consoleOutput.find(l => l.startsWith('{'))
    expect(jsonLine).toBeDefined()
    const parsed = JSON.parse(jsonLine!)
    expect(parsed).toHaveProperty('checks')
    expect(Array.isArray(parsed.checks)).toBe(true)
    expect(parsed).toHaveProperty('ok')
  })

  it('reports auth fail when no BYOK and no saved tokens', async () => {
    await doctorCommand.run!({ args: { json: true }, rawArgs: [], cmd: doctorCommand } as any)

    const jsonLine = consoleOutput.find(l => l.startsWith('{'))
    const parsed = JSON.parse(jsonLine!)
    const auth = parsed.checks.find((c: any) => c.name === 'auth')
    expect(auth.status).toBe('fail')
    expect(auth.detail).toContain('init')
    expect(parsed.ok).toBe(false)
  })

  it('reports auth pass when BYOK access-token works', async () => {
    mocks.resolveBYOK.mockReturnValue('byok-token')

    await doctorCommand.run!({ args: { json: true }, rawArgs: [], cmd: doctorCommand } as any)

    const jsonLine = consoleOutput.find(l => l.startsWith('{'))
    const parsed = JSON.parse(jsonLine!)
    const auth = parsed.checks.find((c: any) => c.name === 'auth')
    expect(auth.status).toBe('pass')
    expect(auth.detail).toContain('BYOK')
  })

  it('accepts bare Google scope suffixes from tokeninfo', async () => {
    mocks.resolveBYOK.mockReturnValue('byok-token')
    mocks.ofetch.mockResolvedValue({
      scope: 'webmasters indexing siteverification',
      email: 'user@example.com',
    })

    await doctorCommand.run!({ args: { json: true }, rawArgs: [], cmd: doctorCommand } as any)

    const jsonLine = consoleOutput.find(l => l.startsWith('{'))
    const parsed = JSON.parse(jsonLine!)
    const scopes = parsed.checks.find((c: any) => c.name === 'auth.scopes')
    expect(scopes.status).toBe('pass')
  })
})

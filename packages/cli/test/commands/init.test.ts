import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { initCommand } from '../../src/commands/init'

const mocks = vi.hoisted(() => ({
  loadConfig: vi.fn(),
  saveConfig: vi.fn(),
  defaultDataDir: vi.fn(() => '/tmp/gscdump-test'),
  resolveBYOK: vi.fn(() => null),
  authenticate: vi.fn(),
  saveTokens: vi.fn(),
  loadTokens: vi.fn(() => Promise.resolve(null)),
  getAuthCredentials: vi.fn(),
  readFile: vi.fn(() => Promise.reject(new Error('ENOENT'))),
  googleSearchConsole: vi.fn(() => ({
    sites: vi.fn().mockResolvedValue([{ siteUrl: 'https://example.com/', permissionLevel: 'siteOwner' }]),
  })),
}))

vi.mock('../../src/config', () => ({
  loadConfig: mocks.loadConfig,
  saveConfig: mocks.saveConfig,
  defaultDataDir: mocks.defaultDataDir,
}))

vi.mock('../../src/auth', () => ({
  resolveBYOK: mocks.resolveBYOK,
  authenticate: mocks.authenticate,
  saveTokens: mocks.saveTokens,
  loadTokens: mocks.loadTokens,
  getAuthCredentials: mocks.getAuthCredentials,
}))

vi.mock('../../src/utils', () => ({
  setQuiet: vi.fn(),
  displayPath: (p: string) => p,
  logger: {
    info: vi.fn(),
    success: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    start: vi.fn(),
  },
}))

vi.mock('node:fs/promises', () => ({
  default: {
    readFile: (...args: unknown[]) => mocks.readFile(...args),
    writeFile: vi.fn().mockResolvedValue(undefined),
    stat: vi.fn().mockRejectedValue(new Error('ENOENT')),
  },
  readFile: (...args: unknown[]) => mocks.readFile(...args),
  writeFile: vi.fn().mockResolvedValue(undefined),
  stat: vi.fn().mockRejectedValue(new Error('ENOENT')),
}))

vi.mock('gscdump', async (importOriginal) => {
  const actual = await importOriginal<typeof import('gscdump')>()
  return {
    ...actual,
    googleSearchConsole: mocks.googleSearchConsole,
  }
})

describe('init command', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.loadConfig.mockResolvedValue({})
    mocks.readFile.mockRejectedValue(new Error('ENOENT'))
  })

  afterEach(() => {
    vi.resetModules()
  })

  it('has correct metadata', () => {
    expect(initCommand.meta?.name).toBe('init')
    expect(initCommand.meta?.description).toContain('authentication')
  })

  it('exposes --force, --no-store, --quiet flags', () => {
    expect(initCommand.args?.force).toBeDefined()
    expect(initCommand.args?.['no-store']).toBeDefined()
    expect(initCommand.args?.quiet).toBeDefined()
  })

  it('skips re-init when already configured without --force', async () => {
    mocks.loadConfig.mockResolvedValue({ clientId: 'x', clientSecret: 'y' })

    await initCommand.run!({ args: { quiet: true }, rawArgs: [], cmd: initCommand } as any)

    expect(mocks.saveConfig).not.toHaveBeenCalled()
    expect(mocks.authenticate).not.toHaveBeenCalled()
  })

  it('takes BYOK fast-path when access token env is set', async () => {
    mocks.resolveBYOK.mockReturnValue('byok-access-token')
    mocks.loadConfig.mockResolvedValue({})

    await initCommand.run!({
      args: { 'quiet': true, 'no-store': true },
      rawArgs: [],
      cmd: initCommand,
    } as any)

    expect(mocks.saveConfig).toHaveBeenCalled()
    expect(mocks.authenticate).not.toHaveBeenCalled()
    expect(mocks.getAuthCredentials).not.toHaveBeenCalled()
  })

  it('takes BYOK fast-path with refresh-token shape', async () => {
    mocks.resolveBYOK.mockReturnValue({ getAccessToken: vi.fn() })
    mocks.loadConfig.mockResolvedValue({})

    await initCommand.run!({
      args: { 'quiet': true, 'no-store': true },
      rawArgs: [],
      cmd: initCommand,
    } as any)

    expect(mocks.authenticate).not.toHaveBeenCalled()
  })
})

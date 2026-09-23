import { runCommand } from 'citty'
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
  text: vi.fn(async () => '/custom/store'),
  readFile: vi.fn(() => Promise.reject(new Error('ENOENT'))),
  googleSearchConsole: vi.fn(() => ({
    sites: vi.fn().mockResolvedValue([{ siteUrl: 'https://example.com/', permissionLevel: 'siteOwner' }]),
  })),
}))

vi.mock('@clack/prompts', async importOriginal => ({
  ...await importOriginal<typeof import('@clack/prompts')>(),
  text: mocks.text,
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
  OUTPUT_ARGS: { json: { type: 'boolean', default: false, description: 'Output as JSON' }, quiet: { type: 'boolean', alias: 'q', default: false, description: 'Suppress info/success output' } },
  applyOutputMode: vi.fn((a: any) => ({ json: Boolean(a?.json), quiet: Boolean(a?.json) || Boolean(a?.quiet) })),
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

vi.mock('gscdump/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('gscdump/client')>()
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

  it('skips re-init when already configured without --force', async () => {
    mocks.loadConfig.mockResolvedValue({ clientId: 'x', clientSecret: 'y' })

    await initCommand.run!({ args: { quiet: true }, rawArgs: [], cmd: initCommand } as any)

    expect(mocks.saveConfig).not.toHaveBeenCalled()
    expect(mocks.authenticate).not.toHaveBeenCalled()
  })

  it('takes the BYOK fast path and asks where to keep the Store', async () => {
    mocks.resolveBYOK.mockReturnValue('byok-access-token')

    await runCommand(initCommand, { rawArgs: ['--quiet'] })

    expect(mocks.text).toHaveBeenCalledOnce()
    expect(mocks.saveConfig).toHaveBeenCalledWith(expect.objectContaining({ dataDir: '/custom/store' }))
    expect(mocks.authenticate).not.toHaveBeenCalled()
    expect(mocks.getAuthCredentials).not.toHaveBeenCalled()
  })

  it('skips the Store prompt with --no-store', async () => {
    mocks.resolveBYOK.mockReturnValue({ getAccessToken: vi.fn() })

    await runCommand(initCommand, { rawArgs: ['--no-store', '--quiet'] })

    expect(mocks.text).not.toHaveBeenCalled()
    expect(mocks.saveConfig).toHaveBeenCalledWith(expect.objectContaining({ dataDir: undefined }))
    expect(mocks.authenticate).not.toHaveBeenCalled()
  })
})

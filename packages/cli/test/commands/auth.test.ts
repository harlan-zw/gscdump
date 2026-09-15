import process from 'node:process'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { authCommand } from '../../src/commands/auth'

import { logger } from '../../src/utils'
import { mockCredentials, mockExpiredCredentials } from '../__fixtures__/mocks'

vi.mock('../../src/auth-state', async importOriginal => ({
  ...await importOriginal<typeof import('../../src/auth-state')>(),
  resolveAuthentication: async () => ({ _tag: 'Local' }),
  clearAuthentication: vi.fn(),
}))
vi.mock('../../src/bing-auth', () => ({ clearBingCredentials: vi.fn(), inspectBingCredentials: async () => ({ _tag: 'Missing' }) }))

// Mock the logger
vi.mock('../../src/utils', () => ({
  OUTPUT_ARGS: { json: { type: 'boolean', default: false, description: 'Output as JSON' }, quiet: { type: 'boolean', alias: 'q', default: false, description: 'Suppress info/success output' } },
  applyOutputMode: vi.fn((a: any) => ({ json: Boolean(a?.json), quiet: Boolean(a?.json) || Boolean(a?.quiet) })),
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

// Mock config
vi.mock('../../src/config', () => ({
  loadConfig: vi.fn().mockResolvedValue({ mode: 'local' }),
}))

// Mock auth
const mocks = vi.hoisted(() => ({
  ofetch: vi.fn(),
  loadTokens: vi.fn(),
  clearTokens: vi.fn(),
  loadCloudTokens: vi.fn(),
  clearCloudTokens: vi.fn(),
  resolveBYOK: vi.fn(() => null),
  getAuth: vi.fn(),
  resolveAuth: vi.fn(),
}))

vi.mock('ofetch', () => ({ ofetch: mocks.ofetch }))

vi.mock('../../src/auth', () => ({
  loadTokens: mocks.loadTokens,
  clearTokens: mocks.clearTokens,
  loadCloudTokens: mocks.loadCloudTokens,
  clearCloudTokens: mocks.clearCloudTokens,
  resolveBYOK: mocks.resolveBYOK,
  getAuth: mocks.getAuth,
  resolveAuth: mocks.resolveAuth,
}))

describe('auth command', () => {
  let consoleOutput: string[] = []
  const originalLog = console.log

  beforeEach(() => {
    consoleOutput = []
    console.log = (...args: any[]) => {
      consoleOutput.push(args.map(String).join(' '))
    }
    vi.clearAllMocks()
    mocks.ofetch.mockResolvedValue({
      email: 'test@example.com',
      scope: 'https://www.googleapis.com/auth/webmasters.readonly',
    })
    // Default loadTokens to return null
    mocks.loadTokens.mockResolvedValue(null)
  })

  afterEach(() => {
    console.log = originalLog
  })

  it('should have correct metadata', () => {
    expect(authCommand.meta?.name).toBe('auth')
    expect(authCommand.meta?.description).toBe('Manage authentication')
  })

  it('should have status, login, and logout subcommands', () => {
    expect(authCommand.subCommands?.status).toBeDefined()
    expect(authCommand.subCommands?.login).toBeDefined()
    expect(authCommand.subCommands?.logout).toBeDefined()
  })

  it('accepts saved platform read-only scopes without requesting re-consent', async () => {
    mocks.loadTokens.mockResolvedValue({ ...mockCredentials, provider: 'gscdump' })
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('unexpected exit')
    }) as never)
    try {
      const scopes = authCommand.subCommands!.scopes
      await scopes.run!({ args: { json: true }, rawArgs: [], cmd: scopes })
      expect(JSON.parse(consoleOutput.at(-1)!)).toEqual({
        scopes: ['https://www.googleapis.com/auth/webmasters.readonly'],
        missing: [],
      })
      const status = authCommand.subCommands!.status
      await status.run!({ args: {}, rawArgs: [], cmd: status })
      expect(consoleOutput.join('\n')).not.toContain('re-consent')
    }
    finally {
      exit.mockRestore()
    }
  })

  it('still rejects missing BYOK scopes when platform tokens are saved', async () => {
    mocks.loadTokens.mockResolvedValue({ ...mockCredentials, provider: 'gscdump' })
    mocks.resolveBYOK.mockReturnValue('byok-access' as never)
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('exit 1')
    }) as never)
    try {
      const scopes = authCommand.subCommands!.scopes
      await expect(scopes.run!({ args: { json: true }, rawArgs: [], cmd: scopes })).rejects.toThrow('exit 1')
      expect(JSON.parse(consoleOutput.at(-1)!).missing).toContain('https://www.googleapis.com/auth/webmasters')
    }
    finally {
      mocks.resolveBYOK.mockReturnValue(null)
      exit.mockRestore()
    }
  })

  describe('status subcommand', () => {
    it('should show not authenticated when no tokens exist', async () => {
      mocks.loadTokens.mockResolvedValue(null)

      await authCommand.subCommands!.status.run!({
        args: {},
        rawArgs: [],
        cmd: authCommand.subCommands!.status,
      })

      expect(logger.warn).toHaveBeenCalledWith('Not authenticated')
    })

    it('should show authenticated when tokens exist', async () => {
      mocks.loadTokens.mockResolvedValue(mockCredentials)

      await authCommand.subCommands!.status.run!({
        args: {},
        rawArgs: [],
        cmd: authCommand.subCommands!.status,
      })

      expect(logger.success).toHaveBeenCalledWith('Authenticated (saved tokens)')
    })

    it('should show token details', async () => {
      mocks.loadTokens.mockResolvedValue(mockCredentials)

      await authCommand.subCommands!.status.run!({
        args: {},
        rawArgs: [],
        cmd: authCommand.subCommands!.status,
      })

      // Should output token presence info
      const output = consoleOutput.join('\n')
      expect(output).toContain('Access token')
      expect(output).toContain('Refresh token')
      expect(output).toContain('test@example.com')
      expect(output).toContain('https://www.googleapis.com/auth/webmasters.readonly')
    })

    it('should show expired status for expired tokens', async () => {
      mocks.loadTokens.mockResolvedValue(mockExpiredCredentials)

      await authCommand.subCommands!.status.run!({
        args: {},
        rawArgs: [],
        cmd: authCommand.subCommands!.status,
      })

      const output = consoleOutput.join('\n')
      expect(output).toContain('expired')
    })

    it('should show valid status for valid tokens', async () => {
      mocks.loadTokens.mockResolvedValue(mockCredentials)

      await authCommand.subCommands!.status.run!({
        args: {},
        rawArgs: [],
        cmd: authCommand.subCommands!.status,
      })

      const output = consoleOutput.join('\n')
      expect(output).toContain('valid')
    })
  })

  describe('logout subcommand', () => {
    it('should clear tokens file', async () => {
      await authCommand.subCommands!.logout.run!({
        args: {},
        rawArgs: [],
        cmd: authCommand.subCommands!.logout,
      })

      expect(mocks.clearTokens).toHaveBeenCalled()
    })

    it('should not throw if no tokens exist', async () => {
      mocks.clearTokens.mockResolvedValue(undefined)

      await expect(
        authCommand.subCommands!.logout.run!({
          args: {},
          rawArgs: [],
          cmd: authCommand.subCommands!.logout,
        }),
      ).resolves.not.toThrow()
    })
  })
})

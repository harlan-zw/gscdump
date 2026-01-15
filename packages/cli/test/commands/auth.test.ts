import { beforeEach, describe, expect, it, vi } from 'vitest'
import { authCommand } from '../../src/commands/auth'

import { logger } from '../../src/utils'
import { mockCredentials, mockExpiredCredentials } from '../__fixtures__/mocks'

// Mock the logger
vi.mock('../../src/utils', () => ({
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
  loadTokens: vi.fn(),
  clearTokens: vi.fn(),
  loadCloudTokens: vi.fn(),
  clearCloudTokens: vi.fn(),
}))

vi.mock('../../src/auth', () => ({
  loadTokens: mocks.loadTokens,
  clearTokens: mocks.clearTokens,
  loadCloudTokens: mocks.loadCloudTokens,
  clearCloudTokens: mocks.clearCloudTokens,
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

  it('should have status and logout subcommands', () => {
    expect(authCommand.subCommands?.status).toBeDefined()
    expect(authCommand.subCommands?.logout).toBeDefined()
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

      expect(logger.success).toHaveBeenCalledWith('Authenticated')
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

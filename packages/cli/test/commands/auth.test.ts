import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { authCommand } from '../../src/commands/auth'

import { logger } from '../../src/utils'
import { mockCredentials, mockExpiredCredentials } from '../__fixtures__/mocks'

const CONFIG_DIR = path.join(os.homedir(), '.config', 'gscdump')
const TOKENS_FILE = path.join(CONFIG_DIR, 'tokens.json')

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

describe('auth command', () => {
  let originalTokens: string | null = null
  let consoleOutput: string[] = []
  const originalLog = console.log

  beforeEach(async () => {
    consoleOutput = []
    console.log = (...args: any[]) => {
      consoleOutput.push(args.map(String).join(' '))
    }
    // Backup existing tokens
    originalTokens = await fs.readFile(TOKENS_FILE, 'utf-8').catch(() => null)
    vi.clearAllMocks()
  })

  afterEach(async () => {
    console.log = originalLog
    // Restore original tokens
    if (originalTokens) {
      await fs.mkdir(CONFIG_DIR, { recursive: true })
      await fs.writeFile(TOKENS_FILE, originalTokens)
    }
    else {
      await fs.rm(TOKENS_FILE).catch(() => {})
    }
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
      await fs.rm(TOKENS_FILE).catch(() => {})

      await authCommand.subCommands!.status.run!({
        args: {},
        rawArgs: [],
        cmd: authCommand.subCommands!.status,
      })

      expect(logger.warn).toHaveBeenCalledWith('Not authenticated')
    })

    it('should show authenticated when tokens exist', async () => {
      await fs.mkdir(CONFIG_DIR, { recursive: true })
      await fs.writeFile(TOKENS_FILE, JSON.stringify(mockCredentials))

      await authCommand.subCommands!.status.run!({
        args: {},
        rawArgs: [],
        cmd: authCommand.subCommands!.status,
      })

      expect(logger.success).toHaveBeenCalledWith('Authenticated')
    })

    it('should show token details', async () => {
      await fs.mkdir(CONFIG_DIR, { recursive: true })
      await fs.writeFile(TOKENS_FILE, JSON.stringify(mockCredentials))

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
      await fs.mkdir(CONFIG_DIR, { recursive: true })
      await fs.writeFile(TOKENS_FILE, JSON.stringify(mockExpiredCredentials))

      await authCommand.subCommands!.status.run!({
        args: {},
        rawArgs: [],
        cmd: authCommand.subCommands!.status,
      })

      const output = consoleOutput.join('\n')
      expect(output).toContain('expired')
    })

    it('should show valid status for valid tokens', async () => {
      await fs.mkdir(CONFIG_DIR, { recursive: true })
      await fs.writeFile(TOKENS_FILE, JSON.stringify(mockCredentials))

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
      await fs.mkdir(CONFIG_DIR, { recursive: true })
      await fs.writeFile(TOKENS_FILE, JSON.stringify(mockCredentials))

      await authCommand.subCommands!.logout.run!({
        args: {},
        rawArgs: [],
        cmd: authCommand.subCommands!.logout,
      })

      const exists = await fs.access(TOKENS_FILE).then(() => true).catch(() => false)
      expect(exists).toBe(false)
    })

    it('should not throw if no tokens exist', async () => {
      await fs.rm(TOKENS_FILE).catch(() => {})

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

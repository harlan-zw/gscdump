import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { configCommand } from '../../src/commands/config'
import { logger } from '../../src/utils'

const CONFIG_DIR = path.join(os.homedir(), '.config', 'gscdump')
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json')

// Mock the logger
vi.mock('../../src/utils', () => ({
  OUTPUT_ARGS: { json: { type: 'boolean', default: false, description: 'Output as JSON' }, quiet: { type: 'boolean', alias: 'q', default: false, description: 'Suppress info/success output' } },
  applyOutputMode: vi.fn((a: any) => ({ json: Boolean(a?.json), quiet: Boolean(a?.json) || Boolean(a?.quiet) })),
  setQuiet: vi.fn(),
  setNoColor: vi.fn(),
  displayPath: (p: string) => p,
  logger: {
    info: vi.fn(),
    success: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    start: vi.fn(),
  },
}))

describe('config command', () => {
  let originalConfig: string | null = null
  let consoleOutput: string[] = []
  const originalLog = console.log

  beforeEach(async () => {
    consoleOutput = []
    console.log = (...args: any[]) => {
      consoleOutput.push(args.map(String).join(' '))
    }
    // Backup existing config
    originalConfig = await fs.readFile(CONFIG_FILE, 'utf-8').catch(() => null)
    vi.clearAllMocks()
  })

  afterEach(async () => {
    console.log = originalLog
    // Restore original config
    if (originalConfig) {
      await fs.mkdir(CONFIG_DIR, { recursive: true })
      await fs.writeFile(CONFIG_FILE, originalConfig)
    }
    else {
      await fs.rm(CONFIG_FILE).catch(() => {})
    }
  })

  it('should have correct metadata', () => {
    expect(configCommand.meta?.name).toBe('config')
    expect(configCommand.meta?.description).toBe('Manage configuration')
  })

  it('should have all subcommands', () => {
    expect(configCommand.subCommands?.show).toBeDefined()
    expect(configCommand.subCommands?.set).toBeDefined()
    expect(configCommand.subCommands?.unset).toBeDefined()
    expect(configCommand.subCommands?.path).toBeDefined()
  })

  describe('show subcommand', () => {
    it('should show config path', async () => {
      await configCommand.subCommands!.show.run!({
        args: {},
        rawArgs: [],
        cmd: configCommand.subCommands!.show,
      })

      expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('config.json'))
    })

    it('should warn when no config exists', async () => {
      await fs.rm(CONFIG_FILE).catch(() => {})

      await configCommand.subCommands!.show.run!({
        args: {},
        rawArgs: [],
        cmd: configCommand.subCommands!.show,
      })

      expect(logger.warn).toHaveBeenCalledWith('No config set')
    })

    it('should output config as JSON when config exists', async () => {
      const testConfig = { defaultPeriod: '30d', defaultSite: 'test.com' }
      await fs.mkdir(CONFIG_DIR, { recursive: true })
      await fs.writeFile(CONFIG_FILE, JSON.stringify(testConfig))

      await configCommand.subCommands!.show.run!({
        args: {},
        rawArgs: [],
        cmd: configCommand.subCommands!.show,
      })

      const jsonOutput = consoleOutput.find(line => line.includes('defaultPeriod'))
      expect(jsonOutput).toBeDefined()
    })
  })

  describe('set subcommand', () => {
    it('should set config value', async () => {
      await configCommand.subCommands!.set.run!({
        args: { key: 'defaultPeriod', value: '90d' },
        rawArgs: [],
        cmd: configCommand.subCommands!.set,
      })

      const config = JSON.parse(await fs.readFile(CONFIG_FILE, 'utf-8'))
      expect(config.defaultPeriod).toBe('90d')
      expect(logger.success).toHaveBeenCalledWith('Set defaultPeriod = 90d')
    })

    it('should update existing config value', async () => {
      await fs.mkdir(CONFIG_DIR, { recursive: true })
      await fs.writeFile(CONFIG_FILE, JSON.stringify({ defaultPeriod: '30d' }))

      await configCommand.subCommands!.set.run!({
        args: { key: 'defaultPeriod', value: '90d' },
        rawArgs: [],
        cmd: configCommand.subCommands!.set,
      })

      const config = JSON.parse(await fs.readFile(CONFIG_FILE, 'utf-8'))
      expect(config.defaultPeriod).toBe('90d')
    })

    it('should add new key to existing config', async () => {
      await fs.mkdir(CONFIG_DIR, { recursive: true })
      await fs.writeFile(CONFIG_FILE, JSON.stringify({ defaultPeriod: '30d' }))

      await configCommand.subCommands!.set.run!({
        args: { key: 'defaultSite', value: 'test.com' },
        rawArgs: [],
        cmd: configCommand.subCommands!.set,
      })

      const config = JSON.parse(await fs.readFile(CONFIG_FILE, 'utf-8'))
      expect(config.defaultPeriod).toBe('30d')
      expect(config.defaultSite).toBe('test.com')
    })

    it('should accept all valid keys', async () => {
      const validKeys = ['defaultSite', 'defaultPeriod', 'defaultFormat', 'defaultDb']

      for (const key of validKeys) {
        await configCommand.subCommands!.set.run!({
          args: { key, value: 'test' },
          rawArgs: [],
          cmd: configCommand.subCommands!.set,
        })
      }

      const config = JSON.parse(await fs.readFile(CONFIG_FILE, 'utf-8'))
      for (const key of validKeys) {
        expect(config[key]).toBe('test')
      }
    })
  })

  describe('unset subcommand', () => {
    it('should remove config key', async () => {
      await fs.mkdir(CONFIG_DIR, { recursive: true })
      await fs.writeFile(CONFIG_FILE, JSON.stringify({ defaultPeriod: '30d', defaultSite: 'test.com' }))

      await configCommand.subCommands!.unset.run!({
        args: { key: 'defaultPeriod' },
        rawArgs: [],
        cmd: configCommand.subCommands!.unset,
      })

      const config = JSON.parse(await fs.readFile(CONFIG_FILE, 'utf-8'))
      expect(config.defaultPeriod).toBeUndefined()
      expect(config.defaultSite).toBe('test.com')
      expect(logger.success).toHaveBeenCalledWith('Removed defaultPeriod')
    })

    it('should reject unknown keys', async () => {
      // unset is whitelist-validated like set, so an unknown key exits 1.
      await fs.mkdir(CONFIG_DIR, { recursive: true })
      await fs.writeFile(CONFIG_FILE, JSON.stringify({ defaultPeriod: '30d' }))

      await expect(
        configCommand.subCommands!.unset.run!({
          args: { key: 'nonExistent' },
          rawArgs: [],
          cmd: configCommand.subCommands!.unset,
        }),
      ).rejects.toThrow(/process.exit/)
    })
  })

  describe('path subcommand', () => {
    it('should output config file path', async () => {
      await configCommand.subCommands!.path.run!({
        args: {},
        rawArgs: [],
        cmd: configCommand.subCommands!.path,
      })

      expect(consoleOutput[0]).toContain('.config/gscdump/config.json')
    })
  })
})

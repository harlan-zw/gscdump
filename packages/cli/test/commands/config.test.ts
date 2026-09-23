import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { configCommand } from '../../src/commands/config'
import { setConfigDir } from '../../src/config'
import { createCommandContext } from '../../src/context'
import { logger } from '../../src/utils'

let CONFIG_DIR: string
let CONFIG_FILE: string

vi.mock('../../src/context', () => ({ createCommandContext: vi.fn() }))

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
  let consoleOutput: string[] = []
  const originalLog = console.log

  beforeEach(async () => {
    consoleOutput = []
    console.log = (...args: any[]) => {
      consoleOutput.push(args.map(String).join(' '))
    }
    CONFIG_DIR = await fs.mkdtemp(path.join(os.tmpdir(), 'gscdump-config-command-'))
    CONFIG_FILE = path.join(CONFIG_DIR, 'config.json')
    setConfigDir(CONFIG_DIR)
    vi.clearAllMocks()
  })

  afterEach(async () => {
    console.log = originalLog
    await fs.rm(CONFIG_DIR, { recursive: true, force: true })
  })

  describe('show subcommand', () => {
    it.each([false, true])('redacts the client secret with json=%s', async (json) => {
      const config = { clientId: 'public-client', clientSecret: 'secret-value-123456' }
      await fs.writeFile(CONFIG_FILE, JSON.stringify(config))

      await configCommand.subCommands!.show.run!({
        args: { json },
        rawArgs: [],
        cmd: configCommand.subCommands!.show,
      })

      expect(consoleOutput.join('\n')).toContain('***123456')
      expect(consoleOutput.join('\n')).not.toContain(config.clientSecret)
      expect(JSON.parse(await fs.readFile(CONFIG_FILE, 'utf-8'))).toEqual(config)
    })

    it('should show config path', async () => {
      await configCommand.subCommands!.show.run!({
        args: {},
        rawArgs: [],
        cmd: configCommand.subCommands!.show,
      })

      expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('config.json'))
    })

    it('should warn when no config exists', async () => {
      await fs.rm(CONFIG_FILE, { force: true })

      await configCommand.subCommands!.show.run!({
        args: {},
        rawArgs: [],
        cmd: configCommand.subCommands!.show,
      })

      expect(logger.warn).toHaveBeenCalledWith('No config set')
    })

    it('should output config as JSON when config exists', async () => {
      const testConfig = { dataDir: '30d', defaultSite: 'test.com' }
      await fs.mkdir(CONFIG_DIR, { recursive: true })
      await fs.writeFile(CONFIG_FILE, JSON.stringify(testConfig))

      await configCommand.subCommands!.show.run!({
        args: {},
        rawArgs: [],
        cmd: configCommand.subCommands!.show,
      })

      const jsonOutput = consoleOutput.find(line => line.includes('dataDir'))
      expect(jsonOutput).toBeDefined()
    })
  })

  describe('set subcommand', () => {
    it('should set config value', async () => {
      await configCommand.subCommands!.set.run!({
        args: { key: 'dataDir', value: '90d' },
        rawArgs: [],
        cmd: configCommand.subCommands!.set,
      })

      const config = JSON.parse(await fs.readFile(CONFIG_FILE, 'utf-8'))
      expect(config.dataDir).toBe('90d')
      expect(logger.success).toHaveBeenCalledWith('Set dataDir = 90d')
    })

    it('should update existing config value', async () => {
      await fs.mkdir(CONFIG_DIR, { recursive: true })
      await fs.writeFile(CONFIG_FILE, JSON.stringify({ dataDir: '30d' }))

      await configCommand.subCommands!.set.run!({
        args: { key: 'dataDir', value: '90d' },
        rawArgs: [],
        cmd: configCommand.subCommands!.set,
      })

      const config = JSON.parse(await fs.readFile(CONFIG_FILE, 'utf-8'))
      expect(config.dataDir).toBe('90d')
    })

    it('should add new key to existing config', async () => {
      await fs.mkdir(CONFIG_DIR, { recursive: true })
      await fs.writeFile(CONFIG_FILE, JSON.stringify({ dataDir: '30d' }))

      await configCommand.subCommands!.set.run!({
        args: { key: 'defaultSite', value: 'test.com' },
        rawArgs: [],
        cmd: configCommand.subCommands!.set,
      })

      const config = JSON.parse(await fs.readFile(CONFIG_FILE, 'utf-8'))
      expect(config.dataDir).toBe('30d')
      expect(config.defaultSite).toBe('test.com')
    })

    it('should accept all valid keys', async () => {
      const values = { defaultSite: 'test.com', dataDir: '30d', defaultFormat: 'csv' }

      for (const [key, value] of Object.entries(values)) {
        await configCommand.subCommands!.set.run!({
          args: { key, value },
          rawArgs: [],
          cmd: configCommand.subCommands!.set,
        })
      }

      const config = JSON.parse(await fs.readFile(CONFIG_FILE, 'utf-8'))
      for (const [key, value] of Object.entries(values)) {
        expect(config[key]).toBe(value)
      }
    })
  })

  describe('invalid config', () => {
    it.each([
      ['defaultLimit', '0'],
      ['defaultLimit', '-1'],
      ['defaultLimit', '1.5'],
      ['defaultLimit', ''],
      ['defaultFormat', 'xml'],
      ['defaultSearchType', 'typo'],
      ['defaultDataState', 'typo'],
    ])('rejects %s=%s without changing saved config', async (key, value) => {
      await fs.writeFile(CONFIG_FILE, JSON.stringify({ defaultLimit: 100 }))
      await expect(configCommand.subCommands!.set.run!({
        args: { key, value },
        rawArgs: [],
        cmd: configCommand.subCommands!.set,
      })).rejects.toThrow()
      expect(JSON.parse(await fs.readFile(CONFIG_FILE, 'utf-8'))).toEqual({ defaultLimit: 100 })
    })

    it('returns a failing exit status for failed JSON validation', async () => {
      const dataDir = path.join(CONFIG_DIR, 'file')
      await fs.writeFile(dataDir, '')
      await fs.writeFile(CONFIG_FILE, JSON.stringify({ dataDir }))
      await expect(configCommand.subCommands!.validate.run!({
        args: { json: true },
        rawArgs: [],
        cmd: configCommand.subCommands!.validate,
      })).rejects.toThrow(/process.exit/)
      expect(JSON.parse(consoleOutput.at(-1)!)).toMatchObject({ ok: false })
    })

    it('reports failed Site verification instead of claiming success', async () => {
      await fs.writeFile(CONFIG_FILE, JSON.stringify({
        dataDir: CONFIG_DIR,
        defaultSite: 'sc-domain:example.com',
        clientId: 'client',
        clientSecret: 'secret',
      }))
      vi.mocked(createCommandContext).mockRejectedValueOnce(new Error('Token expired'))
      await configCommand.subCommands!.validate.run!({
        args: { json: true },
        rawArgs: [],
        cmd: configCommand.subCommands!.validate,
      })
      expect(JSON.parse(consoleOutput.at(-1)!)).toMatchObject({
        issues: [expect.objectContaining({ key: 'defaultSite', level: 'warn', message: expect.stringContaining('Token expired') })],
      })
    })

    it('rejects a directory as a service account file', async () => {
      await fs.writeFile(CONFIG_FILE, JSON.stringify({ dataDir: CONFIG_DIR, serviceAccountPath: CONFIG_DIR }))
      await expect(configCommand.subCommands!.validate.run!({
        args: { json: true },
        rawArgs: [],
        cmd: configCommand.subCommands!.validate,
      })).rejects.toThrow(/process.exit/)
      expect(JSON.parse(consoleOutput.at(-1)!)).toMatchObject({
        ok: false,
        issues: [expect.objectContaining({ key: 'serviceAccountPath', level: 'fail' })],
      })
    })

    it('fails validation when the data directory cannot be inspected', async () => {
      const dataDir = path.join(CONFIG_DIR, 'loop')
      await fs.symlink('loop', dataDir)
      await fs.writeFile(CONFIG_FILE, JSON.stringify({ dataDir }))
      await expect(configCommand.subCommands!.validate.run!({
        args: { json: true },
        rawArgs: [],
        cmd: configCommand.subCommands!.validate,
      })).rejects.toThrow(/process.exit/)
      expect(JSON.parse(consoleOutput.at(-1)!)).toMatchObject({
        ok: false,
        issues: [expect.objectContaining({ key: 'dataDir', level: 'fail' })],
      })
    })

    it('preserves existing files when checking directory permissions', async () => {
      const probe = path.join(CONFIG_DIR, '.gscdump-config-probe')
      await fs.writeFile(probe, 'keep')
      await fs.writeFile(CONFIG_FILE, JSON.stringify({ dataDir: CONFIG_DIR }))
      await configCommand.subCommands!.validate.run!({
        args: { json: true },
        rawArgs: [],
        cmd: configCommand.subCommands!.validate,
      })
      expect(await fs.readFile(probe, 'utf-8')).toBe('keep')
    })
  })

  describe('unset subcommand', () => {
    it('should remove config key', async () => {
      await fs.mkdir(CONFIG_DIR, { recursive: true })
      await fs.writeFile(CONFIG_FILE, JSON.stringify({ dataDir: '30d', defaultSite: 'test.com' }))

      await configCommand.subCommands!.unset.run!({
        args: { key: 'dataDir' },
        rawArgs: [],
        cmd: configCommand.subCommands!.unset,
      })

      const config = JSON.parse(await fs.readFile(CONFIG_FILE, 'utf-8'))
      expect(config.dataDir).toBeUndefined()
      expect(config.defaultSite).toBe('test.com')
      expect(logger.success).toHaveBeenCalledWith('Removed dataDir')
    })

    it('should reject unknown keys', async () => {
      // unset is whitelist-validated like set, so an unknown key exits 1.
      await fs.mkdir(CONFIG_DIR, { recursive: true })
      await fs.writeFile(CONFIG_FILE, JSON.stringify({ dataDir: '30d' }))

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

      expect(consoleOutput[0]).toBe(CONFIG_FILE)
    })
  })
})

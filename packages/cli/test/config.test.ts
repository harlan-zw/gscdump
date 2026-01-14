import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { getConfigPath, loadConfig, saveConfig, setConfigDir } from '../src/config'

describe('config module', () => {
  let testDir: string
  let configFile: string

  beforeEach(async () => {
    testDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gscdump-config-test-'))
    configFile = path.join(testDir, 'config.json')
    setConfigDir(testDir)
  })

  afterEach(async () => {
    await fs.rm(testDir, { recursive: true }).catch(() => {})
  })

  describe('getConfigPath', () => {
    it('should return correct config path', () => {
      const configPath = getConfigPath()
      expect(configPath).toBe(configFile)
      expect(configPath).toContain('config.json')
    })
  })

  describe('loadConfig', () => {
    it('should return empty object when no config file exists', async () => {
      const config = await loadConfig()
      expect(config).toEqual({})
    })

    it('should load existing config from file', async () => {
      const testConfig = {
        defaultSite: 'sc-domain:example.com',
        defaultPeriod: '90d',
        defaultFormat: 'json',
        defaultDb: './test.db',
      }
      await fs.writeFile(configFile, JSON.stringify(testConfig))

      const config = await loadConfig()
      expect(config).toEqual(testConfig)
    })

    it('should return empty object for invalid JSON', async () => {
      await fs.writeFile(configFile, 'invalid json')

      const config = await loadConfig()
      expect(config).toEqual({})
    })
  })

  describe('saveConfig', () => {
    it('should save config to file', async () => {
      const testConfig = {
        defaultSite: 'sc-domain:test.com',
        defaultPeriod: '30d',
      }

      await saveConfig(testConfig)

      const saved = await fs.readFile(configFile, 'utf-8')
      expect(JSON.parse(saved)).toEqual(testConfig)
    })

    it('should create config directory if it does not exist', async () => {
      const nestedDir = path.join(testDir, 'nested', 'config')
      setConfigDir(nestedDir)

      await saveConfig({ defaultPeriod: '7d' })

      const stats = await fs.stat(nestedDir)
      expect(stats.isDirectory()).toBe(true)
    })

    it('should preserve formatted JSON', async () => {
      const testConfig = { defaultSite: 'sc-domain:example.com' }
      await saveConfig(testConfig)

      const saved = await fs.readFile(configFile, 'utf-8')
      expect(saved).toContain('\n') // Should be formatted
      expect(saved).toContain('  ') // Should have indentation
    })

    it('should overwrite existing config', async () => {
      await saveConfig({ defaultPeriod: '30d' })
      await saveConfig({ defaultPeriod: '90d', defaultSite: 'test.com' })

      const config = await loadConfig()
      expect(config).toEqual({ defaultPeriod: '90d', defaultSite: 'test.com' })
    })
  })

  describe('config values', () => {
    it('should handle all valid config keys', async () => {
      const fullConfig = {
        defaultSite: 'sc-domain:example.com',
        defaultPeriod: '180d',
        defaultFormat: 'csv' as const,
        defaultDb: '/path/to/db.sqlite',
      }

      await saveConfig(fullConfig)
      const loaded = await loadConfig()

      expect(loaded.defaultSite).toBe('sc-domain:example.com')
      expect(loaded.defaultPeriod).toBe('180d')
      expect(loaded.defaultFormat).toBe('csv')
      expect(loaded.defaultDb).toBe('/path/to/db.sqlite')
    })

    it('should handle partial config', async () => {
      await saveConfig({ defaultPeriod: '7d' })
      const loaded = await loadConfig()

      expect(loaded.defaultPeriod).toBe('7d')
      expect(loaded.defaultSite).toBeUndefined()
      expect(loaded.defaultFormat).toBeUndefined()
      expect(loaded.defaultDb).toBeUndefined()
    })
  })
})

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
    await fs.rm(testDir, { recursive: true, force: true })
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
        dataDir: '90d',
        defaultFormat: 'json',
      }
      await fs.writeFile(configFile, JSON.stringify(testConfig))

      const config = await loadConfig()
      expect(config).toEqual(testConfig)
    })

    it('reports invalid JSON without changing the file', async () => {
      await fs.writeFile(configFile, 'invalid json')
      await expect(loadConfig()).rejects.toThrow(/config.json/)
      expect(await fs.readFile(configFile, 'utf-8')).toBe('invalid json')
    })

    it.each([null, [], 1, { defaultLimit: -1 }, { defaultLimit: 1.5 }, { defaultLimit: '100' }, { defaultFormat: 'xml' }, { dataDir: 3 }, { defaultSearchType: 'typo' }, { defaultDataState: 'typo' }, { typo: true }])('rejects malformed saved config: %j', async (value) => {
      await fs.writeFile(configFile, JSON.stringify(value))
      await expect(loadConfig()).rejects.toThrow(/config.json/)
    })

    it('ignores keys written by earlier CLI versions', async () => {
      await fs.writeFile(configFile, JSON.stringify({ mode: 'local', cloudUrl: 'https://cloud.gscdump.com', defaultPeriod: '30d', defaultDb: './data.db', defaultSite: 'sc-domain:example.com' }))
      expect(await loadConfig()).toEqual({ defaultSite: 'sc-domain:example.com' })
    })

    it('propagates config read failures', async () => {
      await fs.mkdir(configFile)
      await expect(loadConfig()).rejects.toMatchObject({ code: 'EISDIR' })
    })
  })

  describe('saveConfig', () => {
    it('rejects invalid values before replacing saved config', async () => {
      await saveConfig({ defaultLimit: 100 })
      await expect(saveConfig({ defaultLimit: 0 })).rejects.toThrow(/defaultLimit/)
      expect(await loadConfig()).toEqual({ defaultLimit: 100 })
    })

    it('should save config to file', async () => {
      const testConfig = {
        defaultSite: 'sc-domain:test.com',
        dataDir: '30d',
      }

      await saveConfig(testConfig)

      const saved = await fs.readFile(configFile, 'utf-8')
      expect(JSON.parse(saved)).toEqual(testConfig)
    })

    it('should create config directory if it does not exist', async () => {
      const nestedDir = path.join(testDir, 'nested', 'config')
      setConfigDir(nestedDir)

      await saveConfig({ dataDir: '7d' })

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
      await saveConfig({ dataDir: '30d' })
      await saveConfig({ dataDir: '90d', defaultSite: 'test.com' })

      const config = await loadConfig()
      expect(config).toEqual({ dataDir: '90d', defaultSite: 'test.com' })
    })
  })

  describe('config values', () => {
    it('should handle all valid config keys', async () => {
      const fullConfig = {
        defaultSite: 'sc-domain:example.com',
        dataDir: '180d',
        defaultFormat: 'csv' as const,
      }

      await saveConfig(fullConfig)
      const loaded = await loadConfig()

      expect(loaded.defaultSite).toBe('sc-domain:example.com')
      expect(loaded.dataDir).toBe('180d')
      expect(loaded.defaultFormat).toBe('csv')
    })

    it('should handle partial config', async () => {
      await saveConfig({ dataDir: '7d' })
      const loaded = await loadConfig()

      expect(loaded.dataDir).toBe('7d')
      expect(loaded.defaultSite).toBeUndefined()
      expect(loaded.defaultFormat).toBeUndefined()
    })
  })
})

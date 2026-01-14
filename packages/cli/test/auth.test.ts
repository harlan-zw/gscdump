import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { clearTokens, loadTokens, saveTokens } from '../src/auth'
import { setConfigDir } from '../src/config'
import { mockCredentials, mockExpiredCredentials } from './__fixtures__/mocks'

describe('auth module', () => {
  let testDir: string
  let tokensFile: string

  beforeEach(async () => {
    testDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gscdump-auth-test-'))
    tokensFile = path.join(testDir, 'tokens.json')
    setConfigDir(testDir)
  })

  afterEach(async () => {
    await fs.rm(testDir, { recursive: true }).catch(() => {})
    vi.clearAllMocks()
  })

  describe('loadTokens', () => {
    it('should return null when no tokens file exists', async () => {
      const tokens = await loadTokens()
      expect(tokens).toBeNull()
    })

    it('should load existing tokens from file', async () => {
      const fixedCredentials = {
        access_token: 'test_access_token',
        refresh_token: 'test_refresh_token',
        token_type: 'Bearer',
        expiry_date: 1234567890000,
      }
      await fs.writeFile(tokensFile, JSON.stringify(fixedCredentials))

      const tokens = await loadTokens()
      expect(tokens).toEqual(fixedCredentials)
    })

    it('should return null for invalid JSON', async () => {
      await fs.writeFile(tokensFile, 'invalid json')

      const tokens = await loadTokens()
      expect(tokens).toBeNull()
    })
  })

  describe('saveTokens', () => {
    it('should save tokens to file', async () => {
      await saveTokens(mockCredentials)

      const saved = await fs.readFile(tokensFile, 'utf-8')
      expect(JSON.parse(saved)).toEqual(mockCredentials)
    })

    it('should create config directory if it does not exist', async () => {
      const nestedDir = path.join(testDir, 'nested', 'config')
      setConfigDir(nestedDir)

      await saveTokens(mockCredentials)

      const stats = await fs.stat(nestedDir)
      expect(stats.isDirectory()).toBe(true)
    })

    it('should set proper file permissions', async () => {
      await saveTokens(mockCredentials)

      const stats = await fs.stat(tokensFile)
      // 0o600 = owner read/write only
      expect(stats.mode & 0o777).toBe(0o600)
    })
  })

  describe('clearTokens', () => {
    it('should remove tokens file', async () => {
      await saveTokens(mockCredentials)
      await clearTokens()

      const exists = await fs.access(tokensFile).then(() => true).catch(() => false)
      expect(exists).toBe(false)
    })

    it('should not throw if tokens file does not exist', async () => {
      await expect(clearTokens()).resolves.not.toThrow()
    })
  })
})

describe('token expiry', () => {
  it('should identify expired tokens', () => {
    expect(mockExpiredCredentials.expiry_date).toBeLessThan(Date.now())
  })

  it('should identify valid tokens', () => {
    expect(mockCredentials.expiry_date).toBeGreaterThan(Date.now())
  })
})

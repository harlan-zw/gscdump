import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { encodeSiteId } from 'gscdump/tenant'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { defaultDataDir, resolveDataDir } from '../src/config'

describe('encodeSiteId', () => {
  it('maps sc-domain properties to a d_ prefix', () => {
    expect(encodeSiteId('sc-domain:example.com')).toBe('d_example.com')
  })

  it('maps https URLs to a h_ prefix and strips path separators', () => {
    expect(encodeSiteId('https://example.com/')).toBe('h_example.com')
  })

  it('scrubs anything outside [A-Za-z0-9_.-]', () => {
    expect(encodeSiteId('sc-domain:foo.bar/baz')).toBe('d_foo.bar_baz')
  })

  it('is deterministic for the same input', () => {
    const a = encodeSiteId('sc-domain:example.com')
    const b = encodeSiteId('sc-domain:example.com')
    expect(a).toBe(b)
  })
})

describe('data dir resolution', () => {
  let tmp: string

  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'gscdump-analytics-'))
  })

  afterEach(async () => {
    await fs.rm(tmp, { recursive: true }).catch(() => {})
  })

  it('falls back to the default dir when config.dataDir is absent', () => {
    expect(resolveDataDir({})).toBe(defaultDataDir())
  })

  it('honours an explicit absolute dataDir', () => {
    expect(resolveDataDir({ dataDir: tmp })).toBe(tmp)
  })

  it('expands ~ to the user home directory', () => {
    expect(resolveDataDir({ dataDir: '~/custom-data' })).toBe(path.join(os.homedir(), 'custom-data'))
  })
})

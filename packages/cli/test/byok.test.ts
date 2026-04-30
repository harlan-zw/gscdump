import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { resolveBYOK } from '../src/auth'

const ENV_KEYS = [
  'GSC_ACCESS_TOKEN',
  'GSC_CLIENT_ID',
  'GSC_CLIENT_SECRET',
  'GSC_REFRESH_TOKEN',
  'GOOGLE_ACCESS_TOKEN',
  'GOOGLE_CLIENT_ID',
  'GOOGLE_CLIENT_SECRET',
  'GOOGLE_REFRESH_TOKEN',
]

describe('resolveBYOK', () => {
  const saved: Record<string, string | undefined> = {}

  beforeEach(() => {
    for (const k of ENV_KEYS) {
      saved[k] = process.env[k]
      delete process.env[k]
    }
  })

  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined)
        delete process.env[k]
      else process.env[k] = saved[k]
    }
  })

  it('returns null when no BYOK env or args set', () => {
    expect(resolveBYOK()).toBeNull()
  })

  it('returns access token string when GSC_ACCESS_TOKEN is set', () => {
    process.env.GSC_ACCESS_TOKEN = 'tok-abc'
    expect(resolveBYOK()).toBe('tok-abc')
  })

  it('falls back to GOOGLE_ACCESS_TOKEN', () => {
    process.env.GOOGLE_ACCESS_TOKEN = 'tok-google'
    expect(resolveBYOK()).toBe('tok-google')
  })

  it('gSC_ACCESS_TOKEN takes precedence over GOOGLE_ACCESS_TOKEN', () => {
    process.env.GSC_ACCESS_TOKEN = 'tok-gsc'
    process.env.GOOGLE_ACCESS_TOKEN = 'tok-google'
    expect(resolveBYOK()).toBe('tok-gsc')
  })

  it('returns AuthClient when client id/secret/refresh-token all present', () => {
    process.env.GSC_CLIENT_ID = 'cid'
    process.env.GSC_CLIENT_SECRET = 'csec'
    process.env.GSC_REFRESH_TOKEN = 'rtok'
    const result = resolveBYOK()
    expect(result).not.toBeNull()
    expect(typeof result).toBe('object')
    expect(result).toHaveProperty('getAccessToken')
  })

  it('refresh-token flow takes precedence over access-token-only', () => {
    process.env.GSC_ACCESS_TOKEN = 'tok-only'
    process.env.GSC_CLIENT_ID = 'cid'
    process.env.GSC_CLIENT_SECRET = 'csec'
    process.env.GSC_REFRESH_TOKEN = 'rtok'
    const result = resolveBYOK()
    expect(typeof result).toBe('object')
  })

  it('explicit args override env vars', () => {
    process.env.GSC_ACCESS_TOKEN = 'env-tok'
    expect(resolveBYOK({ accessToken: 'arg-tok' })).toBe('arg-tok')
  })

  it('returns null if only client_id+secret without refresh_token', () => {
    process.env.GSC_CLIENT_ID = 'cid'
    process.env.GSC_CLIENT_SECRET = 'csec'
    expect(resolveBYOK()).toBeNull()
  })
})

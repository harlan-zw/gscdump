import type { AnalyticsEnv } from '../src/env'
import { describe, expect, it } from 'vitest'
import { createR2Presigner } from '../src/r2-presign'

const env: AnalyticsEnv = {
  R2_ACCESS_KEY_ID: 'AKIDEXAMPLE',
  R2_SECRET_ACCESS_KEY: 'secretkeyexample',
  CLOUDFLARE_ACCOUNT_ID: 'acct123',
}

describe('createR2Presigner', () => {
  it('throws when S3 credentials are missing', () => {
    expect(() => createR2Presigner({ ...env, R2_ACCESS_KEY_ID: undefined }))
      .toThrow(/R2 S3 credentials missing/)
    expect(() => createR2Presigner({ ...env, R2_SECRET_ACCESS_KEY: undefined }))
      .toThrow(/R2 S3 credentials missing/)
  })

  it('throws when the account id is missing', () => {
    expect(() => createR2Presigner({ ...env, CLOUDFLARE_ACCOUNT_ID: undefined }))
      .toThrow(/CLOUDFLARE_ACCOUNT_ID missing/)
  })

  it('produces a signed URL on the account R2 host with the SigV4 query params', async () => {
    const presign = createR2Presigner(env)
    const signed = await presign({ key: 'rollups/site-1/2026-01.parquet', bucket: 'data' })
    const url = new URL(signed)
    expect(url.host).toBe('acct123.r2.cloudflarestorage.com')
    expect(url.pathname).toBe('/data/rollups/site-1/2026-01.parquet')
    expect(url.searchParams.get('X-Amz-Signature')).toBeTruthy()
    expect(url.searchParams.get('X-Amz-Expires')).toBe('3600')
    expect(url.searchParams.get('X-Amz-Date')).toBeTruthy()
    expect(url.searchParams.get('X-Amz-Algorithm')).toBe('AWS4-HMAC-SHA256')
  })

  it('honours a custom expiresIn', async () => {
    const presign = createR2Presigner(env)
    const signed = await presign({ key: 'k', bucket: 'data', expiresIn: 120 })
    expect(new URL(signed).searchParams.get('X-Amz-Expires')).toBe('120')
  })

  it('encodes each key segment while preserving slashes between segments', async () => {
    const presign = createR2Presigner(env)
    const signed = await presign({ key: 'a b/c+d/e.parquet', bucket: 'data' })
    const url = new URL(signed)
    // slashes preserved as path separators, spaces/plus encoded per-segment
    expect(url.pathname).toBe('/data/a%20b/c%2Bd/e.parquet')
  })

  it('safely encodes injection chars (?, &, spaces) so they cannot forge query params', async () => {
    const presign = createR2Presigner(env)
    const signed = await presign({ key: 'evil?X-Amz-Signature=forged&x= y', bucket: 'data' })
    const url = new URL(signed)
    // the literal key bytes live in the path, not the query
    expect(url.pathname).toContain('evil%3FX-Amz-Signature%3Dforged%26x%3D%20y')
    // the real signature is the only X-Amz-Signature param and is server-computed
    expect(url.searchParams.getAll('X-Amz-Signature')).toHaveLength(1)
    expect(url.searchParams.get('X-Amz-Signature')).not.toBe('forged')
  })

  describe('expiresIn validation', () => {
    it('rejects zero', async () => {
      const presign = createR2Presigner(env)
      await expect(presign({ key: 'k', bucket: 'data', expiresIn: 0 })).rejects.toThrow(/positive integer/)
    })

    it('rejects negative values', async () => {
      const presign = createR2Presigner(env)
      await expect(presign({ key: 'k', bucket: 'data', expiresIn: -1 })).rejects.toThrow(/positive integer/)
    })

    it('rejects non-integer values', async () => {
      const presign = createR2Presigner(env)
      await expect(presign({ key: 'k', bucket: 'data', expiresIn: 1.5 })).rejects.toThrow(/positive integer/)
    })

    it('rejects values over the 7-day S3 maximum', async () => {
      const presign = createR2Presigner(env)
      await expect(presign({ key: 'k', bucket: 'data', expiresIn: 604801 })).rejects.toThrow(/maximum/)
    })

    it('accepts exactly the 7-day maximum', async () => {
      const presign = createR2Presigner(env)
      const signed = await presign({ key: 'k', bucket: 'data', expiresIn: 604800 })
      expect(new URL(signed).searchParams.get('X-Amz-Expires')).toBe('604800')
    })
  })
})

import { afterEach, describe, expect, it, vi } from 'vitest'
import { batchRequestIndexing, exchangeAuthCodeResult, googleSearchConsole, introspectAccessTokenResult, refreshAccessToken, requestIndexing, runSequentialBatch } from '../../src'

afterEach(() => vi.unstubAllGlobals())

describe('direct API input and response boundaries', () => {
  it.each(['URL_UPDATED', 'URL_DELETED'] as const)('returns the notification time for %s', async (type) => {
    const fetch = vi.fn().mockResolvedValue({
      urlNotificationMetadata: {
        latestUpdate: { notifyTime: '2026-01-01T00:00:00Z' },
        latestRemove: { notifyTime: '2026-09-09T00:00:00Z' },
      },
    })
    const client = googleSearchConsole('token', { fetch: fetch as never })
    const result = await requestIndexing(client, 'https://example.com/', { type })
    expect(result.notifyTime).toBe(type === 'URL_DELETED' ? '2026-09-09T00:00:00Z' : '2026-01-01T00:00:00Z')
  })

  it.each([Number.NaN, Infinity, -Infinity, 0, -1, 1.5])('rejects invalid batch concurrency %s before requests', async (concurrency) => {
    const fetch = vi.fn().mockResolvedValue({ urlNotificationMetadata: {} })
    const client = googleSearchConsole('token', { fetch: fetch as never })
    await expect(batchRequestIndexing(client, ['https://example.com/'], { concurrency, delayMs: 0 }))
      .rejects
      .toThrow('concurrency must be a positive integer.')
    expect(fetch).not.toHaveBeenCalled()
  })

  it.each([Number.NaN, Infinity, -1])('rejects invalid batch delay %s before operations', async (delayMs) => {
    const operation = vi.fn(async (value: number) => value)
    await expect(runSequentialBatch([1], operation, { delayMs })).rejects.toThrow('delayMs must be a finite, nonnegative number.')
    expect(operation).not.toHaveBeenCalled()
  })

  it('preserves input order with concurrent batch workers', async () => {
    const result = await runSequentialBatch([3, 1, 2], async value => value * 2, { concurrency: 2 })
    expect(result).toEqual([6, 2, 4])
  })

  it.each([
    null,
    [],
    'token',
    {},
    { access_token: '', expires_in: 3600 },
    { access_token: 'token', expires_in: '3600' },
    { access_token: 'token', expires_in: -1 },
    { access_token: 'token', expires_in: 3600, refresh_token: 42 },
    { access_token: 'token', expires_in: 3600, scope: [] },
  ].map(payload => ({ payload })))('classifies malformed OAuth token payload %j', async ({ payload }) => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(payload), { status: 200 })))
    await expect(exchangeAuthCodeResult('code', 'client', 'secret', 'https://example.com/callback'))
      .resolves
      .toMatchObject({ ok: false, error: { kind: 'transport', status: 200 } })
    await expect(refreshAccessToken('refresh', 'client', 'secret')).rejects.toThrow(/OAuth/)
  })

  it.each([null, [], 'token'].map(payload => ({ payload })))('classifies non-object introspection payload %j', async ({ payload }) => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(payload), { status: 200 })))
    await expect(introspectAccessTokenResult('token')).resolves.toMatchObject({ ok: false, error: { kind: 'transport', status: 200 } })
  })
})

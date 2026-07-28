import { describe, expect, it, vi } from 'vitest'
import { createR2SqlTransport } from '../src/server-tail/r2-sql-transport'

describe('createR2SqlTransport', () => {
  it('normalizes rows and metrics from the Cloudflare envelope', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      success: true,
      result: {
        columns: ['url', 'score'],
        data: [['https://example.com', 100]],
        metrics: { bytes_scanned: 42 },
      },
    })))
    const transport = createR2SqlTransport({
      accountId: 'account',
      bucket: 'bucket',
      token: 'token',
      fetchImpl,
      now: vi.fn()
        .mockReturnValueOnce(10)
        .mockReturnValueOnce(25),
    })
    await expect(transport.query('SELECT 1')).resolves.toEqual({
      _tag: 'ok',
      rows: [{ url: 'https://example.com', score: 100 }],
      metrics: { bytes_scanned: 42 },
      sql: 'SELECT 1',
      queryMs: 15,
    })
  })

  it('retains HTTP details and retry timing for caller-owned retry policy', async () => {
    const fetchImpl = vi.fn(async () => new Response('[80014] Account rate limit exceeded', {
      status: 429,
      headers: { 'retry-after': '2' },
    }))
    const result = await createR2SqlTransport({
      accountId: 'account',
      bucket: 'bucket',
      token: 'token',
      fetchImpl,
    }).query('SELECT 1')
    expect(result).toMatchObject({
      _tag: 'error',
      kind: 'http',
      status: 429,
      retryAfterMs: 2000,
      body: '[80014] Account rate limit exceeded',
    })
  })
})

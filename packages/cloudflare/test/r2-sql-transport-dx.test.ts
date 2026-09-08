import { afterEach, describe, expect, it, vi } from 'vitest'
import { createR2SqlClient, createR2SqlTransport, R2SqlTimeoutError } from '../src/server-tail'

const config = { accountId: 'account', bucket: 'bucket', token: 'token' }

afterEach(() => vi.useRealTimers())

describe('r2 SQL response failures', () => {
  it.each([
    { success: true },
    { success: true, result: {} },
    { success: 'true', result: { rows: [] } },
    { success: true, result: { rows: [null] } },
    { success: true, result: { columns: ['x'], data: [null] } },
    { success: true, result: { columns: [1], data: [[1]] } },
    { success: true, result: { columns: ['x', 'y'], data: [[1]] } },
    { success: true, result: { columns: ['x'], data: [[1, 2]] } },
    { success: false, errors: { message: 'expired token' } },
    { success: false, errors: [null] },
  ])('returns an actionable error for malformed envelope %j', async (body) => {
    const transport = createR2SqlTransport({ ...config, fetchImpl: async () => Response.json(body) })
    await expect(transport.query('SELECT 1')).resolves.toMatchObject({
      _tag: 'error',
      kind: 'invalid_response',
      status: 200,
    })
  })

  it('accepts an explicitly empty result', async () => {
    const transport = createR2SqlTransport({
      ...config,
      fetchImpl: async () => Response.json({ success: true, result: { rows: [] } }),
    })
    await expect(transport.query('SELECT 1')).resolves.toMatchObject({ _tag: 'ok', rows: [] })
  })

  it.each([200, 503])('preserves timeout errors while reading an HTTP %i body', async (status) => {
    vi.useFakeTimers()
    const fetchImpl: typeof fetch = async (_url, init) => new Response(new ReadableStream({
      start(controller) {
        init!.signal!.addEventListener('abort', () => controller.error(init!.signal!.reason), { once: true })
      },
    }), { status })
    const client = createR2SqlClient({ ...config, namespace: 'gsc', fetchImpl, timeoutMs: 100 })
    const result = client.queryResult!('SELECT 1')
    await vi.advanceTimersByTimeAsync(100)
    await expect(result).resolves.toEqual({ ok: false, error: expect.any(R2SqlTimeoutError) })
  })
})

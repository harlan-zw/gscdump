import { createGscdumpV1Client } from '@gscdump/sdk/v1/http'
import { describe, expect, it, vi } from 'vitest'

function analyticsResponse(): Response {
  return Response.json({
    data: { rows: [{ clicks: 3 }] },
    meta: {
      requestId: 'req_read',
      surface: 'analytics',
      version: '1.0',
      sourceName: 'primary',
      sourceKind: 'sql',
      queryMs: 1,
    },
  })
}

const input = {
  params: { siteId: 's_test' },
  body: { dimensions: ['query'], metrics: ['clicks'], rowLimit: 10 },
}

describe('v1 concurrent reads', () => {
  it('shares one pending analytics POST and fetches again after completion', async () => {
    const response = Promise.withResolvers<void>()
    const fetch = vi.fn<typeof globalThis.fetch>(async () => {
      await response.promise
      return analyticsResponse()
    })
    const client = createGscdumpV1Client({ credential: 'test_secret', fetch })

    const reads = Promise.all([
      client.queryAnalyticsRows(input),
      client.queryAnalyticsRows({ ...input, body: { rowLimit: 10, metrics: ['clicks'], dimensions: ['query'] } }),
    ])
    await vi.waitFor(() => expect(fetch).toHaveBeenCalled())
    response.resolve()

    expect((await reads).map(result => result.data.rows)).toEqual([[{ clicks: 3 }], [{ clicks: 3 }]])
    expect(fetch).toHaveBeenCalledTimes(1)

    fetch.mockResolvedValueOnce(analyticsResponse())
    expect((await client.queryAnalyticsRows(input)).data.rows).toEqual([{ clicks: 3 }])
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('keeps requests with different resolved credentials separate', async () => {
    let credential = 0
    const fetch = vi.fn<typeof globalThis.fetch>(async () => analyticsResponse())
    const client = createGscdumpV1Client({ credential: () => `secret_${credential++}`, fetch })

    const results = await Promise.all([client.queryAnalyticsRows(input), client.queryAnalyticsRows(input)])

    expect(results.map(result => result.data.rows)).toEqual([[{ clicks: 3 }], [{ clicks: 3 }]])
    expect(fetch.mock.calls.map(([, init]) => new Headers(init?.headers).get('authorization')))
      .toEqual(['Bearer secret_0', 'Bearer secret_1'])
  })

  it('keeps abortable requests independent', async () => {
    const controller = new AbortController()
    const fetch = vi.fn<typeof globalThis.fetch>(async () => analyticsResponse())
    const client = createGscdumpV1Client({ credential: 'test_secret', fetch })

    const results = await Promise.all([
      client.queryAnalyticsRows(input, { signal: controller.signal }),
      client.queryAnalyticsRows(input),
    ])

    expect(results.map(result => result.data.rows)).toEqual([[{ clicks: 3 }], [{ clicks: 3 }]])
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it.each([
    { name: 'Site', second: { ...input, params: { siteId: 's_other' } }, options: {} },
    { name: 'query body', second: { ...input, body: { ...input.body, rowLimit: 20 } }, options: {} },
    { name: 'request ID', second: input, options: { requestId: 'req_other' } },
  ])('keeps reads with a different $name separate', async ({ second, options }) => {
    const response = Promise.withResolvers<void>()
    const fetch = vi.fn<typeof globalThis.fetch>(async () => {
      await response.promise
      return analyticsResponse()
    })
    const client = createGscdumpV1Client({ credential: 'test_secret', fetch })

    const reads = Promise.all([client.queryAnalyticsRows(input), client.queryAnalyticsRows(second, options)])
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2))
    response.resolve()

    expect((await reads).map(result => result.data.rows)).toEqual([[{ clicks: 3 }], [{ clicks: 3 }]])
  })

  it('allows callers to disable sharing', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => analyticsResponse())
    const client = createGscdumpV1Client({ credential: 'test_secret', fetch, dedupe: false })

    const results = await Promise.all([client.queryAnalyticsRows(input), client.queryAnalyticsRows(input)])

    expect(results.map(result => result.data.rows)).toEqual([[{ clicks: 3 }], [{ clicks: 3 }]])
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('executes identical mutations separately', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => Response.json({
      error: {
        code: 'realtime_unavailable',
        message: 'Temporarily unavailable',
        requestId: 'req_ticket',
        retryable: true,
        details: {},
      },
    }, { status: 503 }))
    const client = createGscdumpV1Client({ credential: 'test_secret', fetch })

    const results = await Promise.allSettled([
      client.createRealtimeTicket({ body: {} }),
      client.createRealtimeTicket({ body: {} }),
    ])

    expect(results.map(result => result.status)).toEqual(['rejected', 'rejected'])
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('retries a failed shared read on the next call', async () => {
    const response = Promise.withResolvers<Response>()
    const fetch = vi.fn<typeof globalThis.fetch>(() => response.promise)
    const client = createGscdumpV1Client({ credential: 'test_secret', fetch, retry: { maxAttempts: 1 } })

    const reads = Promise.allSettled([client.queryAnalyticsRows(input), client.queryAnalyticsRows(input)])
    await vi.waitFor(() => expect(fetch).toHaveBeenCalled())
    response.reject(new Error('network unavailable'))

    expect((await reads).map(result => result.status)).toEqual(['rejected', 'rejected'])
    expect(fetch).toHaveBeenCalledTimes(1)

    fetch.mockResolvedValueOnce(analyticsResponse())
    expect((await client.queryAnalyticsRows(input)).data.rows).toEqual([{ clicks: 3 }])
    expect(fetch).toHaveBeenCalledTimes(2)
  })
})

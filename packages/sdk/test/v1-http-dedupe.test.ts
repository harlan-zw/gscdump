import type { GscdumpV1OperationInput } from '@gscdump/sdk/v1/http'
import { createGscdumpV1Client } from '@gscdump/sdk/v1/http'
import { describe, expect, it, vi } from 'vitest'

function analyticsResponse(clicks = 3): Response {
  return Response.json({
    data: { rows: [{ clicks }] },
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

const input: GscdumpV1OperationInput<'analytics.rows.query'> = {
  params: { siteId: 's_test' },
  body: { dimensions: ['query'], metrics: ['clicks'], rowLimit: 10 },
}

describe('v1 concurrent reads', () => {
  it.each([
    { context: 'credential', failure: 'network' },
    { context: 'credential', failure: 'HTTP' },
    { context: 'header', failure: 'network' },
    { context: 'header', failure: 'HTTP' },
  ].flatMap(scenario => ['analytics', 'partner', 'realtime'].map(surface => ({ ...scenario, surface }))))('binds $surface joiners to their $context across a $failure retry', async ({ context, failure, surface }) => {
    let principal = 'A'
    const credential = vi.fn(() => context === 'credential' ? principal : 'fixture')
    const firstResponse = Promise.withResolvers<Response>()
    const retryResponse = Promise.withResolvers<void>()
    const fetch = vi.fn<typeof globalThis.fetch>(async (_url, init) => {
      const headers = new Headers(init?.headers)
      const requestPrincipal = context === 'credential'
        ? headers.get('authorization')?.slice('Bearer '.length)
        : headers.get('x-principal')
      if (fetch.mock.calls.length === 1)
        return firstResponse.promise
      await retryResponse.promise
      if (surface === 'analytics')
        return analyticsResponse(requestPrincipal === 'A' ? 3 : 9)
      return Response.json({
        data: surface === 'partner'
          ? { keys: [{ keyId: `ak_${requestPrincipal}`, preview: 'fixture', label: 'CLI', createdAt: 1789516800, lastUsedAt: null }] }
          : { head: { streamId: `user:u_${requestPrincipal}`, sequence: '0' } },
        meta: { requestId: 'req_read', surface, version: '1.0' },
      })
    })
    const client = createGscdumpV1Client({
      credential,
      headers: () => ({ 'x-principal': principal }),
      fetch,
      retry: { maxAttempts: 2, baseDelayMs: 0, maxDelayMs: 0 },
    })

    async function read(): Promise<unknown> {
      if (surface === 'analytics')
        return (await client.queryAnalyticsRows(input)).data.rows
      if (surface === 'partner')
        return (await client.listUserApiKeys({ params: { userId: 'u_01' } })).data.keys[0]?.keyId
      return (await client.getRealtimeStreamHead()).data.head.streamId
    }
    const first = read()
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1))
    const existing = read()
    await vi.waitFor(() => expect(credential).toHaveBeenCalledTimes(2))
    principal = 'B'
    if (failure === 'network') {
      firstResponse.reject(new Error('fixture connection failure'))
    }
    else {
      firstResponse.resolve(Response.json({
        error: { code: 'rate_limited', message: 'Unavailable', requestId: 'req_retry', retryable: true, details: {} },
      }, { status: 429 }))
    }
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2))
    principal = 'A'
    const resolutions = credential.mock.calls.length
    const later = read()
    await vi.waitFor(() => expect(credential).toHaveBeenCalledTimes(resolutions + 1))
    principal = 'B'
    const other = read()
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(3))
    retryResponse.resolve()

    const results = await Promise.all([first, existing, later, other])
    const expectedA = surface === 'analytics' ? [{ clicks: 3 }] : surface === 'partner' ? 'ak_A' : 'user:u_A'
    const expectedB = surface === 'analytics' ? [{ clicks: 9 }] : surface === 'partner' ? 'ak_B' : 'user:u_B'
    expect(results).toEqual([expectedA, expectedA, expectedA, expectedB])
    const retryHeaders = new Headers(fetch.mock.calls[1]![1]?.headers)
    expect(context === 'credential' ? retryHeaders.get('authorization') : retryHeaders.get('x-principal'))
      .toBe(context === 'credential' ? 'Bearer A' : 'A')
  })

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

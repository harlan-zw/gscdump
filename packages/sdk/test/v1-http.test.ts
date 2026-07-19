import type { GscdumpV1OperationInput } from '@gscdump/sdk/v1'
import {
  createGscdumpV1Client,
  GscdumpV1Error,
  isGscdumpV1Error,
} from '@gscdump/sdk/v1'
import { describe, expect, it, vi } from 'vitest'

async function settle(turns = 20): Promise<void> {
  for (let index = 0; index < turns; index++)
    await Promise.resolve()
}

const successMeta = {
  requestId: 'req_test',
  surface: 'realtime' as const,
  version: '1.0' as const,
}

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
    ...init,
  })
}

function errorResponse(
  status: number,
  code: 'forbidden' | 'realtime_unavailable',
  retryable: boolean,
  headers?: HeadersInit,
): Response {
  return jsonResponse({
    error: {
      code,
      message: `Failure: ${code}`,
      requestId: 'req_error',
      retryable,
      details: {},
    },
  }, { status, headers })
}

describe('@gscdump/sdk/v1 HTTP executor', () => {
  it('validates strict input once and executes the registered path with Bearer auth', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async (request, init) => {
      expect(request).toBe('/api/_gscdump/analytics/v1/sites/s_site/rows')
      expect(init?.method).toBe('POST')
      const headers = new Headers(init?.headers)
      expect(headers.get('authorization')).toBe('Bearer user_secret')
      expect(headers.get('x-request-id')).toBe('req_client')
      expect(JSON.parse(String(init?.body))).toEqual({
        dimensions: ['query'],
        metrics: ['clicks'],
        rowLimit: 10,
      })
      return jsonResponse({
        data: { rows: [], futureDataField: true },
        meta: {
          requestId: 'req_client',
          surface: 'analytics',
          version: '1.0',
          sourceName: 'primary',
          sourceKind: 'sql',
          queryMs: 2,
          futureMetaField: 'compatible',
        },
        futureEnvelopeField: true,
      })
    })
    const client = createGscdumpV1Client({
      apiRoot: '/api/_gscdump',
      credential: async () => 'user_secret',
      fetch,
    })

    const result = await client.queryAnalyticsRows({
      params: { siteId: 's_site' },
      body: { dimensions: ['query'], metrics: ['clicks'], rowLimit: 10 },
    }, { requestId: 'req_client' })

    expect(result.data.rows).toEqual([])
    expect((result.data as Record<string, unknown>).futureDataField).toBe(true)
    expect(fetch).toHaveBeenCalledTimes(1)

    const invalid = {
      params: { siteId: 's_site' },
      body: { dimensions: ['query'], accidental: true },
    } as unknown as GscdumpV1OperationInput<'analytics.rows.query'>
    await expect(client.queryAnalyticsRows(invalid)).rejects.toMatchObject({
      tag: 'GscdumpV1Error',
      code: 'request_validation',
      retryable: false,
    })
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('executes the response-compatible report family through registered v1 paths', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async (request, init) => {
      if (request === '/api/_gscdump/analytics/v1/sites/s_site/reports') {
        expect(JSON.parse(String(init?.body))).toEqual({
          state: { dimensions: ['query'], searchType: 'web' },
          comparison: { dimensions: ['query'], searchType: 'image' },
          filter: 'new',
        })
        return jsonResponse({
          data: {
            rows: [],
            totalCount: 0,
            totals: { clicks: 0, impressions: 0, ctr: 0, position: 0 },
            meta: {
              siteUrl: 'sc-domain:example.com',
              syncStatus: 'synced',
              newestDateSynced: null,
              oldestDateSynced: null,
            },
          },
          meta: {
            requestId: 'req_report_list',
            surface: 'analytics',
            version: '1.0',
            sourceName: 'hosted-report',
            sourceKind: 'sql',
            queryMs: 1,
          },
        })
      }
      expect(request).toBe('/api/_gscdump/analytics/v1/sites/s_site/reports/detail')
      expect(JSON.parse(String(init?.body))).toEqual({
        state: { dimensions: ['date'], searchType: 'web' },
      })
      return jsonResponse({
        data: {
          daily: [],
          totals: { clicks: 0, impressions: 0, ctr: 0, position: 0 },
          meta: {
            siteUrl: 'sc-domain:example.com',
            syncStatus: 'synced',
            newestDateSynced: null,
            oldestDateSynced: null,
            dataDelay: '0 days',
          },
        },
        meta: {
          requestId: 'req_report',
          surface: 'analytics',
          version: '1.0',
          sourceName: 'hosted-report',
          sourceKind: 'sql',
          queryMs: 1,
        },
      })
    })
    const client = createGscdumpV1Client({
      apiRoot: '/api/_gscdump',
      credential: 'user_secret',
      fetch,
    })

    await expect(client.queryAnalyticsReport({
      params: { siteId: 's_site' },
      body: {
        state: { dimensions: ['query'], searchType: 'web' },
        comparison: { dimensions: ['query'], searchType: 'image' },
        filter: 'new',
      },
    })).resolves.toMatchObject({ data: { rows: [], totalCount: 0 } })

    await expect(client.queryAnalyticsReportDetail({
      params: { siteId: 's_site' },
      body: { state: { dimensions: ['date'], searchType: 'web' } },
    })).resolves.toMatchObject({ data: { daily: [], totals: { clicks: 0 } } })
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('parses the stable error envelope into one tagged error', async () => {
    const client = createGscdumpV1Client({
      credential: 'partner_secret',
      fetch: vi.fn(async () => errorResponse(403, 'forbidden', false)),
    })

    const failure = await client.getRealtimeStreamHead().catch(error => error)
    expect(failure).toBeInstanceOf(GscdumpV1Error)
    expect(isGscdumpV1Error(failure)).toBe(true)
    expect(failure).toMatchObject({
      code: 'forbidden',
      status: 403,
      requestId: 'req_error',
      retryable: false,
      details: {},
    })
  })

  it('retries only descriptor-declared idempotent operations and honors Retry-After', async () => {
    const readFetch = vi.fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(errorResponse(503, 'realtime_unavailable', true, { 'retry-after': '0' }))
      .mockResolvedValueOnce(jsonResponse({
        data: { head: { streamId: 'user:u_test', sequence: '7' } },
        meta: successMeta,
      }))
    const reads = createGscdumpV1Client({
      credential: 'user_secret',
      fetch: readFetch,
      retry: { maxAttempts: 3, baseDelayMs: 0, maxDelayMs: 0 },
    })
    await expect(reads.getRealtimeStreamHead()).resolves.toMatchObject({
      data: { head: { sequence: '7' } },
    })
    expect(readFetch).toHaveBeenCalledTimes(2)

    const mutationFetch = vi.fn<typeof globalThis.fetch>()
      .mockResolvedValue(errorResponse(503, 'realtime_unavailable', true, { 'retry-after': '0' }))
    const mutations = createGscdumpV1Client({
      credential: 'user_secret',
      fetch: mutationFetch,
      retry: { maxAttempts: 5, baseDelayMs: 0, maxDelayMs: 0 },
    })
    await expect(mutations.createRealtimeTicket({ body: {} })).rejects.toMatchObject({
      code: 'realtime_unavailable',
      retryable: true,
    })
    expect(mutationFetch).toHaveBeenCalledTimes(1)
  })

  it('fails malformed or undeclared success responses closed', async () => {
    const malformed = createGscdumpV1Client({
      credential: 'user_secret',
      fetch: vi.fn(async () => jsonResponse({ data: {}, meta: successMeta })),
    })
    await expect(malformed.getRealtimeStreamHead()).rejects.toMatchObject({
      code: 'response_validation',
      status: 200,
    })

    const undeclared = createGscdumpV1Client({
      credential: 'user_secret',
      fetch: vi.fn(async () => jsonResponse({}, { status: 202 })),
    })
    await expect(undeclared.getRealtimeStreamHead()).rejects.toMatchObject({
      code: 'protocol_error',
      status: 202,
    })
  })

  it('does not retry an aborted idempotent request', async () => {
    const controller = new AbortController()
    controller.abort(new Error('stop'))
    const fetch = vi.fn<typeof globalThis.fetch>()
    const client = createGscdumpV1Client({ credential: 'user_secret', fetch })

    await expect(client.getRealtimeStreamHead({}, { signal: controller.signal })).rejects.toMatchObject({
      code: 'aborted',
      retryable: false,
    })
    expect(fetch).not.toHaveBeenCalled()
  })

  it('owns Authorization and strips legacy API-key headers', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async (_request, init) => {
      const headers = new Headers(init?.headers)
      expect(headers.get('authorization')).toBe('Bearer current_secret')
      expect(headers.has('x-api-key')).toBe(false)
      return jsonResponse({
        data: { head: { streamId: 'user:u_test', sequence: '0' } },
        meta: successMeta,
      })
    })
    const client = createGscdumpV1Client({
      credential: 'current_secret',
      headers: async () => ({
        'authorization': 'Bearer stale_secret',
        'x-api-key': 'legacy_secret',
      }),
      fetch,
    })

    await client.getRealtimeStreamHead()
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('resolves base headers and credentials concurrently', async () => {
    const order: string[] = []
    const fetch = vi.fn<typeof globalThis.fetch>(async () => jsonResponse({
      data: { head: { streamId: 'user:u_test', sequence: '0' } },
      meta: successMeta,
    }))
    const client = createGscdumpV1Client({
      headers: async () => {
        order.push('headers:start')
        await new Promise(resolve => setTimeout(resolve, 0))
        order.push('headers:end')
        return { 'x-client': 'test' }
      },
      credential: async () => {
        order.push('credential')
        return 'current_secret'
      },
      fetch,
    })

    await client.getRealtimeStreamHead()
    expect(order.indexOf('credential')).toBeLessThan(order.indexOf('headers:end'))
  })

  it('aborts pending credential resolution before fetch and keeps the tagged error shape', async () => {
    let resolveCredential!: (credential: string) => void
    const credential = new Promise<string>((resolve) => {
      resolveCredential = resolve
    })
    const fetch = vi.fn<typeof globalThis.fetch>()
    const client = createGscdumpV1Client({ credential: () => credential, fetch })
    const controller = new AbortController()

    const request = client.getRealtimeStreamHead({}, { signal: controller.signal })
    await settle(2)
    controller.abort(new Error('stop resolving credentials'))
    await expect(request).rejects.toMatchObject({
      tag: 'GscdumpV1Error',
      code: 'aborted',
      retryable: false,
    })
    expect(fetch).not.toHaveBeenCalled()
    resolveCredential('unused_secret')
    await settle(2)
  })

  it('tags aborts during Retry-After and never spends another attempt', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => (
      errorResponse(503, 'realtime_unavailable', true, { 'retry-after': '60' })
    ))
    const client = createGscdumpV1Client({ credential: 'user_secret', fetch })
    const controller = new AbortController()

    const request = client.getRealtimeStreamHead({}, { signal: controller.signal })
    await settle()
    expect(fetch).toHaveBeenCalledTimes(1)
    controller.abort(new Error('stop retrying'))
    await expect(request).rejects.toMatchObject({
      tag: 'GscdumpV1Error',
      code: 'aborted',
      retryable: false,
    })
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('waits for numeric Retry-After even when configured backoff is shorter', async () => {
    vi.useFakeTimers()
    try {
      const fetch = vi.fn<typeof globalThis.fetch>()
        .mockResolvedValueOnce(errorResponse(503, 'realtime_unavailable', true, { 'retry-after': '2' }))
        .mockResolvedValueOnce(jsonResponse({
          data: { head: { streamId: 'user:u_test', sequence: '1' } },
          meta: successMeta,
        }))
      const client = createGscdumpV1Client({
        credential: 'user_secret',
        fetch,
        retry: { maxAttempts: 2, baseDelayMs: 0, maxDelayMs: 0 },
      })

      const request = client.getRealtimeStreamHead()
      await settle()
      expect(fetch).toHaveBeenCalledTimes(1)
      await vi.advanceTimersByTimeAsync(1_999)
      expect(fetch).toHaveBeenCalledTimes(1)
      await vi.advanceTimersByTimeAsync(1)
      await expect(request).resolves.toMatchObject({ data: { head: { sequence: '1' } } })
      expect(fetch).toHaveBeenCalledTimes(2)
    }
    finally {
      vi.useRealTimers()
    }
  })

  it('fails non-object runtime input as request validation', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>()
    const client = createGscdumpV1Client({ credential: 'user_secret', fetch })

    await expect(client.getRealtimeStreamHead(null as never)).rejects.toMatchObject({
      code: 'request_validation',
      details: { location: 'input' },
    })
    expect(fetch).not.toHaveBeenCalled()
  })
})

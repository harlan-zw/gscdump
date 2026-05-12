import { describe, expect, it, vi } from 'vitest'
import { createHostedCloudProtocol } from '../src/protocol'

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...init,
  })
}

describe('createHostedCloudProtocol', () => {
  it('sends cloud session headers and normalizes route query strings', async () => {
    const fetch = vi.fn(async () => jsonResponse({ urls: [], pagination: { total: 0, limit: 25, offset: 50, hasMore: false }, meta: { siteUrl: 'https://example.com/', status: 'indexed', issue: null } }))
    const protocol = createHostedCloudProtocol({
      cloudUrl: 'https://cloud.example/',
      sessionId: 'sess_123',
      version: '1.2.3',
      fetch: fetch as unknown as typeof globalThis.fetch,
    })

    await protocol.indexingUrls('site_1', {
      status: 'indexed',
      issue: 'coverage',
      search: 'example',
      limit: 25,
      offset: 50,
    })

    expect(fetch).toHaveBeenCalledWith(
      'https://cloud.example/api/sites/site_1/indexing/urls?status=indexed&issue=coverage&search=example&limit=25&offset=50',
      expect.objectContaining({
        headers: {
          'content-type': 'application/json',
          'x-cli-session': 'sess_123',
          'x-cli-version': '1.2.3',
        },
      }),
    )
  })

  it('keeps hosted query route construction behind the protocol seam', async () => {
    const fetch = vi.fn(async () => jsonResponse({
      rows: [],
      meta: {
        siteUrl: 'https://example.com/',
        dimensions: ['page'],
        dateRange: { startDate: '2026-01-01', endDate: '2026-01-31' },
        rowCount: 0,
        hasMore: false,
      },
    }))
    const protocol = createHostedCloudProtocol({
      cloudUrl: 'https://cloud.example',
      sessionId: 'sess_123',
      fetch: fetch as unknown as typeof globalThis.fetch,
    })

    await protocol.query('https://example.com/', {
      startDate: '2026-01-01',
      endDate: '2026-01-31',
      dimensions: ['page'],
      rowLimit: 100,
      searchType: 'web',
    })

    const [, init] = fetch.mock.calls[0]!
    expect(fetch.mock.calls[0]![0]).toBe('https://cloud.example/api/gsc/query')
    expect(init).toEqual(expect.objectContaining({ method: 'POST' }))
    expect(JSON.parse(String(init?.body))).toEqual({
      siteUrl: 'https://example.com/',
      startDate: '2026-01-01',
      endDate: '2026-01-31',
      dimensions: ['page'],
      rowLimit: 100,
      searchType: 'web',
    })
  })

  it('maps hosted error responses to CLI-facing messages', async () => {
    const fetch = vi.fn(async () => jsonResponse({ message: 'upgrade now' }, { status: 426, statusText: 'Upgrade Required' }))
    const protocol = createHostedCloudProtocol({
      cloudUrl: 'https://cloud.example',
      sessionId: 'sess_123',
      fetch: fetch as unknown as typeof globalThis.fetch,
    })

    await expect(protocol.me()).rejects.toThrow('upgrade now')

    fetch.mockResolvedValueOnce(jsonResponse({ message: 'bad request' }, { status: 400, statusText: 'Bad Request' }))
    await expect(protocol.availableSites()).rejects.toThrow('bad request')

    fetch.mockResolvedValueOnce(jsonResponse({}, { status: 401, statusText: 'Unauthorized' }))
    await expect(protocol.me()).rejects.toThrow('CLI session expired or revoked')
  })
})

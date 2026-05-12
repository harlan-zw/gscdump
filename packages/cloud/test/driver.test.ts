import { describe, expect, it, vi } from 'vitest'
import { createCloudDriver } from '../src/driver'

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...init,
  })
}

function site(siteId: string, siteUrl: string) {
  return {
    siteId,
    siteUrl,
    permissionLevel: 'siteOwner',
    syncStatus: null,
    syncProgress: { total: 0, completed: 0, percent: 0 },
    lastSyncAt: null,
    newestDateSynced: null,
    oldestDateSynced: null,
  }
}

describe('createCloudDriver', () => {
  it('resolves site ids once and passes canonical site urls to hosted query', async () => {
    const fetch = vi.fn(async (url: string | URL | Request) => {
      const href = String(url)
      if (href.endsWith('/api/cli/me'))
        return jsonResponse({ sites: [site('site_1', 'https://example.com/')] })
      if (href.endsWith('/api/gsc/query')) {
        return jsonResponse({
          rows: [],
          meta: {
            siteUrl: 'https://example.com/',
            dimensions: ['page'],
            dateRange: { startDate: '2026-01-01', endDate: '2026-01-31' },
            rowCount: 0,
            hasMore: false,
          },
        })
      }
      if (href.endsWith('/api/sites/site_1/sync-status')) {
        return jsonResponse({
          siteUrl: 'https://example.com/',
          syncStatus: 'synced',
          oldestDateAvailable: null,
          oldestDateSynced: null,
          newestDateSynced: null,
          lastSyncAt: null,
          lastError: null,
          jobs: { queued: 0, processing: 0, completed: 0, failed: 0 },
          progress: 100,
          daysSynced: 0,
          daysAvailable: 0,
          isSyncing: false,
          hasData: false,
          isComplete: true,
          tables: {},
          failedJobs: [],
        })
      }
      throw new Error(`Unexpected request: ${href}`)
    })

    const driver = createCloudDriver({
      cloudUrl: 'https://cloud.example',
      sessionId: 'sess_123',
      fetch: fetch as unknown as typeof globalThis.fetch,
    })

    await driver.query('example.com', {
      startDate: '2026-01-01',
      endDate: '2026-01-31',
      dimensions: ['page'],
    })
    await driver.syncStatus('https://example.com/')

    const queryCall = fetch.mock.calls.find(([url]) => String(url).endsWith('/api/gsc/query'))
    expect(queryCall).toBeTruthy()
    expect(JSON.parse(String(queryCall?.[1]?.body))).toEqual({
      siteUrl: 'https://example.com/',
      startDate: '2026-01-01',
      endDate: '2026-01-31',
      dimensions: ['page'],
    })
    expect(fetch.mock.calls.filter(([url]) => String(url).endsWith('/api/cli/me'))).toHaveLength(1)
  })
})

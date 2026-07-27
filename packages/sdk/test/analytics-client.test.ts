import type { AnalyticsFetch } from '../src/analytics-client'
import { createAnalyticsClient } from '../src/analytics-client'

const analysisSourcesResponse = {
  siteId: 's_1',
  searchType: 'web',
  range: { start: '2026-05-01', end: '2026-05-07' },
  snapshotVersion: 'v1',
  generatedAt: '2026-05-11T00:00:00.000Z',
  tables: [],
  eligibilityCeiling: { maxBytes: 150_000_000, maxRows: 10_000_000, maxFiles: 64 },
}

describe('createAnalyticsClient', () => {
  it('uses injected transport with analytics route contracts', async () => {
    const calls: Array<{ url: string, options: any }> = []
    const fetch = ((url: string, options: any) => {
      calls.push({ url, options })
      if (url.endsWith('/sites'))
        return Promise.resolve([])
      if (url.endsWith('/source-info'))
        return Promise.resolve({ name: 'r2', kind: 'sql', capabilities: { attachedTables: true }, supportedAnalyzerIds: [], browserAttachEligible: true })
      if (url.endsWith('/analysis-sources'))
        return Promise.resolve(analysisSourcesResponse)
      if (url.endsWith('/bulk-sources')) {
        return Promise.resolve({
          generatedAt: '2026-05-11T00:00:00.000Z',
          siteCount: 1,
          maxSites: 20,
          results: { s_1: analysisSourcesResponse },
        })
      }
      if (url.endsWith('/query-dim-source'))
        return Promise.resolve({ file: { url: '/query-dim.parquet', bytes: 123, contentHash: 'query-dim-1' } })
      return Promise.resolve({ rows: [], meta: { sourceName: 'r2', sourceKind: 'sql', queryMs: 1 } })
    }) as AnalyticsFetch

    const client = createAnalyticsClient({
      apiBase: 'https://origin.example/',
      headers: async () => ({ 'x-api-key': 'key_1' }),
      fetch,
    })

    await client.listSites()
    await client.getBulkSources({
      siteIds: ['s_1', 's_1'],
      tables: ['pages'],
      start: '2026-05-01',
      end: '2026-05-07',
      searchType: 'discover',
      maxBytes: 64 * 1024 * 1024,
    })
    await client.getSourceInfo('s_1', { searchType: 'discover', start: '2026-05-01', end: '2026-05-07' })
    await client.getAnalysisSources('s_1', ['pages', 'keywords'], { start: '2026-05-01', end: '2026-05-07' })
    await client.getAnalysisSources('s_1', {
      tables: 'pages',
      searchType: 'discover',
      maxBytes: 64 * 1024 * 1024,
      maxRows: 4_000_000,
      maxFiles: 48,
    })
    await client.analyze('s_1', { type: 'data-query', searchType: 'image' })
    await client.getQueryDimSource('s_1')

    expect(calls[0]!.url).toBe('https://origin.example/api/__gsc/sites')
    expect(new Headers(calls[0]!.options.headers).get('x-api-key')).toBe('key_1')
    expect(calls[1]).toMatchObject({
      url: 'https://origin.example/api/__gsc/bulk-sources',
      options: {
        query: {
          siteIds: 's_1',
          tables: 'pages',
          searchType: 'discover',
          start: '2026-05-01',
          end: '2026-05-07',
          maxBytes: String(64 * 1024 * 1024),
        },
      },
    })
    expect(calls[2]).toMatchObject({
      url: 'https://origin.example/api/__gsc/sites/s_1/source-info',
      options: { query: { searchType: 'discover', start: '2026-05-01', end: '2026-05-07' } },
    })
    expect(calls[3]).toMatchObject({
      url: 'https://origin.example/api/__gsc/sites/s_1/analysis-sources',
      options: { query: { tables: 'keywords,pages', searchType: 'web', start: '2026-05-01', end: '2026-05-07' } },
    })
    expect(calls[4]).toMatchObject({
      url: 'https://origin.example/api/__gsc/sites/s_1/analysis-sources',
      options: {
        query: {
          tables: 'pages',
          searchType: 'discover',
          maxBytes: String(64 * 1024 * 1024),
          maxRows: '4000000',
          maxFiles: '48',
        },
      },
    })
    expect(calls[5]).toMatchObject({
      url: 'https://origin.example/api/__gsc/sites/s_1/analyze',
      options: { method: 'POST', body: { type: 'data-query', searchType: 'image' } },
    })
    expect(calls[6]).toMatchObject({
      url: 'https://origin.example/api/__gsc/sites/s_1/query-dim-source',
      options: { method: 'GET' },
    })
  })

  it('validates analytics request and response contracts when enabled', async () => {
    const fetch = ((url: string) => {
      if (url.endsWith('/backfill'))
        return Promise.resolve({ queued: true })
      return Promise.resolve({
        version: 1,
        id: 'top-pages',
        builtAt: 1770000000,
        windowDays: 28,
        payload: [],
      })
    }) as AnalyticsFetch

    const client = createAnalyticsClient({ fetch, validate: true })

    await expect(client.requestBackfill('s_1', {
      startDate: '2026-05-01',
      endDate: '2026-05-10',
    })).resolves.toEqual({ queued: true })
    await expect(client.getRollup('s_1', 'top-pages')).resolves.toMatchObject({ id: 'top-pages' })
    expect(() => client.requestBackfill('s_1', {
      startDate: '2026-05-01',
    } as any)).toThrow()
  })
})

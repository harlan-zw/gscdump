import type { AnalyticsFetch } from '../src'
import { createAnalyticsClient } from '../src'

describe('createAnalyticsClient', () => {
  it('uses injected transport with analytics route contracts', async () => {
    const calls: Array<{ url: string, options: any }> = []
    const fetch = ((url: string, options: any) => {
      calls.push({ url, options })
      if (url.endsWith('/sites'))
        return Promise.resolve([])
      if (url.endsWith('/analysis-sources'))
        return Promise.resolve({ tables: {}, generatedAt: '2026-05-11T00:00:00.000Z', manifestVersion: 'v1' })
      return Promise.resolve({ rows: [], meta: { sourceName: 'r2', sourceKind: 'sql', queryMs: 1 } })
    }) as AnalyticsFetch

    const client = createAnalyticsClient({
      apiBase: 'https://origin.example/',
      headers: async () => ({ 'x-api-key': 'key_1' }),
      fetch,
    })

    await client.listSites()
    await client.getAnalysisSources('s_1', ['pages', 'keywords'])
    await client.queryRows('s_1', { dimensions: ['page'], rowLimit: 10 })

    expect(calls[0]!.url).toBe('https://origin.example/api/__gsc/sites')
    expect(new Headers(calls[0]!.options.headers).get('x-api-key')).toBe('key_1')
    expect(calls[1]).toMatchObject({
      url: 'https://origin.example/api/__gsc/sites/s_1/analysis-sources',
      options: { query: { tables: 'pages,keywords' } },
    })
    expect(calls[2]).toMatchObject({
      url: 'https://origin.example/api/__gsc/sites/s_1/rows',
      options: { method: 'POST', body: { dimensions: ['page'], rowLimit: 10 } },
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

import type { PartnerFetch } from '../src'
import { createPartnerClient } from '../src'
import { dataQuery, indexingDiagnosticsQuery } from '../src/hosted-query'

const analysisSourcesResponse = {
  siteId: 's_1',
  searchType: 'web',
  range: { start: '2026-05-01', end: '2026-05-07' },
  snapshotVersion: 'v1',
  generatedAt: '2026-05-11T00:00:00.000Z',
  tables: [],
  eligibilityCeiling: { maxBytes: 150_000_000, maxRows: 10_000_000, maxFiles: 64 },
}

describe('createPartnerClient', () => {
  it('uses injected ofetch-compatible transport with api key and lazy headers', async () => {
    const calls: Array<{ url: string, options: any }> = []
    const fetch = ((url: string, options: any) => {
      calls.push({ url, options })
      return Promise.resolve({ sites: [] })
    }) as PartnerFetch

    const client = createPartnerClient({
      apiBase: 'https://origin.example/api/',
      apiKey: 'key_1',
      headers: async () => ({ 'x-partner': 'nuxtseo' }),
      fetch,
    })

    await client.getUserSites('u_1')
    await client.getUserLifecycle('u_1')

    expect(calls).toHaveLength(2)
    expect(calls[0]!.url).toBe('https://origin.example/api/users/u_1/sites')
    expect(calls[1]!.url).toBe('https://origin.example/api/partner/users/u_1/lifecycle')
    expect(new Headers(calls[0]!.options.headers).get('x-api-key')).toBe('key_1')
    expect(new Headers(calls[0]!.options.headers).get('x-partner')).toBe('nuxtseo')
  })

  it('serializes data query state without exposing route construction to callers', async () => {
    const calls: Array<{ url: string, options: any }> = []
    const fetch = ((url: string, options: any) => {
      calls.push({ url, options })
      return Promise.resolve({ rows: [], totalCount: 0, totals: {}, meta: {} })
    }) as PartnerFetch
    const client = createPartnerClient({ apiBase: '/api', fetch })

    await client.getData(
      's_1',
      { dimensions: ['page'], rowLimit: 10 },
      { comparison: { dimensions: ['page'] }, filter: 'new' },
    )
    await client.getDataDetail(
      's_1',
      { dimensions: ['query'], searchType: 'discover' },
      { comparison: { dimensions: ['query'] } },
    )
    await client.getAnalysis('s_1', {
      preset: 'opportunity',
      startDate: '2026-05-01',
      endDate: '2026-05-10',
      searchType: 'image',
    })

    expect(calls[0]!.url).toBe('/api/sites/s_1/data')
    expect(calls[0]!.options.query).toEqual({
      q: JSON.stringify({ dimensions: ['page'], rowLimit: 10, searchType: 'web' }),
      qc: JSON.stringify({ dimensions: ['page'], searchType: 'web' }),
      filter: 'new',
      searchType: 'web',
    })
    expect(calls[1]!.url).toBe('/api/sites/s_1/data/detail')
    expect(calls[1]!.options.query).toEqual({
      q: JSON.stringify({ dimensions: ['query'], searchType: 'discover' }),
      qc: JSON.stringify({ dimensions: ['query'], searchType: 'discover' }),
      searchType: 'discover',
    })
    expect(calls[2]).toMatchObject({
      url: '/api/sites/s_1/analysis',
      options: {
        query: {
          preset: 'opportunity',
          startDate: '2026-05-01',
          endDate: '2026-05-10',
          searchType: 'image',
        },
      },
    })
  })

  it('canonicalizes hosted query params that are semantically order-insensitive', () => {
    const a = dataQuery({ rowLimit: 10, dimensions: ['page'] } as any)
    const b = dataQuery({ dimensions: ['page'], rowLimit: 10 } as any)

    expect(a.q).toBe(b.q)
    expect(indexingDiagnosticsQuery({ sampleIssues: ['soft_404', 'not_found'] })).toEqual({
      sampleIssues: 'not_found,soft_404',
    })
    expect(indexingDiagnosticsQuery({ sampleIssues: ['not_found', 'soft_404', 'not_found'] })).toEqual({
      sampleIssues: 'not_found,soft_404',
    })
  })

  it('posts lifecycle bodies and validates brand analysis params', async () => {
    const calls: Array<{ url: string, options: any }> = []
    const fetch = ((url: string, options: any) => {
      calls.push({ url, options })
      return Promise.resolve({ userId: 'u_1' })
    }) as PartnerFetch
    const client = createPartnerClient({ fetch })

    await client.registerUser({
      userGoogleId: 'google_1',
      userEmail: 'user@example.com',
      accessToken: 'access',
      refreshToken: 'refresh',
      tokenExpiresAt: 123,
    })

    expect(calls[0]!.url).toBe('/api/users/register')
    expect(calls[0]!.options.method).toBe('POST')
    expect(calls[0]!.options.body).toMatchObject({ userGoogleId: 'google_1' })

    expect(() => client.getAnalysis('s_1', {
      preset: 'brand-only',
      startDate: '2026-01-01',
      endDate: '2026-01-31',
    })).toThrow('brandTerms is required')
  })

  it('can validate requests and responses with endpoint schemas', async () => {
    const fetch = (() => Promise.resolve({
      userId: 'u_1',
      status: 'ready',
    })) as PartnerFetch
    const client = createPartnerClient({ fetch, validate: true })

    await expect(client.getUserStatus('u_1')).resolves.toEqual({
      userId: 'u_1',
      status: 'ready',
    })

    expect(() => client.registerUser({
      userGoogleId: 'google_1',
      userEmail: 'not-an-email',
      accessToken: 'access',
      refreshToken: 'refresh',
      tokenExpiresAt: 123,
    })).toThrow()
  })

  it('uses current /api partner aliases for partner-owned mutations', async () => {
    const calls: Array<{ url: string, options: any }> = []
    const fetch = ((url: string, options: any) => {
      calls.push({ url, options })
      if (url.endsWith('/bulk-register')) {
        return Promise.resolve({
          results: [],
          summary: { registered: 0, alreadyExists: 0, notFound: 0, errors: 0 },
        })
      }
      if (url.endsWith('/u_1'))
        return Promise.resolve({ ok: true, queued: true, userId: 1, publicId: 'u_1' })
      return Promise.resolve({ siteId: 's_1', status: 'pending' })
    }) as PartnerFetch
    const client = createPartnerClient({ fetch, validate: true })

    await client.registerSite({ userId: 'u_1', siteUrl: 'sc-domain:example.com' })
    await client.bulkRegisterSites({ userId: 'u_1', siteUrls: ['sc-domain:example.com'] })
    await client.deleteUser('u_1')

    expect(calls.map(call => call.url)).toEqual([
      '/api/partner/sites/register',
      '/api/partner/sites/bulk-register',
      '/api/partner/users/u_1',
    ])
  })

  it('covers current analytics helper endpoints', async () => {
    const calls: Array<{ url: string, options: any }> = []
    const fetch = ((url: string, options: any) => {
      calls.push({ url, options })
      if (url.endsWith('/analysis-sources'))
        return Promise.resolve(analysisSourcesResponse)
      if (url.endsWith('/keyword-sparklines'))
        return Promise.resolve({ sparklines: { test: [1, 2] } })
      if (url.endsWith('/query-trend')) {
        return Promise.resolve({
          daily: [{ date: '2026-05-01', queryCount: 10 }],
          total: 10,
          meta: { siteUrl: 'sc-domain:example.com', syncStatus: 'synced' },
        })
      }
      return Promise.resolve({})
    }) as PartnerFetch
    const client = createPartnerClient({ fetch, validate: true })

    await client.getAnalysisSources('s_1', ['pages', 'keywords'], { start: '2026-05-01', end: '2026-05-07' })
    await client.getKeywordSparklines('s_1', { keywords: ['test'], startDate: '2026-05-01', endDate: '2026-05-10' })
    await client.getQueryTrend('s_1', { startDate: '2026-05-01', endDate: '2026-05-10', prevStartDate: '2026-04-20' })
    await client.getCtrCurve('s_1', { startDate: '2026-05-01', endDate: '2026-05-10' })

    expect(calls[0]).toMatchObject({ url: '/api/sites/s_1/analysis-sources', options: { query: { tables: 'keywords,pages', searchType: 'web', start: '2026-05-01', end: '2026-05-07' } } })
    expect(calls[1]).toMatchObject({ url: '/api/sites/s_1/data/keyword-sparklines', options: { method: 'POST' } })
    expect(calls[2]).toMatchObject({ url: '/api/sites/s_1/data/query-trend' })
    expect(calls[3]).toMatchObject({ url: '/api/sites/s_1/ctr-curve' })
  })

  it('dedupes concurrent identical GET requests only while in flight', async () => {
    const calls: Array<{ url: string, options: any }> = []
    const resolvers: Array<(value: unknown) => void> = []
    const fetch = ((url: string, options: any) => {
      calls.push({ url, options })
      return new Promise((resolve) => {
        resolvers.push(resolve)
      })
    }) as PartnerFetch
    const client = createPartnerClient({ fetch })

    const a = client.getAnalysisSources('s_1', ['pages'], { start: '2026-05-01', end: '2026-05-07' })
    const b = client.getAnalysisSources('s_1', ['pages'], { start: '2026-05-01', end: '2026-05-07' })

    await Promise.resolve()
    expect(calls).toHaveLength(1)
    resolvers.shift()!(analysisSourcesResponse)
    await expect(Promise.all([a, b])).resolves.toEqual([analysisSourcesResponse, analysisSourcesResponse])

    const c = client.getAnalysisSources('s_1', ['pages'], { start: '2026-05-01', end: '2026-05-07' })
    await Promise.resolve()
    expect(calls).toHaveLength(2)
    resolvers.shift()!(analysisSourcesResponse)
    await expect(c).resolves.toEqual(analysisSourcesResponse)
  })

  it('dedupes opt-in read POST requests while in flight', async () => {
    const calls: Array<{ url: string, options: any }> = []
    let resolveFetch!: (value: unknown) => void
    const fetch = ((url: string, options: any) => {
      calls.push({ url, options })
      return new Promise((resolve) => {
        resolveFetch = resolve
      })
    }) as PartnerFetch
    const client = createPartnerClient({ fetch })

    const params = { keywords: ['nuxt'], startDate: '2026-05-01', endDate: '2026-05-10' }
    const a = client.getKeywordSparklines('s_1', params)
    const b = client.getKeywordSparklines('s_1', params)

    await Promise.resolve()
    expect(calls).toHaveLength(1)
    expect(calls[0]!.options).toMatchObject({ method: 'POST' })
    expect('dedupe' in calls[0]!.options).toBe(false)
    resolveFetch({ sparklines: { nuxt: [1, 2, 3] } })
    await expect(Promise.all([a, b])).resolves.toEqual([
      { sparklines: { nuxt: [1, 2, 3] } },
      { sparklines: { nuxt: [1, 2, 3] } },
    ])
  })
})

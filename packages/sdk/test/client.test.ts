import type { PartnerFetch } from '../src'
import { createPartnerClient } from '../src'

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

    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toBe('https://origin.example/api/users/u_1/sites')
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
        return Promise.resolve({ tables: {}, generatedAt: '2026-05-11T00:00:00.000Z', manifestVersion: 'v1' })
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

    expect(calls[0]).toMatchObject({ url: '/api/sites/s_1/analysis-sources', options: { query: { tables: 'pages,keywords', searchType: 'web', start: '2026-05-01', end: '2026-05-07' } } })
    expect(calls[1]).toMatchObject({ url: '/api/sites/s_1/data/keyword-sparklines', options: { method: 'POST' } })
    expect(calls[2]).toMatchObject({ url: '/api/sites/s_1/data/query-trend' })
    expect(calls[3]).toMatchObject({ url: '/api/sites/s_1/ctr-curve' })
  })
})

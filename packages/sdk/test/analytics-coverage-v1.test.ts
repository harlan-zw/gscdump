import { createGscdumpV1Client, GscdumpV1Error } from '@gscdump/sdk/v1'
import { describe, expect, it, vi } from 'vitest'

const query = { startDate: '2026-10-01', endDate: '2026-10-02', comparisonStartDate: '2026-09-29', comparisonEndDate: '2026-09-30', searchType: 'web' as const }
const data = {
  searchType: 'web',
  current: { startDate: query.startDate, endDate: query.endDate, complete: true },
  comparison: { startDate: query.comparisonStartDate, endDate: query.comparisonEndDate, complete: false },
}

describe('analytics coverage transport', () => {
  it('reads both windows through the authenticated public operation', async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({ data, meta: { requestId: 'req_coverage', surface: 'partner', version: '1.0' } })))
    const client = createGscdumpV1Client({ credential: 'test-key', fetch })
    const response = await client.getSiteAnalyticsCoverage({ params: { siteId: 's_one' }, query })
    expect(response.data).toEqual(data)
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit]
    expect(new URL(url).pathname).toBe('/api/partner/v1/sites/s_one/analytics/coverage')
    expect(new URL(url).searchParams.get('comparisonStartDate')).toBe('2026-09-29')
    expect(new Headers(init.headers).get('authorization')).toBe('Bearer test-key')
  })

  it('rejects an incomplete comparison request before making a network call', async () => {
    const fetch = vi.fn()
    const client = createGscdumpV1Client({ credential: 'test-key', fetch })
    await expect(client.getSiteAnalyticsCoverage({ params: { siteId: 's_one' }, query: { startDate: '2026-10-01', endDate: '2026-10-02', comparisonStartDate: '2026-09-01' } })).rejects.toBeInstanceOf(GscdumpV1Error)
    expect(fetch).not.toHaveBeenCalled()
  })
})

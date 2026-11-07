import { createGscdumpV1Client } from '@gscdump/sdk/v1'
import { describe, expect, it, vi } from 'vitest'

const meta = { requestId: 'req_01', surface: 'partner', version: '1.0' }
const window = { startDate: '2026-03-30', endDate: '2026-03-30', label: 'Last 3 months' }

describe('generative AI report client', () => {
  it('posts an upload to the Site path and returns the receipt', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async (url, init) => {
      expect(new URL(String(url), 'https://example.com').pathname).toBe('/api/_gscdump/partner/v1/sites/s_site/generative-ai/uploads')
      expect(init?.method).toBe('POST')
      expect(JSON.parse(String(init?.body))).toMatchObject({ sourceSha256: 'a'.repeat(64) })
      return Response.json({ data: { uploadId: 'gau_01', deduped: false, warnings: [], unmappedCountries: [], window, rowCounts: { chart: 1, pages: 0, countries: 0, devices: 0 } }, meta })
    })
    const client = createGscdumpV1Client({ apiRoot: '/api/_gscdump', credential: 'user_secret', fetch })
    const result = await client.createSiteGenerativeAiReportUpload({
      params: { siteId: 's_site' },
      body: {
        report: 'search',
        parserVersion: 1,
        sourceSha256: 'a'.repeat(64),
        sourceFilename: 'export.zip',
        window,
        searchTypeFilter: 'Web (text-based)',
        chart: { rows: [{ date: '2026-03-30', impressions: { _tag: 'reported', value: 4 } }] },
        pages: { coverage: { _tag: 'complete' }, offHostRows: 0, offHostImpressions: 0, rows: [] },
        countries: { rows: [] },
        devices: { rows: [] },
        warnings: [],
      },
    })
    expect(result.data).toMatchObject({ uploadId: 'gau_01', deduped: false })
  })

  it('reads the report with an exact page URL and removes an upload by id', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async (url, init) => {
      const requested = new URL(String(url), 'https://example.com')
      if (init?.method === 'DELETE') {
        expect(requested.pathname).toBe('/api/_gscdump/partner/v1/sites/s_site/generative-ai/uploads/gau_01')
        return Response.json({ data: { uploadId: 'gau_01', removed: true }, meta })
      }
      expect(requested.pathname).toBe('/api/_gscdump/partner/v1/sites/s_site/generative-ai')
      expect(requested.searchParams.get('pageUrl')).toBe('https://example.com/')
      return Response.json({ data: { _tag: 'empty', report: 'search', reason: 'no-upload' }, meta })
    })
    const client = createGscdumpV1Client({ apiRoot: '/api/_gscdump', credential: 'user_secret', fetch })
    const read = await client.getSiteGenerativeAiReport({ params: { siteId: 's_site' }, query: { pageUrl: 'https://example.com/' } })
    expect(read.data).toEqual({ _tag: 'empty', report: 'search', reason: 'no-upload' })
    const removed = await client.removeSiteGenerativeAiReportUpload({ params: { siteId: 's_site', uploadId: 'gau_01' } })
    expect(removed.data).toEqual({ uploadId: 'gau_01', removed: true })
  })
})

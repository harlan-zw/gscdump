import { createGscdumpV1Protocol, generativeAiReportUploadV1Schema } from '@gscdump/contracts/v1'
import { describe, expect, it } from 'vitest'

const reported = (value: number) => ({ _tag: 'reported', value }) as const
const zero = { _tag: 'zero-or-unavailable' } as const
const meta = { requestId: 'req_01', surface: 'partner', version: '1.0' }

const upload = {
  report: 'search',
  parserVersion: 1,
  sourceSha256: 'a'.repeat(64),
  sourceFilename: 'gscdump.com-Performance-on-Search-Generative-AI-Features-2026-11-07.zip',
  window: { startDate: '2026-11-03', endDate: '2026-11-04', label: 'Last 3 months' },
  searchTypeFilter: 'Web (text-based)',
  chart: { rows: [{ date: '2026-11-03', impressions: zero }, { date: '2026-11-04', impressions: reported(4) }] },
  pages: { coverage: { _tag: 'complete' }, offHostRows: 0, offHostImpressions: 0, rows: [{ url: 'http://gscdump.com/', impressions: reported(2) }, { url: 'https://gscdump.com/', impressions: reported(15) }] },
  countries: { rows: [{ countryName: 'Atlantis', countryCode: null, impressions: reported(3) }] },
  devices: { rows: [{ device: 'desktop', impressions: reported(1) }] },
  warnings: [],
}

const available = {
  _tag: 'available',
  report: 'search',
  source: { _tag: 'upload', uploadId: 'gau_01', uploadedAt: '2026-11-07T00:00:00.000Z', sourceFilename: upload.sourceFilename },
  window: { startDate: '2026-11-03', endDate: '2026-11-04', label: 'Last 3 months' },
  freshness: 'current',
  chart: { scope: 'property', rows: upload.chart.rows },
  pages: { scope: 'registered-host', coverage: { _tag: 'complete' }, offHostRows: 0, rows: upload.pages.rows },
  countries: { scope: 'property', rows: upload.countries.rows },
  devices: { scope: 'property', rows: upload.devices.rows },
  warnings: [],
  page: null,
}

const operations = createGscdumpV1Protocol().surfaces.partner.operations

describe('generative AI report upload body', () => {
  it('accepts the normalized body', () => {
    expect(generativeAiReportUploadV1Schema.parse(upload)).toEqual(upload)
  })

  it.each([
    ['a reported zero, which must read as zero or unavailable', { chart: { rows: [{ date: '2026-11-03', impressions: reported(0) }, upload.chart.rows[1]] } }],
    ['a total field', { total: 213 }],
    ['a Chart gap', { chart: { rows: [upload.chart.rows[0], { date: '2026-11-05', impressions: zero }] }, window: { ...upload.window, endDate: '2026-11-05' } }],
    ['a window that differs from Chart', { window: { ...upload.window, startDate: '2026-11-01' } }],
    ['a duplicate page', { pages: { ...upload.pages, rows: [upload.pages.rows[0], upload.pages.rows[0]] } }],
    ['a duplicate country', { countries: { rows: [upload.countries.rows[0], upload.countries.rows[0]] } }],
    ['a duplicate device', { devices: { rows: [upload.devices.rows[0], upload.devices.rows[0]] } }],
    ['a Discover report', { report: 'discover' }],
    ['a country code that is not lowercase alpha-3', { countries: { rows: [{ countryName: 'Spain', countryCode: 'ES', impressions: zero }] } }],
    ['an unknown device', { devices: { rows: [{ device: 'watch', impressions: zero }] } }],
    ['more than 1,000 Pages rows', { pages: { ...upload.pages, rows: Array.from({ length: 1001 }, (_, index) => ({ url: `https://gscdump.com/${index}`, impressions: zero })) } }],
    ['a short source hash', { sourceSha256: 'abc' }],
  ])('refuses %s', (_name, override) => {
    expect(generativeAiReportUploadV1Schema.safeParse({ ...upload, ...override }).success).toBe(false)
  })
})

describe('getSiteGenerativeAiReport', () => {
  const response = operations.getSiteGenerativeAiReport.responses[200]

  it('returns the empty and available states, each with its scope labels', () => {
    expect(response.producer.parse({ data: { _tag: 'empty', report: 'search', reason: 'no-upload' }, meta }).data._tag).toBe('empty')
    expect(response.producer.parse({ data: available, meta }).data).toEqual(available)
  })

  it('never lets a producer send a total, a reported zero, or a Discover report', () => {
    expect(response.producer.safeParse({ data: { ...available, total: 213 }, meta }).success).toBe(false)
    expect(response.producer.safeParse({ data: { ...available, chart: { scope: 'property', rows: [{ date: '2026-11-03', impressions: reported(0) }] } }, meta }).success).toBe(false)
    expect(response.producer.safeParse({ data: { ...available, report: 'discover' }, meta }).success).toBe(false)
  })

  it('never lets Chart claim the registered host scope or Pages claim the property scope', () => {
    expect(response.producer.safeParse({ data: { ...available, chart: { ...available.chart, scope: 'registered-host' } }, meta }).success).toBe(false)
    expect(response.producer.safeParse({ data: { ...available, pages: { ...available.pages, scope: 'property' } }, meta }).success).toBe(false)
  })

  it('states an exact URL read as listed or not listed, with rows on the other scheme', () => {
    const otherSchemeRows = [{ url: 'http://gscdump.com/', impressions: reported(2) }]
    const listed = { _tag: 'listed', url: 'https://gscdump.com/', impressions: reported(15), otherSchemeRows }
    const notListed = { _tag: 'not-listed', otherSchemeRows }
    expect(response.producer.parse({ data: { ...available, page: listed }, meta }).data).toMatchObject({ page: listed })
    expect(response.producer.parse({ data: { ...available, page: notListed }, meta }).data).toMatchObject({ page: notListed })
  })

  it('accepts an optional upload and an exact page URL', () => {
    const query = { uploadId: 'gau_01', pageUrl: 'https://gscdump.com/' }
    expect(operations.getSiteGenerativeAiReport.request.query.parse(query)).toEqual(query)
    expect(operations.getSiteGenerativeAiReport.request.query.parse({})).toEqual({})
    expect(operations.getSiteGenerativeAiReport.request.query.safeParse({ pageUrl: '/about' }).success).toBe(false)
    expect(operations.getSiteGenerativeAiReport.request.query.safeParse({ uploadId: '../x' }).success).toBe(false)
  })
})

describe('upload operations', () => {
  const error = (code: string) => ({ error: { code, message: 'x', requestId: 'req_01', retryable: false, details: {} } })

  it('returns the receipt with warnings, unmapped countries, and row counts', () => {
    const data = {
      uploadId: 'gau_01',
      deduped: true,
      warnings: [{ _tag: 'filename_site_mismatch', prefix: 'other.com', host: 'gscdump.com' }],
      unmappedCountries: ['Atlantis'],
      window: upload.window,
      rowCounts: { chart: 2, pages: 2, countries: 1, devices: 1 },
    }
    expect(operations.createSiteGenerativeAiReportUpload.responses[200].producer.parse({ data, meta }).data).toEqual(data)
  })

  it('declares the refusal for an export with no rows on the registered host', () => {
    const { errorResponse } = operations.createSiteGenerativeAiReportUpload
    expect(errorResponse.producer.safeParse(error('no_registered_host_rows')).success).toBe(true)
    expect(errorResponse.producer.safeParse(error('rate_limited')).success).toBe(true)
    expect(operations.getSiteGenerativeAiReport.errorResponse.producer.safeParse(error('no_registered_host_rows')).success).toBe(false)
  })

  it('declares a named not found error for a removed or unknown upload', () => {
    const code = 'generative_ai_report_upload_not_found'
    expect(operations.removeSiteGenerativeAiReportUpload.errorResponse.producer.safeParse(error(code)).success).toBe(true)
    expect(operations.getSiteGenerativeAiReport.errorResponse.producer.safeParse(error(code)).success).toBe(true)
  })

  it('lists each upload with its source, window, and coverage', () => {
    const data = { uploads: [{
      uploadId: 'gau_01',
      report: 'search',
      sourceFilename: upload.sourceFilename,
      sourceSha256: upload.sourceSha256,
      parserVersion: 1,
      window: upload.window,
      uploadedAt: '2026-11-07T00:00:00.000Z',
      pagesCoverage: { _tag: 'complete' },
      offHostRows: 0,
      offHostImpressions: 0,
      warnings: [],
      rowCounts: { chart: 2, pages: 2, countries: 1, devices: 1 },
    }] }
    expect(operations.listSiteGenerativeAiReportUploads.responses[200].producer.parse({ data, meta }).data).toEqual(data)
  })
})

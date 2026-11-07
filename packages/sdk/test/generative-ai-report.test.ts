import type { GenerativeAiReportParseInput } from '@gscdump/sdk/generative-ai-report'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { generativeAiReportUploadV1Schema } from '@gscdump/contracts/v1/http'
import { parseGenerativeAiReportExport } from '@gscdump/sdk/generative-ai-report'
import { strToU8, zipSync } from 'fflate'
import { describe, expect, it } from 'vitest'

const REAL_FILENAME = 'gscdump.com-Performance-on-Search-Generative-AI-Features-2026-11-07.zip'
const FILE_NAMES = ['Chart.csv', 'Pages.csv', 'Countries.csv', 'Devices.csv', 'Filters.csv'] as const

const realFiles = Object.fromEntries(FILE_NAMES.map(name => [
  name,
  readFileSync(new URL(`./fixtures/generative-ai-report/${name}`, import.meta.url), 'utf8'),
])) as Record<typeof FILE_NAMES[number], string>

function zipOf(files: Record<string, string | Uint8Array>): Uint8Array {
  return zipSync(Object.fromEntries(Object.entries(files).map(([name, content]) => [
    name,
    typeof content === 'string' ? strToU8(content) : content,
  ])))
}

function report(overrides: Partial<Record<typeof FILE_NAMES[number], string>> = {}): Uint8Array {
  return zipOf({ ...realFiles, ...overrides })
}

function parse(input: Partial<GenerativeAiReportParseInput> = {}) {
  return parseGenerativeAiReportExport({
    bytes: report(),
    filename: REAL_FILENAME,
    site: { registeredHost: 'gscdump.com', gscProperty: 'sc-domain:gscdump.com' },
    now: new Date('2026-11-07T00:00:00.000Z'),
    ...input,
  })
}

async function parsedUpload(input: Partial<GenerativeAiReportParseInput> = {}) {
  const result = await parse(input)
  if (!result.ok)
    throw new Error(`expected Ok, got ${JSON.stringify(result.error)}`)
  return result.value
}

async function parseError(input: Partial<GenerativeAiReportParseInput> = {}) {
  const result = await parse(input)
  if (result.ok)
    throw new Error('expected Err, got Ok')
  return result.error
}

function reportedSum(rows: { impressions: { _tag: string, value?: number } }[]): number {
  return rows.reduce((sum, row) => sum + (row.impressions.value ?? 0), 0)
}

describe('parseGenerativeAiReportExport with the real gscdump.com export', () => {
  it('takes the date range from Chart.csv and sums 213 over 92 days', async () => {
    const { upload } = await parsedUpload()
    expect(upload.window).toEqual({ startDate: '2026-08-05', endDate: '2026-11-04', label: 'Last 3 months' })
    expect(upload.chart.rows).toHaveLength(92)
    expect(reportedSum(upload.chart.rows)).toBe(213)
  })

  it('reads each of the 58 zero days as zero or unavailable', async () => {
    const { upload } = await parsedUpload()
    const zeroDays = upload.chart.rows.filter(row => row.impressions._tag === 'zero-or-unavailable')
    expect(zeroDays).toHaveLength(58)
    expect(upload.chart.rows[0]).toEqual({ date: '2026-08-05', impressions: { _tag: 'zero-or-unavailable' } })
    expect(upload.chart.rows[4]).toEqual({ date: '2026-08-09', impressions: { _tag: 'reported', value: 1 } })
  })

  it('keeps 21 Pages rows summing 224, above the Chart sum, with no refusal', async () => {
    const { upload } = await parsedUpload()
    expect(upload.pages.rows).toHaveLength(21)
    expect(reportedSum(upload.pages.rows)).toBe(224)
    expect(upload.pages.coverage).toEqual({ _tag: 'complete' })
    expect(upload.pages.offHostRows).toBe(0)
    expect(upload.pages.offHostImpressions).toBe(0)
  })

  it('stores http rows verbatim, apart from their https rows', async () => {
    const { upload } = await parsedUpload()
    const byUrl = new Map(upload.pages.rows.map(row => [row.url, row.impressions]))
    expect(byUrl.get('http://gscdump.com/')).toEqual({ _tag: 'reported', value: 2 })
    expect(byUrl.get('https://gscdump.com/')).toEqual({ _tag: 'reported', value: 15 })
    expect(byUrl.get('http://gscdump.com/learn-google-search-console/limits/16-month-data-retention')).toEqual({ _tag: 'reported', value: 13 })
    expect(upload.pages.rows.filter(row => row.url.startsWith('http://'))).toHaveLength(2)
  })

  it('maps the 3 devices to the analytics enum', async () => {
    const { upload } = await parsedUpload()
    expect(upload.devices.rows).toEqual([
      { device: 'desktop', impressions: { _tag: 'reported', value: 196 } },
      { device: 'mobile', impressions: { _tag: 'reported', value: 16 } },
      { device: 'tablet', impressions: { _tag: 'reported', value: 1 } },
    ])
  })

  it('maps all 51 countries, including Turkey and Hong Kong', async () => {
    const { upload, unmappedCountries } = await parsedUpload()
    expect(upload.countries.rows).toHaveLength(51)
    expect(reportedSum(upload.countries.rows)).toBe(213)
    expect(unmappedCountries).toEqual([])
    const codes = new Map(upload.countries.rows.map(row => [row.countryName, row.countryCode]))
    expect(codes.get('Turkey')).toBe('tur')
    expect(codes.get('Hong Kong')).toBe('hkg')
    expect(codes.get('United States')).toBe('usa')
    expect(codes.get('South Korea')).toBe('kor')
    expect(codes.get('Czechia')).toBe('cze')
  })

  it('records the source hash, filename, and raw filters with no warnings', async () => {
    const bytes = report()
    const { upload } = await parsedUpload({ bytes })
    expect(upload.sourceSha256).toBe(createHash('sha256').update(bytes).digest('hex'))
    expect(upload.sourceFilename).toBe(REAL_FILENAME)
    expect(upload.searchTypeFilter).toBe('Web (text-based)')
    expect(upload.parserVersion).toBe(1)
    expect(upload.warnings).toEqual([])
  })

  it('produces the exact body that the create operation accepts', async () => {
    const { upload } = await parsedUpload()
    expect(generativeAiReportUploadV1Schema.parse(upload)).toEqual(upload)
  })
})

describe('site identity', () => {
  it('warns on a filename for another host and still parses', async () => {
    const { upload } = await parsedUpload({ filename: 'other.com-Performance-on-Search-Generative-AI-Features-2026-11-07.zip' })
    expect(upload.warnings).toEqual([{ _tag: 'filename_site_mismatch', prefix: 'other.com', host: 'gscdump.com' }])
    expect(upload.pages.rows).toHaveLength(21)
  })

  it('warns on a renamed file and still parses', async () => {
    const { upload } = await parsedUpload({ filename: 'report (1).zip' })
    expect(upload.warnings).toEqual([{ _tag: 'filename_unrecognized', filename: 'report (1).zip' }])
  })

  it('accepts a parent domain prefix and a property prefix with no warning', async () => {
    const pages = 'Top pages,Impressions\nhttps://blog.gscdump.com/,5'
    const parent = await parsedUpload({ bytes: report({ 'Pages.csv': pages }), site: { registeredHost: 'blog.gscdump.com', gscProperty: null } })
    expect(parent.upload.warnings).toEqual([])
    const property = await parsedUpload({
      bytes: report({ 'Pages.csv': pages }),
      filename: 'www.example.com-Performance-on-Search-Generative-AI-Features-2026-11-07.zip',
      site: { registeredHost: 'blog.gscdump.com', gscProperty: 'https://www.example.com/' },
    })
    expect(property.upload.warnings).toEqual([])
  })

  it('refuses an export with Pages rows but none on the registered host', async () => {
    expect(await parseError({ site: { registeredHost: 'nuxtseo.com', gscProperty: null } })).toEqual({
      _tag: 'no_registered_host_rows',
      host: 'nuxtseo.com',
      pageRows: 21,
    })
  })

  it('keeps on-host rows only and counts the rest, ignoring the scheme', async () => {
    const pages = 'Top pages,Impressions\nhttp://gscdump.com/a,4\nhttps://docs.gscdump.com/b,7\nhttps://other.com/c,0'
    const { upload } = await parsedUpload({ bytes: report({ 'Pages.csv': pages }) })
    expect(upload.pages.rows).toEqual([{ url: 'http://gscdump.com/a', impressions: { _tag: 'reported', value: 4 } }])
    expect(upload.pages.offHostRows).toBe(2)
    expect(upload.pages.offHostImpressions).toBe(7)
  })

  it('warns instead of refusing at the 1,000 row cap, because the host can sit below the cutoff', async () => {
    const rows = Array.from({ length: 1000 }, (_, index) => `https://other.com/${index},1`).join('\n')
    const { upload } = await parsedUpload({ bytes: report({ 'Pages.csv': `Top pages,Impressions\n${rows}` }) })
    expect(upload.pages.coverage).toEqual({ _tag: 'truncated', limit: 1000 })
    expect(upload.pages.rows).toEqual([])
    expect(upload.pages.offHostRows).toBe(1000)
    expect(upload.warnings).toEqual([{ _tag: 'no_registered_host_rows_at_row_cap', host: 'gscdump.com' }])
  })

  it('does not refuse an export whose Pages tab has no rows', async () => {
    const { upload } = await parsedUpload({ bytes: report({ 'Pages.csv': 'Top pages,Impressions' }) })
    expect(upload.pages.rows).toEqual([])
    expect(upload.warnings).toEqual([])
  })
})

describe('field rules', () => {
  it('keeps an unmapped country raw, with a null code, and lists it', async () => {
    const countries = 'Country,Impressions\nAtlantis,3\nconstructor,2\nTurkey,1'
    const { upload, unmappedCountries } = await parsedUpload({ bytes: report({ 'Countries.csv': countries }) })
    expect(upload.countries.rows.slice(0, 2)).toEqual([
      { countryName: 'Atlantis', countryCode: null, impressions: { _tag: 'reported', value: 3 } },
      { countryName: 'constructor', countryCode: null, impressions: { _tag: 'reported', value: 2 } },
    ])
    expect(unmappedCountries).toEqual(['Atlantis', 'constructor'])
  })

  it('maps the alternative names of Turkey and Hong Kong', async () => {
    const countries = 'Country,Impressions\nTürkiye,3\nHong Kong SAR China,2'
    const { upload, unmappedCountries } = await parsedUpload({ bytes: report({ 'Countries.csv': countries }) })
    expect(upload.countries.rows.map(row => row.countryCode)).toEqual(['tur', 'hkg'])
    expect(unmappedCountries).toEqual([])
  })

  it('reads ~ and - as zero or unavailable', async () => {
    const devices = 'Device,Impressions\nDesktop,~\nMobile,-\nTablet,0'
    const { upload } = await parsedUpload({ bytes: report({ 'Devices.csv': devices }) })
    expect(upload.devices.rows.map(row => row.impressions._tag)).toEqual(['zero-or-unavailable', 'zero-or-unavailable', 'zero-or-unavailable'])
  })

  it('accepts a quoted URL that holds a comma, an escaped quote, CRLF, and a trailing newline', async () => {
    const pages = 'Top pages,Impressions\r\n"https://gscdump.com/a,b",3\r\n"https://gscdump.com/say""hi",2\r\n'
    const { upload } = await parsedUpload({ bytes: report({ 'Pages.csv': pages }) })
    expect(upload.pages.rows.map(row => row.url)).toEqual(['https://gscdump.com/a,b', 'https://gscdump.com/say"hi'])
  })
})

describe('refusals name what broke', () => {
  it.each([
    ['a Chart gap', { 'Chart.csv': 'Date,Impressions\n2026-08-05,1\n2026-08-07,1' }, { _tag: 'invalid_chart_dates', reason: 'not_consecutive', found: '2026-08-07' }],
    ['a duplicate Chart date', { 'Chart.csv': 'Date,Impressions\n2026-08-05,1\n2026-08-05,1' }, { _tag: 'invalid_chart_dates', reason: 'not_consecutive', found: '2026-08-05' }],
    ['a Chart date out of order', { 'Chart.csv': 'Date,Impressions\n2026-08-06,1\n2026-08-05,1' }, { _tag: 'invalid_chart_dates', reason: 'not_consecutive', found: '2026-08-05' }],
    ['an impossible Chart date', { 'Chart.csv': 'Date,Impressions\n2026-02-30,1' }, { _tag: 'invalid_chart_dates', reason: 'not_iso', found: '2026-02-30' }],
    ['a Chart date in the future', { 'Chart.csv': 'Date,Impressions\n2026-11-08,1' }, { _tag: 'invalid_chart_dates', reason: 'future', found: '2026-11-08' }],
    ['a Chart with no rows', { 'Chart.csv': 'Date,Impressions' }, { _tag: 'invalid_chart_dates', reason: 'empty', found: null }],
    ['a formatted number', { 'Devices.csv': 'Device,Impressions\nDesktop,"1,000"' }, { _tag: 'invalid_impressions', file: 'Devices.csv', found: '1,000' }],
    ['a negative number', { 'Devices.csv': 'Device,Impressions\nDesktop,-3' }, { _tag: 'invalid_impressions', file: 'Devices.csv', found: '-3' }],
    ['a decimal number', { 'Pages.csv': 'Top pages,Impressions\nhttps://gscdump.com/,1.5' }, { _tag: 'invalid_impressions', file: 'Pages.csv', found: '1.5' }],
    ['a relative URL', { 'Pages.csv': 'Top pages,Impressions\n/about,1' }, { _tag: 'invalid_page_url', found: '/about' }],
    ['another URL scheme', { 'Pages.csv': 'Top pages,Impressions\nftp://gscdump.com/,1' }, { _tag: 'invalid_page_url', found: 'ftp://gscdump.com/' }],
    ['an unknown device', { 'Devices.csv': 'Device,Impressions\nWatch,1' }, { _tag: 'invalid_device', found: 'Watch' }],
    ['a duplicate page', { 'Pages.csv': 'Top pages,Impressions\nhttps://gscdump.com/,1\nhttps://gscdump.com/,2' }, { _tag: 'duplicate_rows', file: 'Pages.csv', found: 'https://gscdump.com/' }],
    ['a duplicate country', { 'Countries.csv': 'Country,Impressions\nSpain,1\nSpain,2' }, { _tag: 'duplicate_rows', file: 'Countries.csv', found: 'Spain' }],
    ['a renamed header', { 'Pages.csv': 'Page,Impressions\nhttps://gscdump.com/,1' }, { _tag: 'unrecognized_headers', file: 'Pages.csv', expected: ['Top pages', 'Impressions'], found: ['Page', 'Impressions'] }],
    ['an empty tab', { 'Devices.csv': '' }, { _tag: 'unrecognized_headers', file: 'Devices.csv', expected: ['Device', 'Impressions'], found: [] }],
    ['a translated header, from a non-English UI', { 'Chart.csv': 'Fecha,Impresiones\n2026-08-05,1' }, { _tag: 'unrecognized_headers', file: 'Chart.csv', expected: ['Date', 'Impressions'], found: ['Fecha', 'Impresiones'] }],
    ['a translated filter sheet, from a non-English UI', { 'Filters.csv': 'Filtro,Valor\nTipo de busqueda,Web' }, { _tag: 'unrecognized_headers', file: 'Filters.csv', expected: ['Filter', 'Value'], found: ['Filtro', 'Valor'] }],
    ['a translated filter name', { 'Filters.csv': 'Filter,Value\nTipo de busqueda,Web (text-based)\nDate,Last 3 months' }, { _tag: 'unsupported_filter', filter: 'Tipo de busqueda', value: 'Web (text-based)' }],
    ['the Multimodal filter', { 'Filters.csv': 'Filter,Value\nSearch type,Multimodal\nDate,Last 3 months' }, { _tag: 'unsupported_filter', filter: 'Search type', value: 'Multimodal' }],
    ['a translated search type value', { 'Filters.csv': 'Filter,Value\nSearch type,Web (solo texto)\nDate,Last 3 months' }, { _tag: 'unsupported_filter', filter: 'Search type', value: 'Web (solo texto)' }],
    ['an extra URL filter', { 'Filters.csv': 'Filter,Value\nSearch type,Web (text-based)\nDate,Last 3 months\nPage,https://gscdump.com/' }, { _tag: 'unsupported_filter', filter: 'Page', value: 'https://gscdump.com/' }],
    ['a repeated filter', { 'Filters.csv': 'Filter,Value\nSearch type,Web (text-based)\nSearch type,Web (text-based)\nDate,Last 3 months' }, { _tag: 'unsupported_filter', filter: 'Search type', value: 'Web (text-based)' }],
    ['a missing Date filter', { 'Filters.csv': 'Filter,Value\nSearch type,Web (text-based)' }, { _tag: 'unsupported_filter', filter: 'Date', value: null }],
    ['classic Chart columns', { 'Chart.csv': 'Date,Clicks,Impressions,CTR,Position\n2026-08-05,1,2,50%,3' }, { _tag: 'not_generative_ai_report', file: 'Chart.csv', found: ['Date', 'Clicks', 'Impressions', 'CTR', 'Position'] }],
    ['a query column', { 'Pages.csv': 'Top queries,Impressions\nfoo,1' }, { _tag: 'not_generative_ai_report', file: 'Pages.csv', found: ['Top queries', 'Impressions'] }],
    ['an extra field', { 'Devices.csv': 'Device,Impressions\nDesktop,1,2' }, { _tag: 'invalid_encoding', file: 'Devices.csv', reason: 'malformed_csv', line: 2 }],
    ['an unclosed quote', { 'Pages.csv': 'Top pages,Impressions\n"https://gscdump.com/,1' }, { _tag: 'invalid_encoding', file: 'Pages.csv', reason: 'malformed_csv', line: 2 }],
    ['a control character', { 'Pages.csv': 'Top pages,Impressions\nhttps://gscdump.com/\u0007,1' }, { _tag: 'invalid_encoding', file: 'Pages.csv', reason: 'control_character', line: null }],
  ] as const)('refuses %s', async (_name, overrides, expected) => {
    expect(await parseError({ bytes: report(overrides) })).toEqual(expected)
  })

  it('refuses bytes that are not UTF-8', async () => {
    const bytes = zipOf({ ...realFiles, 'Pages.csv': new Uint8Array([0x54, 0xFF, 0x70]) })
    expect(await parseError({ bytes })).toEqual({ _tag: 'invalid_encoding', file: 'Pages.csv', reason: 'not_utf8', line: null })
  })

  it('refuses the classic export by its Queries.csv entry', async () => {
    const bytes = zipOf({ ...realFiles, 'Queries.csv': 'Top queries,Clicks\nfoo,1' })
    expect(await parseError({ bytes })).toEqual({ _tag: 'not_generative_ai_report', file: 'Queries.csv', found: [] })
  })

  it('refuses more than 1,000 rows in a tab', async () => {
    const rows = Array.from({ length: 1001 }, (_, index) => `https://gscdump.com/${index},1`).join('\n')
    expect(await parseError({ bytes: report({ 'Pages.csv': `Top pages,Impressions\n${rows}` }) })).toEqual({
      _tag: 'too_many_rows',
      file: 'Pages.csv',
      limit: 1000,
      found: 1001,
    })
  })

  it('refuses a Discover filename', async () => {
    expect(await parseError({ filename: 'gscdump.com-Performance-on-Discover-Generative-AI-Features-2026-11-07.zip' })).toEqual({
      _tag: 'discover_not_supported',
      filename: 'gscdump.com-Performance-on-Discover-Generative-AI-Features-2026-11-07.zip',
    })
  })

  it('does not read Discover in a Site name as the Discover report', async () => {
    const { upload } = await parsedUpload({
      filename: 'discover.gscdump.com-Performance-on-Search-Generative-AI-Features-2026-11-07.zip',
    })
    expect(upload.warnings).toEqual([{ _tag: 'filename_site_mismatch', prefix: 'discover.gscdump.com', host: 'gscdump.com' }])
  })
})

/** Offset of the only central directory header for this entry name. */
function centralHeaderOffset(bytes: Uint8Array, name: string): number {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const target = strToU8(name)
  for (let offset = 0; offset < bytes.length - 46; offset++) {
    if (view.getUint32(offset, true) !== 0x02014B50 || view.getUint16(offset + 28, true) !== target.length)
      continue
    if (target.every((byte, index) => bytes[offset + 46 + index] === byte))
      return offset
  }
  throw new Error(`no central header for ${name}`)
}

function localHeaderOffset(bytes: Uint8Array, name: string): number {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  return view.getUint32(centralHeaderOffset(bytes, name) + 42, true)
}

describe('the untrusted zip', () => {
  it('refuses bytes that are not a zip', async () => {
    expect(await parseError({ bytes: strToU8('Date,Impressions\n2026-08-05,1') })).toMatchObject({ _tag: 'not_a_report_zip' })
    expect(await parseError({ bytes: new Uint8Array() })).toMatchObject({ _tag: 'not_a_report_zip' })
  })

  it('refuses an archive above 2 MB before it reads an entry', async () => {
    expect(await parseError({ bytes: new Uint8Array(2 * 1024 * 1024 + 1) })).toEqual({
      _tag: 'file_too_large',
      scope: 'archive',
      file: null,
      limit: 2 * 1024 * 1024,
      found: 2 * 1024 * 1024 + 1,
    })
  })

  it.each([
    ['an extra entry', { ...realFiles, 'Extra.csv': 'a,b' }],
    ['a path traversal entry', { ...realFiles, '../evil.csv': 'a,b' }],
    ['an absolute path entry', { ...realFiles, '/etc/evil.csv': 'a,b' }],
    ['a backslash path entry', { ...realFiles, '..\\evil.csv': 'a,b' }],
    ['a directory entry', { ...realFiles, 'nested/': new Uint8Array() }],
    ['a nested archive', { ...realFiles, 'inner.zip': zipOf({ 'Chart.csv': realFiles['Chart.csv'] }) }],
  ])('refuses %s', async (_name, files) => {
    expect(await parseError({ bytes: zipOf(files) })).toMatchObject({ _tag: 'unexpected_entries', reason: 'names' })
  })

  it('refuses an allowlisted file that sits inside a directory', async () => {
    const { 'Chart.csv': chart, ...rest } = realFiles
    const error = await parseError({ bytes: zipOf({ ...rest, 'x/Chart.csv': chart }) })
    expect(error).toMatchObject({ _tag: 'unexpected_entries', reason: 'names', missing: ['Chart.csv'] })
  })

  it('refuses a missing file and names it', async () => {
    const { 'Filters.csv': _filters, ...rest } = realFiles
    expect(await parseError({ bytes: zipOf(rest) })).toEqual({
      _tag: 'unexpected_entries',
      reason: 'names',
      found: ['Chart.csv', 'Pages.csv', 'Countries.csv', 'Devices.csv'],
      missing: ['Filters.csv'],
    })
  })

  it('refuses a duplicate entry name', async () => {
    const bytes = report()
    const header = centralHeaderOffset(bytes, 'Filters.csv')
    bytes.set(strToU8('Devices.csv'), header + 46)
    expect(await parseError({ bytes })).toMatchObject({ _tag: 'unexpected_entries', reason: 'names', missing: ['Filters.csv'] })
  })

  it('refuses an encrypted entry', async () => {
    const bytes = report()
    bytes[centralHeaderOffset(bytes, 'Chart.csv') + 8]! |= 0x01
    expect(await parseError({ bytes })).toEqual({ _tag: 'unexpected_entries', reason: 'encrypted', found: ['Chart.csv'], missing: [] })
  })

  it('refuses an unknown compression method', async () => {
    const bytes = report()
    bytes[centralHeaderOffset(bytes, 'Chart.csv') + 10] = 99
    expect(await parseError({ bytes })).toEqual({ _tag: 'unexpected_entries', reason: 'compression', found: ['Chart.csv'], missing: [] })
  })

  it('refuses a central name that disagrees with the local header', async () => {
    const bytes = report()
    bytes.set(strToU8('../hart.csv'.slice(0, 9)), localHeaderOffset(bytes, 'Chart.csv') + 30)
    expect(await parseError({ bytes })).toMatchObject({ _tag: 'not_a_report_zip', reason: 'entry_mismatch' })
  })

  it('refuses an entry that declares more than 4 MB', async () => {
    const bytes = zipOf({ ...realFiles, 'Pages.csv': new Uint8Array(4 * 1024 * 1024 + 1) })
    expect(await parseError({ bytes })).toEqual({
      _tag: 'file_too_large',
      scope: 'entry',
      file: 'Pages.csv',
      limit: 4 * 1024 * 1024,
      found: 4 * 1024 * 1024 + 1,
    })
  })

  it('refuses entries that declare more than 8 MB in total', async () => {
    const big = new Uint8Array(3 * 1024 * 1024)
    const bytes = zipOf({ 'Chart.csv': big, 'Pages.csv': big, 'Countries.csv': big, 'Devices.csv': realFiles['Devices.csv'], 'Filters.csv': realFiles['Filters.csv'] })
    expect(await parseError({ bytes })).toMatchObject({ _tag: 'file_too_large', scope: 'total', file: null, limit: 8 * 1024 * 1024 })
  })

  it('stops inflating an entry that lies about its size', async () => {
    const bytes = zipOf({ ...realFiles, 'Pages.csv': new Uint8Array(32 * 1024 * 1024) })
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    view.setUint32(centralHeaderOffset(bytes, 'Pages.csv') + 24, 100, true)
    const error = await parseError({ bytes })
    expect(error).toMatchObject({ _tag: 'file_too_large', scope: 'entry', file: 'Pages.csv', limit: 4 * 1024 * 1024 })
    expect((error as { found: number }).found).toBeGreaterThan(4 * 1024 * 1024)
  })

  it('refuses an entry whose real size differs from its declared size', async () => {
    const bytes = report()
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    const header = centralHeaderOffset(bytes, 'Devices.csv')
    view.setUint32(header + 24, view.getUint32(header + 24, true) + 1, true)
    expect(await parseError({ bytes })).toMatchObject({ _tag: 'not_a_report_zip', reason: 'size_mismatch', file: 'Devices.csv' })
  })

  it('refuses an entry whose checksum fails, so a flipped digit cannot store a wrong count', async () => {
    const stored = report()
    const view = new DataView(stored.buffer, stored.byteOffset, stored.byteLength)
    const header = centralHeaderOffset(stored, 'Devices.csv')
    view.setUint32(header + 16, view.getUint32(header + 16, true) ^ 1, true)
    expect(await parseError({ bytes: stored })).toMatchObject({ _tag: 'not_a_report_zip', reason: 'checksum_mismatch', file: 'Devices.csv' })
  })

  it('refuses a truncated archive', async () => {
    expect(await parseError({ bytes: report().slice(0, 200) })).toMatchObject({ _tag: 'not_a_report_zip' })
  })

  it('refuses a corrupt compressed stream', async () => {
    const bytes = report()
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    const local = localHeaderOffset(bytes, 'Chart.csv')
    const dataStart = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true)
    bytes.fill(0xFF, dataStart, dataStart + 20)
    expect(await parseError({ bytes })).toMatchObject({ _tag: 'not_a_report_zip', file: 'Chart.csv' })
  })
})

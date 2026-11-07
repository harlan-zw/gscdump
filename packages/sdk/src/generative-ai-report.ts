import type { GenerativeAiImpressionsV1, GenerativeAiReportUploadV1, GenerativeAiReportUploadWarningV1 } from '@gscdump/contracts/v1/http'
import type { Err, Ok, Result } from 'gscdump/result'
import { Inflate } from 'fflate'
import { err, ok } from 'gscdump/result'
import { generativeAiReportCountryCode } from './generative-ai-report-countries'

/** Bump this when the same bytes can parse to different rows. */
export const GENERATIVE_AI_REPORT_PARSER_VERSION = 1

const MB = 1024 * 1024
const MAX_ARCHIVE_BYTES = 2 * MB
const MAX_ENTRY_BYTES = 4 * MB
const MAX_TOTAL_BYTES = 8 * MB
const MAX_ROWS = 1000
const MAX_CENTRAL_ENTRIES = 64
const INFLATE_CHUNK_BYTES = 4096
const SEARCH_FILENAME_MARKER = '-Performance-on-Search-Generative-AI-Features-'
const SEARCH_TYPE_WEB = 'Web (text-based)'

const FILES = {
  'Chart.csv': ['Date', 'Impressions'],
  'Pages.csv': ['Top pages', 'Impressions'],
  'Countries.csv': ['Country', 'Impressions'],
  'Devices.csv': ['Device', 'Impressions'],
  'Filters.csv': ['Filter', 'Value'],
} as const satisfies Record<string, readonly [string, string]>

type ReportFile = keyof typeof FILES
const FILE_NAMES = Object.keys(FILES) as ReportFile[]

const DEVICES = { Desktop: 'desktop', Mobile: 'mobile', Tablet: 'tablet' } as const

export type GenerativeAiReportParseError
  = | { _tag: 'not_a_report_zip', reason: 'no_end_record' | 'unsupported_layout' | 'entry_mismatch' | 'corrupt_stream' | 'size_mismatch' | 'checksum_mismatch', file: string | null }
    | { _tag: 'file_too_large', scope: 'archive' | 'entry' | 'total', file: string | null, limit: number, found: number }
    | { _tag: 'unexpected_entries', reason: 'names' | 'encrypted' | 'compression', found: string[], missing: string[] }
    | { _tag: 'invalid_encoding', file: ReportFile, reason: 'not_utf8' | 'control_character' | 'malformed_csv', line: number | null }
    | { _tag: 'unrecognized_headers', file: ReportFile, expected: readonly string[], found: string[] }
    | { _tag: 'not_generative_ai_report', file: string, found: string[] }
    | { _tag: 'unsupported_filter', filter: string, value: string | null }
    | { _tag: 'discover_not_supported', filename: string }
    | { _tag: 'invalid_chart_dates', reason: 'empty' | 'not_iso' | 'not_consecutive' | 'future', found: string | null }
    | { _tag: 'invalid_impressions', file: ReportFile, found: string }
    | { _tag: 'invalid_device', found: string }
    | { _tag: 'invalid_page_url', found: string }
    | { _tag: 'duplicate_rows', file: ReportFile, found: string }
    | { _tag: 'too_many_rows', file: ReportFile, limit: number, found: number }
    | { _tag: 'no_registered_host_rows', host: string, pageRows: number }

export interface ParsedGenerativeAiReport {
  /** The exact body for `createSiteGenerativeAiReportUpload`. */
  upload: GenerativeAiReportUploadV1
  /** Country names with no alpha-3 code. Each row keeps its raw name and a null code. */
  unmappedCountries: string[]
}

export type GenerativeAiReportParseResult = Result<ParsedGenerativeAiReport, GenerativeAiReportParseError>

export interface GenerativeAiReportParseInput {
  bytes: Uint8Array
  filename: string
  /** The Site that the uploader selected. Nothing inside the zip names a Site. */
  site: { registeredHost: string, gscProperty: string | null }
  /** Refuses Chart dates after this day, in UTC. */
  now: Date
}

// Zip reading. Only the central directory decides what an archive holds, and each
// entry must agree with its local header, so two readers cannot see different files.

interface ZipEntry {
  name: string
  flags: number
  method: number
  checksum: number
  compressedSize: number
  size: number
  localOffset: number
}

function readEndRecordOffset(view: DataView): number | null {
  const earliest = Math.max(0, view.byteLength - 22 - 0xFFFF)
  for (let offset = view.byteLength - 22; offset >= earliest; offset--) {
    if (view.getUint32(offset, true) === 0x06054B50 && offset + 22 + view.getUint16(offset + 20, true) === view.byteLength)
      return offset
  }
  return null
}

function readCentralDirectory(bytes: Uint8Array): Ok<ZipEntry[]> | Err<GenerativeAiReportParseError> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const end = readEndRecordOffset(view)
  if (end === null)
    return err({ _tag: 'not_a_report_zip', reason: 'no_end_record', file: null })
  const entryCount = view.getUint16(end + 10, true)
  const directoryOffset = view.getUint32(end + 16, true)
  const isMultiDisk = view.getUint16(end + 4, true) !== 0 || view.getUint16(end + 6, true) !== 0 || view.getUint16(end + 8, true) !== entryCount
  if (isMultiDisk || entryCount === 0xFFFF || directoryOffset === 0xFFFFFFFF)
    return err({ _tag: 'not_a_report_zip', reason: 'unsupported_layout', file: null })

  const decoder = new TextDecoder()
  const entries: ZipEntry[] = []
  let offset = directoryOffset
  for (let index = 0; index < Math.min(entryCount, MAX_CENTRAL_ENTRIES); index++) {
    if (offset + 46 > bytes.length || view.getUint32(offset, true) !== 0x02014B50)
      return err({ _tag: 'not_a_report_zip', reason: 'unsupported_layout', file: null })
    const nameLength = view.getUint16(offset + 28, true)
    const nameEnd = offset + 46 + nameLength
    if (nameEnd > bytes.length)
      return err({ _tag: 'not_a_report_zip', reason: 'unsupported_layout', file: null })
    entries.push({
      name: decoder.decode(bytes.subarray(offset + 46, nameEnd)),
      flags: view.getUint16(offset + 8, true),
      method: view.getUint16(offset + 10, true),
      checksum: view.getUint32(offset + 16, true),
      compressedSize: view.getUint32(offset + 20, true),
      size: view.getUint32(offset + 24, true),
      localOffset: view.getUint32(offset + 42, true),
    })
    offset = nameEnd + view.getUint16(offset + 30, true) + view.getUint16(offset + 32, true)
  }
  return ok(entries)
}

function readCompressedData(bytes: Uint8Array, entry: ZipEntry): Uint8Array | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const { localOffset, name, compressedSize } = entry
  if (localOffset + 30 > bytes.length || view.getUint32(localOffset, true) !== 0x04034B50)
    return null
  const nameLength = view.getUint16(localOffset + 26, true)
  const dataStart = localOffset + 30 + nameLength + view.getUint16(localOffset + 28, true)
  if (dataStart + compressedSize > bytes.length)
    return null
  if (new TextDecoder().decode(bytes.subarray(localOffset + 30, localOffset + 30 + nameLength)) !== name)
    return null
  return bytes.subarray(dataStart, dataStart + compressedSize)
}

/**
 * Inflates in small chunks, so a declared size that lies stops at the limit. One chunk
 * can expand about 1,000 times, so memory stays bounded near the limit.
 */
function inflateBounded(compressed: Uint8Array, limit: number): { _tag: 'inflated', data: Uint8Array } | { _tag: 'too_large', found: number } | { _tag: 'corrupt' } {
  const chunks: Uint8Array[] = []
  let total = 0
  const inflate = new Inflate((chunk) => {
    total += chunk.length
    if (total <= limit)
      chunks.push(chunk)
  })
  try {
    let offset = 0
    do {
      const next = offset + INFLATE_CHUNK_BYTES
      inflate.push(compressed.subarray(offset, next), next >= compressed.length)
      offset = next
      if (total > limit)
        return { _tag: 'too_large', found: total }
    } while (offset < compressed.length)
  }
  catch {
    // fflate throws on an invalid stream, and the caller refuses the file by name.
    return { _tag: 'corrupt' }
  }
  const data = new Uint8Array(total)
  let position = 0
  for (const chunk of chunks) {
    data.set(chunk, position)
    position += chunk.length
  }
  return { _tag: 'inflated', data }
}

function crc32(bytes: Uint8Array): number {
  let crc = 0xFFFFFFFF
  for (const byte of bytes) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit++)
      crc = (crc >>> 1) ^ (0xEDB88320 & -(crc & 1))
  }
  return (crc ^ 0xFFFFFFFF) >>> 0
}

function readEntries(bytes: Uint8Array): Ok<Record<ReportFile, Uint8Array>> | Err<GenerativeAiReportParseError> {
  const directory = readCentralDirectory(bytes)
  if (!directory.ok)
    return directory
  const entries = directory.value
  const names = entries.map(entry => entry.name)

  if (names.includes('Queries.csv'))
    return err({ _tag: 'not_generative_ai_report', file: 'Queries.csv', found: [] })

  const missing = FILE_NAMES.filter(name => !names.includes(name))
  const isExactList = names.length === FILE_NAMES.length && new Set(names).size === names.length && missing.length === 0
  if (!isExactList)
    return err({ _tag: 'unexpected_entries', reason: 'names', found: names, missing })

  const encrypted = entries.filter(entry => (entry.flags & 0x0041) !== 0).map(entry => entry.name)
  if (encrypted.length > 0)
    return err({ _tag: 'unexpected_entries', reason: 'encrypted', found: encrypted, missing: [] })
  const unknownMethod = entries.filter(entry => entry.method !== 0 && entry.method !== 8).map(entry => entry.name)
  if (unknownMethod.length > 0)
    return err({ _tag: 'unexpected_entries', reason: 'compression', found: unknownMethod, missing: [] })

  for (const { name, size } of entries) {
    if (size > MAX_ENTRY_BYTES)
      return err({ _tag: 'file_too_large', scope: 'entry', file: name, limit: MAX_ENTRY_BYTES, found: size })
  }
  const declaredTotal = entries.reduce((sum, entry) => sum + entry.size, 0)
  if (declaredTotal > MAX_TOTAL_BYTES)
    return err({ _tag: 'file_too_large', scope: 'total', file: null, limit: MAX_TOTAL_BYTES, found: declaredTotal })

  const files: Partial<Record<ReportFile, Uint8Array>> = {}
  let realTotal = 0
  for (const entry of entries) {
    const name = entry.name as ReportFile
    const compressed = readCompressedData(bytes, entry)
    if (compressed === null)
      return err({ _tag: 'not_a_report_zip', reason: 'entry_mismatch', file: name })
    const inflated = entry.method === 0
      ? { _tag: 'inflated' as const, data: compressed }
      : inflateBounded(compressed, MAX_ENTRY_BYTES)
    if (inflated._tag === 'corrupt')
      return err({ _tag: 'not_a_report_zip', reason: 'corrupt_stream', file: name })
    if (inflated._tag === 'too_large')
      return err({ _tag: 'file_too_large', scope: 'entry', file: name, limit: MAX_ENTRY_BYTES, found: inflated.found })
    if (inflated.data.length > MAX_ENTRY_BYTES)
      return err({ _tag: 'file_too_large', scope: 'entry', file: name, limit: MAX_ENTRY_BYTES, found: inflated.data.length })
    realTotal += inflated.data.length
    if (realTotal > MAX_TOTAL_BYTES)
      return err({ _tag: 'file_too_large', scope: 'total', file: null, limit: MAX_TOTAL_BYTES, found: realTotal })
    if (inflated.data.length !== entry.size)
      return err({ _tag: 'not_a_report_zip', reason: 'size_mismatch', file: name })
    if (crc32(inflated.data) !== entry.checksum)
      return err({ _tag: 'not_a_report_zip', reason: 'checksum_mismatch', file: name })
    files[name] = inflated.data
  }
  return ok(files as Record<ReportFile, Uint8Array>)
}

// CSV reading.

function splitCsvLine(line: string): string[] | null {
  const fields: string[] = []
  let position = 0
  while (true) {
    if (line[position] === '"') {
      let value = ''
      position++
      while (true) {
        const close = line.indexOf('"', position)
        if (close === -1)
          return null
        value += line.slice(position, close)
        position = close + 1
        if (line[position] !== '"')
          break
        value += '"'
        position++
      }
      fields.push(value)
      if (position === line.length)
        return fields
      if (line[position] !== ',')
        return null
      position++
      continue
    }
    const comma = line.indexOf(',', position)
    const field = comma === -1 ? line.slice(position) : line.slice(position, comma)
    if (field.includes('"'))
      return null
    fields.push(field)
    if (comma === -1)
      return fields
    position = comma + 1
  }
}

function isClassicColumn(column: string): boolean {
  return /^(?:clicks|ctr|position)$/i.test(column) || /quer(?:y|ies)/i.test(column)
}

// Control characters other than a line ending. A lone CR is one of them.
// eslint-disable-next-line no-control-regex
const CONTROL_CHARACTER = /[\u0000-\u0009\v\f\u000E-\u001F\u007F]|\r(?!\n)/

/** Returns the data rows of one tab, after an exact header match. */
function readTab(file: ReportFile, bytes: Uint8Array): Ok<[string, string][]> | Err<GenerativeAiReportParseError> {
  let text: string
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  }
  catch {
    // A fatal decoder throws on invalid bytes, and the caller refuses the file by name.
    return err({ _tag: 'invalid_encoding', file, reason: 'not_utf8', line: null })
  }
  if (CONTROL_CHARACTER.test(text))
    return err({ _tag: 'invalid_encoding', file, reason: 'control_character', line: null })

  const lines = text.split(/\r?\n/)
  if (lines.at(-1) === '')
    lines.pop()
  const header = lines.length > 0 ? splitCsvLine(lines[0]!) : []
  if (header === null)
    return err({ _tag: 'invalid_encoding', file, reason: 'malformed_csv', line: 1 })
  if (header.some(isClassicColumn))
    return err({ _tag: 'not_generative_ai_report', file, found: header })
  const expected = FILES[file]
  if (header.length !== expected.length || expected.some((column, index) => column !== header[index]))
    return err({ _tag: 'unrecognized_headers', file, expected, found: header })

  const rowCount = lines.length - 1
  if (rowCount > MAX_ROWS)
    return err({ _tag: 'too_many_rows', file, limit: MAX_ROWS, found: rowCount })
  const rows: [string, string][] = []
  for (let index = 1; index < lines.length; index++) {
    const fields = splitCsvLine(lines[index]!)
    if (fields === null || fields.length !== 2 || fields[0] === '')
      return err({ _tag: 'invalid_encoding', file, reason: 'malformed_csv', line: index + 1 })
    rows.push([fields[0]!, fields[1]!])
  }
  return ok(rows)
}

// Field rules.

function parseImpressions(file: ReportFile, raw: string): Ok<GenerativeAiImpressionsV1> | Err<GenerativeAiReportParseError> {
  // Google writes `~` and `-` as zero in downloads, so all three can mean unavailable.
  if (raw === '0' || raw === '~' || raw === '-')
    return ok({ _tag: 'zero-or-unavailable' })
  const value = Number(raw)
  if (!/^[1-9]\d*$/.test(raw) || !Number.isSafeInteger(value))
    return err({ _tag: 'invalid_impressions', file, found: raw })
  return ok({ _tag: 'reported', value })
}

function firstDuplicate(values: readonly string[]): string | null {
  const seen = new Set<string>()
  for (const value of values) {
    if (seen.has(value))
      return value
    seen.add(value)
  }
  return null
}

function parseIsoDay(value: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value))
    return null
  const time = Date.parse(`${value}T00:00:00.000Z`)
  return !Number.isNaN(time) && new Date(time).toISOString().startsWith(value) ? time : null
}

function parseChart(rows: [string, string][], now: Date): Ok<GenerativeAiReportUploadV1['chart']['rows']> | Err<GenerativeAiReportParseError> {
  if (rows.length === 0)
    return err({ _tag: 'invalid_chart_dates', reason: 'empty', found: null })
  const parsed: GenerativeAiReportUploadV1['chart']['rows'] = []
  let previous: number | null = null
  for (const [date, raw] of rows) {
    const day = parseIsoDay(date)
    if (day === null)
      return err({ _tag: 'invalid_chart_dates', reason: 'not_iso', found: date })
    if (previous !== null && day !== previous + 86_400_000)
      return err({ _tag: 'invalid_chart_dates', reason: 'not_consecutive', found: date })
    if (day > now.getTime())
      return err({ _tag: 'invalid_chart_dates', reason: 'future', found: date })
    previous = day
    const impressions = parseImpressions('Chart.csv', raw)
    if (!impressions.ok)
      return impressions
    parsed.push({ date, impressions: impressions.value })
  }
  return ok(parsed)
}

function parseFilters(rows: [string, string][]): Ok<{ dateLabel: string }> | Err<GenerativeAiReportParseError> {
  const seen = new Map<string, string>()
  for (const [filter, value] of rows) {
    const isAllowed = (filter === 'Search type' && value === SEARCH_TYPE_WEB) || (filter === 'Date' && value !== '')
    if (!isAllowed || seen.has(filter))
      return err({ _tag: 'unsupported_filter', filter, value })
    seen.set(filter, value)
  }
  if (!seen.has('Search type'))
    return err({ _tag: 'unsupported_filter', filter: 'Search type', value: null })
  const dateLabel = seen.get('Date')
  if (dateLabel === undefined)
    return err({ _tag: 'unsupported_filter', filter: 'Date', value: null })
  return ok({ dateLabel })
}

function parsePages(rows: [string, string][], site: GenerativeAiReportParseInput['site']): Ok<{ pages: GenerativeAiReportUploadV1['pages'], warnings: GenerativeAiReportUploadWarningV1[] }> | Err<GenerativeAiReportParseError> {
  const duplicate = firstDuplicate(rows.map(([url]) => url))
  if (duplicate !== null)
    return err({ _tag: 'duplicate_rows', file: 'Pages.csv', found: duplicate })
  const host = site.registeredHost.toLowerCase()
  const onHost: GenerativeAiReportUploadV1['pages']['rows'] = []
  let offHostRows = 0
  let offHostImpressions = 0
  for (const [url, raw] of rows) {
    const parsedUrl = URL.canParse(url) ? new URL(url) : null
    if (parsedUrl === null || (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:'))
      return err({ _tag: 'invalid_page_url', found: url })
    const impressions = parseImpressions('Pages.csv', raw)
    if (!impressions.ok)
      return impressions
    // The host check ignores the scheme, and the URL stays verbatim.
    if (parsedUrl.hostname === host) {
      onHost.push({ url, impressions: impressions.value })
    }
    else {
      offHostRows++
      offHostImpressions += impressions.value._tag === 'reported' ? impressions.value.value : 0
    }
  }
  // A full tab can hide the host below Google's cutoff, so this case cannot refuse.
  const isTruncated = rows.length === MAX_ROWS
  const warnings: GenerativeAiReportUploadWarningV1[] = []
  if (rows.length > 0 && onHost.length === 0) {
    if (!isTruncated)
      return err({ _tag: 'no_registered_host_rows', host: site.registeredHost, pageRows: rows.length })
    warnings.push({ _tag: 'no_registered_host_rows_at_row_cap', host: site.registeredHost })
  }
  return ok({
    pages: {
      coverage: isTruncated ? { _tag: 'truncated', limit: MAX_ROWS } : { _tag: 'complete' },
      offHostRows,
      offHostImpressions,
      rows: onHost,
    },
    warnings,
  })
}

function parseCountries(rows: [string, string][]): Ok<GenerativeAiReportUploadV1['countries']['rows']> | Err<GenerativeAiReportParseError> {
  const duplicate = firstDuplicate(rows.map(([name]) => name))
  if (duplicate !== null)
    return err({ _tag: 'duplicate_rows', file: 'Countries.csv', found: duplicate })
  const parsed: GenerativeAiReportUploadV1['countries']['rows'] = []
  for (const [countryName, raw] of rows) {
    const impressions = parseImpressions('Countries.csv', raw)
    if (!impressions.ok)
      return impressions
    parsed.push({ countryName, countryCode: generativeAiReportCountryCode(countryName), impressions: impressions.value })
  }
  return ok(parsed)
}

function parseDevices(rows: [string, string][]): Ok<GenerativeAiReportUploadV1['devices']['rows']> | Err<GenerativeAiReportParseError> {
  const duplicate = firstDuplicate(rows.map(([name]) => name))
  if (duplicate !== null)
    return err({ _tag: 'duplicate_rows', file: 'Devices.csv', found: duplicate })
  const parsed: GenerativeAiReportUploadV1['devices']['rows'] = []
  for (const [name, raw] of rows) {
    if (!Object.hasOwn(DEVICES, name))
      return err({ _tag: 'invalid_device', found: name })
    const impressions = parseImpressions('Devices.csv', raw)
    if (!impressions.ok)
      return impressions
    parsed.push({ device: DEVICES[name as keyof typeof DEVICES], impressions: impressions.value })
  }
  return ok(parsed)
}

function propertyHost(gscProperty: string | null): string | null {
  if (gscProperty === null)
    return null
  if (gscProperty.startsWith('sc-domain:'))
    return gscProperty.slice('sc-domain:'.length).toLowerCase()
  return URL.canParse(gscProperty) ? new URL(gscProperty).hostname : null
}

function filenameWarnings(filename: string, site: GenerativeAiReportParseInput['site']): GenerativeAiReportUploadWarningV1[] {
  const markerIndex = filename.indexOf(SEARCH_FILENAME_MARKER)
  if (markerIndex <= 0)
    return [{ _tag: 'filename_unrecognized', filename }]
  const prefix = filename.slice(0, markerIndex).toLowerCase()
  const host = site.registeredHost.toLowerCase()
  const isParentDomain = prefix.includes('.') && host.endsWith(`.${prefix}`)
  if (prefix === host || isParentDomain || prefix === propertyHost(site.gscProperty))
    return []
  return [{ _tag: 'filename_site_mismatch', prefix, host: site.registeredHost }]
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>)
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('')
}

/**
 * Parses one Search Console Generative AI report export, from untrusted bytes, into the
 * body of `createSiteGenerativeAiReportUpload`. It refuses anything else by name. The
 * call is async only because Web Crypto hashes the zip. It has no other effects.
 */
export async function parseGenerativeAiReportExport(input: GenerativeAiReportParseInput): Promise<GenerativeAiReportParseResult> {
  const { bytes, site, now } = input
  if (bytes.length > MAX_ARCHIVE_BYTES)
    return err({ _tag: 'file_too_large', scope: 'archive', file: null, limit: MAX_ARCHIVE_BYTES, found: bytes.length })

  const filename = input.filename.split(/[/\\]/).at(-1) ?? input.filename
  // A Site name can contain the word, so the Search marker decides first.
  if (filename.includes('Discover') && !filename.includes(SEARCH_FILENAME_MARKER))
    return err({ _tag: 'discover_not_supported', filename })

  const entries = readEntries(bytes)
  if (!entries.ok)
    return entries

  const tabs: Partial<Record<ReportFile, [string, string][]>> = {}
  for (const file of FILE_NAMES) {
    const tab = readTab(file, entries.value[file])
    if (!tab.ok)
      return tab
    tabs[file] = tab.value
  }
  const { 'Chart.csv': chartRows, 'Pages.csv': pageRows, 'Countries.csv': countryRows, 'Devices.csv': deviceRows, 'Filters.csv': filterRows } = tabs as Record<ReportFile, [string, string][]>

  const filters = parseFilters(filterRows)
  if (!filters.ok)
    return filters
  const chart = parseChart(chartRows, now)
  if (!chart.ok)
    return chart
  const pages = parsePages(pageRows, site)
  if (!pages.ok)
    return pages
  const countries = parseCountries(countryRows)
  if (!countries.ok)
    return countries
  const devices = parseDevices(deviceRows)
  if (!devices.ok)
    return devices

  return ok({
    upload: {
      report: 'search',
      parserVersion: GENERATIVE_AI_REPORT_PARSER_VERSION,
      sourceSha256: await sha256Hex(bytes),
      sourceFilename: filename,
      window: { startDate: chart.value[0]!.date, endDate: chart.value.at(-1)!.date, label: filters.value.dateLabel },
      searchTypeFilter: SEARCH_TYPE_WEB,
      chart: { rows: chart.value },
      pages: pages.value.pages,
      countries: { rows: countries.value },
      devices: { rows: devices.value },
      warnings: [...filenameWarnings(filename, site), ...pages.value.warnings],
    },
    unmappedCountries: countries.value.filter(row => row.countryCode === null).map(row => row.countryName),
  })
}

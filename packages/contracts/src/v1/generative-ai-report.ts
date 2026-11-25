import { z } from 'zod'
import { defineResponseObject } from './http-core'

export const GENERATIVE_AI_REPORT_MAX_ROWS = 1000

/**
 * A reported value is never zero: Google writes unavailable values as zero in the
 * export, so a zero in the file can mean either state.
 */
const reportedImpressions = defineResponseObject({ _tag: z.literal('reported'), value: z.number().int().positive() })
const zeroOrUnavailableImpressions = defineResponseObject({ _tag: z.literal('zero-or-unavailable') })
const impressions = {
  producer: z.discriminatedUnion('_tag', [reportedImpressions.producer, zeroOrUnavailableImpressions.producer]),
  client: z.discriminatedUnion('_tag', [reportedImpressions.client, zeroOrUnavailableImpressions.client]),
}

const countryFields = { countryName: z.string().min(1), countryCode: z.string().regex(/^[a-z]{3}$/).nullable() }
const deviceField = z.enum(['desktop', 'mobile', 'tablet'])
const chartRow = defineResponseObject({ date: z.iso.date(), impressions: impressions.producer }, { date: z.iso.date(), impressions: impressions.client })
const pageRow = defineResponseObject({ url: z.url(), impressions: impressions.producer }, { url: z.url(), impressions: impressions.client })
const countryRow = defineResponseObject({ ...countryFields, impressions: impressions.producer }, { ...countryFields, impressions: impressions.client })
const deviceRow = defineResponseObject({ device: deviceField, impressions: impressions.producer }, { device: deviceField, impressions: impressions.client })

const completeCoverage = defineResponseObject({ _tag: z.literal('complete') })
const truncatedCoverage = defineResponseObject({ _tag: z.literal('truncated'), limit: z.literal(GENERATIVE_AI_REPORT_MAX_ROWS) })
const coverage = {
  producer: z.discriminatedUnion('_tag', [completeCoverage.producer, truncatedCoverage.producer]),
  client: z.discriminatedUnion('_tag', [completeCoverage.client, truncatedCoverage.client]),
}

const filenameSiteMismatch = defineResponseObject({ _tag: z.literal('filename_site_mismatch'), prefix: z.string(), host: z.string() })
const filenameUnrecognized = defineResponseObject({ _tag: z.literal('filename_unrecognized'), filename: z.string() })
const noHostRowsAtCap = defineResponseObject({ _tag: z.literal('no_registered_host_rows_at_row_cap'), host: z.string() })
const warning = {
  producer: z.discriminatedUnion('_tag', [filenameSiteMismatch.producer, filenameUnrecognized.producer, noHostRowsAtCap.producer]),
  client: z.discriminatedUnion('_tag', [filenameSiteMismatch.client, filenameUnrecognized.client, noHostRowsAtCap.client]),
}

const count = z.number().int().nonnegative()
const sha256 = z.string().regex(/^[a-f0-9]{64}$/)
const sourceFilename = z.string().min(1).max(512)
const parserVersion = z.number().int().positive()
const report = z.literal('search')

/** Opaque, and safe as one path segment. */
export const generativeAiReportUploadIdV1Schema = z.string().regex(/^[\w-]{1,128}$/)

const uploadWindow = defineResponseObject({ startDate: z.iso.date(), endDate: z.iso.date(), label: z.string().min(1) })
const rowCounts = defineResponseObject({ chart: count, pages: count, countries: count, devices: count })

function addDateIso(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00.000Z`) + days * 86_400_000).toISOString().slice(0, 10)
}

function duplicateIndex(values: readonly string[]): number {
  const seen = new Set<string>()
  return values.findIndex((value) => {
    if (seen.has(value))
      return true
    seen.add(value)
    return false
  })
}

/**
 * The body of `createSiteGenerativeAiReportUpload`, which the SDK parser produces.
 * Each key matches a stored row, so a duplicate would fail on write.
 */
export const generativeAiReportUploadV1Schema = z.strictObject({
  report,
  parserVersion,
  sourceSha256: sha256,
  sourceFilename,
  window: uploadWindow.producer,
  searchTypeFilter: z.literal('Web (text-based)'),
  chart: z.strictObject({ rows: z.array(chartRow.producer).min(1).max(GENERATIVE_AI_REPORT_MAX_ROWS) }),
  pages: z.strictObject({
    coverage: coverage.producer,
    offHostRows: count,
    offHostImpressions: count,
    rows: z.array(pageRow.producer).max(GENERATIVE_AI_REPORT_MAX_ROWS),
  }),
  countries: z.strictObject({ rows: z.array(countryRow.producer).max(GENERATIVE_AI_REPORT_MAX_ROWS) }),
  devices: z.strictObject({ rows: z.array(deviceRow.producer).max(3) }),
  warnings: z.array(warning.producer),
}).superRefine((upload, ctx) => {
  const dates = upload.chart.rows.map(row => row.date)
  if (dates.some((date, index) => index > 0 && date !== addDateIso(dates[index - 1]!, 1)))
    ctx.addIssue({ code: 'custom', path: ['chart', 'rows'], message: 'Chart dates must be consecutive.' })
  if (upload.window.startDate !== dates[0] || upload.window.endDate !== dates.at(-1))
    ctx.addIssue({ code: 'custom', path: ['window'], message: 'The window must match the first and last Chart dates.' })
  const keyed = {
    pages: upload.pages.rows.map(row => row.url),
    countries: upload.countries.rows.map(row => row.countryName),
    devices: upload.devices.rows.map(row => row.device),
  }
  for (const [tab, keys] of Object.entries(keyed)) {
    if (duplicateIndex(keys) !== -1)
      ctx.addIssue({ code: 'custom', path: [tab, 'rows'], message: 'Each row must have a unique key.' })
  }
})

export const generativeAiReportUploadReceiptV1Schemas = defineResponseObject(
  { uploadId: generativeAiReportUploadIdV1Schema, deduped: z.boolean(), warnings: z.array(warning.producer), unmappedCountries: z.array(z.string()), window: uploadWindow.producer, rowCounts: rowCounts.producer },
  { uploadId: z.string(), deduped: z.boolean(), warnings: z.array(warning.client), unmappedCountries: z.array(z.string()), window: uploadWindow.client, rowCounts: rowCounts.client },
)

const uploadSummaryCommon = { uploadId: generativeAiReportUploadIdV1Schema, report, sourceFilename, sourceSha256: sha256, parserVersion, uploadedAt: z.iso.datetime(), offHostRows: count, offHostImpressions: count }
const uploadSummary = defineResponseObject(
  { ...uploadSummaryCommon, window: uploadWindow.producer, pagesCoverage: coverage.producer, warnings: z.array(warning.producer), rowCounts: rowCounts.producer },
  { ...uploadSummaryCommon, window: uploadWindow.client, pagesCoverage: coverage.client, warnings: z.array(warning.client), rowCounts: rowCounts.client },
)
export const generativeAiReportUploadListV1Schemas = defineResponseObject(
  { uploads: z.array(uploadSummary.producer) },
  { uploads: z.array(uploadSummary.client) },
)
export const generativeAiReportUploadRemovedV1Schemas = defineResponseObject({ uploadId: z.string(), removed: z.literal(true) })

export const generativeAiReportQueryV1Schema = z.strictObject({
  uploadId: generativeAiReportUploadIdV1Schema.optional(),
  pageUrl: z.url().optional(),
})

const source = defineResponseObject({ _tag: z.literal('upload'), uploadId: z.string(), uploadedAt: z.iso.datetime(), sourceFilename })
const readWindow = defineResponseObject({ startDate: z.iso.date(), endDate: z.iso.date(), label: z.string().nullable() })
const propertyScope = z.literal('property')
const registeredHostScope = z.literal('registered-host')

const listedPage = defineResponseObject(
  { _tag: z.literal('listed'), url: z.url(), impressions: impressions.producer, otherSchemeRows: z.array(pageRow.producer) },
  { _tag: z.literal('listed'), url: z.url(), impressions: impressions.client, otherSchemeRows: z.array(pageRow.client) },
)
const notListedPage = defineResponseObject(
  { _tag: z.literal('not-listed'), otherSchemeRows: z.array(pageRow.producer) },
  { _tag: z.literal('not-listed'), otherSchemeRows: z.array(pageRow.client) },
)
const chartTab = defineResponseObject({ scope: propertyScope, rows: z.array(chartRow.producer) }, { scope: propertyScope, rows: z.array(chartRow.client) })
const pagesTab = defineResponseObject(
  { scope: registeredHostScope, coverage: coverage.producer, offHostRows: count, rows: z.array(pageRow.producer) },
  { scope: registeredHostScope, coverage: coverage.client, offHostRows: count, rows: z.array(pageRow.client) },
)
const countriesTab = defineResponseObject({ scope: propertyScope, rows: z.array(countryRow.producer) }, { scope: propertyScope, rows: z.array(countryRow.client) })
const devicesTab = defineResponseObject({ scope: propertyScope, rows: z.array(deviceRow.producer) }, { scope: propertyScope, rows: z.array(deviceRow.client) })

const empty = defineResponseObject({ _tag: z.literal('empty'), report, reason: z.literal('no-upload') })
const availableCommon = { _tag: z.literal('available'), report, freshness: z.enum(['current', 'stale']) }
const available = defineResponseObject(
  {
    ...availableCommon,
    source: source.producer,
    window: readWindow.producer,
    chart: chartTab.producer,
    pages: pagesTab.producer,
    countries: countriesTab.producer,
    devices: devicesTab.producer,
    warnings: z.array(warning.producer),
    page: z.discriminatedUnion('_tag', [listedPage.producer, notListedPage.producer]).nullable(),
  },
  {
    ...availableCommon,
    source: source.client,
    window: readWindow.client,
    chart: chartTab.client,
    pages: pagesTab.client,
    countries: countriesTab.client,
    devices: devicesTab.client,
    warnings: z.array(warning.client),
    page: z.discriminatedUnion('_tag', [listedPage.client, notListedPage.client]).nullable(),
  },
)

/**
 * The read carries no total field, because a total invites the sum error: Pages rows
 * can add up to more than Chart rows. An agent that needs a sum has the Chart rows.
 */
export const generativeAiReportReadV1Schemas = {
  producer: z.discriminatedUnion('_tag', [empty.producer, available.producer]),
  client: z.discriminatedUnion('_tag', [empty.client, available.client]),
}

export type GenerativeAiImpressionsV1 = z.infer<typeof impressions.producer>
export type GenerativeAiReportUploadWarningV1 = z.infer<typeof warning.producer>
export type GenerativeAiReportUploadV1 = z.infer<typeof generativeAiReportUploadV1Schema>
export type GenerativeAiReportUploadReceiptV1 = z.infer<typeof generativeAiReportUploadReceiptV1Schemas.producer>
export type GenerativeAiReportQueryV1 = z.infer<typeof generativeAiReportQueryV1Schema>
export type GenerativeAiReportReadV1 = z.infer<typeof generativeAiReportReadV1Schemas.producer>

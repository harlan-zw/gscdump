import type { Auth, GoogleSearchConsoleClient } from 'gscdump/client'
import type { Period, ResolvedAnalyticsRange } from 'gscdump/dates'
import type { Site } from 'gscdump/sites'
import { MS_PER_DAY, toIsoDate } from 'gscdump/dates'
import { SearchTypes } from 'gscdump/query'
import { z } from 'zod'

export type { Auth, GoogleSearchConsoleClient, Period, ResolvedAnalyticsRange, Site }

// Zod schemas for MCP tool inputs

export const periodSchema = z.object({
  start: z.string().describe('Start date (YYYY-MM-DD)'),
  end: z.string().describe('End date (YYYY-MM-DD)'),
}).describe('Date range for the query')

export const siteUrlSchema = z.string().describe('GSC property URL (e.g., sc-domain:example.com or https://example.com/)')

export const queryOptionsSchema = z.object({
  type: z.enum(SearchTypes).optional().describe('Data type'),
  dataState: z.enum(['final', 'all']).optional().describe('Data state: final (settled) or all (includes fresh)'),
  aggregationType: z.enum(['byPage', 'byProperty']).optional().describe('Aggregation: byPage or byProperty'),
}).optional()

// Handler context - what each handler receives
export interface HandlerContext {
  auth: Auth
  client: GoogleSearchConsoleClient
}

export interface MetricsRow {
  clicks: number
  impressions: number
  ctr: number
  position: number
  [key: string]: unknown
}

// Common input schemas
export const listSitesInput = z.object({})

export const listSitemapsInput = z.object({
  siteUrl: siteUrlSchema,
})

export const fetchAnalyticsInput = z.object({
  siteUrl: siteUrlSchema,
  period: periodSchema,
  comparePrevious: z.boolean().optional().describe('Include previous period comparison'),
  options: queryOptionsSchema,
})

export const fetchPageInput = z.object({
  siteUrl: siteUrlSchema,
  period: periodSchema,
  url: z.string().describe('Page URL to fetch details for'),
})

export const fetchKeywordInput = z.object({
  siteUrl: siteUrlSchema,
  period: periodSchema,
  keyword: z.string().describe('Keyword to fetch details for'),
})

export const inspectUrlInput = z.object({
  siteUrl: siteUrlSchema,
  inspectionUrl: z.string().describe('URL to inspect'),
})

export const requestIndexingInput = z.object({
  url: z.string().describe('URL to request indexing for'),
  type: z.enum(['URL_UPDATED', 'URL_DELETED']).optional().describe('Notification type'),
})

export const getIndexingStatusInput = z.object({
  url: z.string().describe('URL to get indexing status for'),
})

export const customQueryInput = z.object({
  siteUrl: siteUrlSchema,
  period: periodSchema,
  dimensions: z.array(z.enum(['date', 'query', 'page', 'country', 'device', 'searchAppearance'])).describe('Dimensions to group by'),
  rowLimit: z.number().optional().describe('Max rows (default 25000)'),
  options: queryOptionsSchema,
})

// Sitemap management inputs
export const sitemapInput = z.object({
  siteUrl: siteUrlSchema,
  feedpath: z.string().describe('Sitemap URL (e.g., https://example.com/sitemap.xml)'),
})

// Batch operation inputs
export const batchRequestIndexingInput = z.object({
  urls: z.array(z.string()).describe('URLs to request indexing for'),
  type: z.enum(['URL_UPDATED', 'URL_DELETED']).optional().describe('Notification type'),
  delayMs: z.number().optional().describe('Delay between requests in ms (default 100)'),
})

export const batchInspectUrlsInput = z.object({
  siteUrl: siteUrlSchema,
  urls: z.array(z.string()).describe('URLs to inspect'),
  delayMs: z.number().optional().describe('Delay between requests in ms (default 200)'),
})

// Reports
export const listReportsInput = z.object({})

export const runReportInput = z.object({
  siteUrl: siteUrlSchema,
  id: z.string().describe('Report ID supported by the live Google API. See list-reports.'),
  period: z.string().optional().describe('Window: 7d|28d|30d|90d|180d|365d|mtd|ytd|custom (default per report).'),
  comparison: z.string().optional().describe('Comparison: none|prev-period|yoy (default per report).'),
  start: z.string().optional().describe('Custom window start (YYYY-MM-DD); requires period=custom.'),
  end: z.string().optional().describe('Custom window end (YYYY-MM-DD); requires period=custom.'),
  prevStart: z.string().optional().describe('Override comparison-window start.'),
  prevEnd: z.string().optional().describe('Override comparison-window end.'),
  maxFindings: z.number().optional().describe('Cap findings per section (per-report default ~5).'),
  minClicksChange: z.number().optional().describe('Minimum absolute click change for movers findings.'),
  target: z.string().optional().describe('Page URL or query for triage. This Report requires the local Store.'),
  targetKind: z.enum(['page', 'query']).optional().describe('Target kind for triage. Defaults to page.'),
  topic: z.string().optional().describe('Required for pre-publish: topic or URL slug to check.'),
  brandTerms: z.string().optional().describe('Required for brand: comma-separated brand terms.'),
})

// Helper to convert zod period to gscdump Period
export function toPeriod(input: z.infer<typeof periodSchema>): Period {
  return { start: input.start, end: input.end }
}

// Helper to create ResolvedAnalyticsRange
export function toAnalyticsRange(period: Period, comparePrevious?: boolean): ResolvedAnalyticsRange {
  if (!comparePrevious)
    return { period }

  const start = new Date(period.start as string)
  const end = new Date(period.end as string)
  const days = Math.ceil((end.getTime() - start.getTime()) / MS_PER_DAY)

  const prevEnd = new Date(start.getTime() - MS_PER_DAY)
  const prevStart = new Date(prevEnd.getTime() - days * MS_PER_DAY)

  return {
    period,
    prevPeriod: {
      start: toIsoDate(prevStart),
      end: toIsoDate(prevEnd),
    },
  }
}

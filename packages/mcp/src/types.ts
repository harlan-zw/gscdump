import type { GscDb } from '@gscdump/db'
import type { DataSource } from '@gscdump/query'
import type { Auth, GoogleSearchConsoleClient, Period, ResolvedAnalyticsRange, Site } from 'gscdump'
import { z } from 'zod'

export type { DataSource, Auth, GoogleSearchConsoleClient, Period, ResolvedAnalyticsRange, Site }

// Zod schemas for MCP tool inputs

export const periodSchema = z.object({
  start: z.string().describe('Start date (YYYY-MM-DD)'),
  end: z.string().describe('End date (YYYY-MM-DD)'),
}).describe('Date range for the query')

export const siteUrlSchema = z.string().describe('GSC property URL (e.g., sc-domain:example.com or https://example.com/)')

export const dataSourceSchema = z.enum(['api', 'db', 'auto']).optional().describe('Data source: api (GSC API), db (local database), auto (prefer db if available)')

export const queryOptionsSchema = z.object({
  type: z.enum(['web', 'image', 'video', 'news', 'discover', 'googleNews']).optional().describe('Data type'),
  dataState: z.enum(['final', 'all']).optional().describe('Data state: final (settled) or all (includes fresh)'),
  aggregationType: z.enum(['byPage', 'byProperty']).optional().describe('Aggregation: byPage or byProperty'),
}).optional()

// Handler context - what each handler receives
export interface HandlerContext {
  auth: Auth
  client: GoogleSearchConsoleClient
  db?: GscDb | null
  source?: DataSource
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

// Analysis inputs
export const cannibalizationInput = z.object({
  siteUrl: siteUrlSchema,
  period: periodSchema.optional().describe('Period (defaults to last 28 days)'),
  source: dataSourceSchema,
  minImpressions: z.number().optional().describe('Minimum impressions for a query (default 10)'),
  maxPositionSpread: z.number().optional().describe('Maximum position spread to flag (default 10)'),
  minPages: z.number().optional().describe('Minimum pages ranking for same query (default 2)'),
  sortBy: z.enum(['clicks', 'impressions', 'positionSpread', 'pageCount']).optional().describe('Sort metric (default clicks)'),
  sortOrder: z.enum(['asc', 'desc']).optional().describe('Sort order (default desc)'),
})

export const strikingDistanceInput = z.object({
  siteUrl: siteUrlSchema,
  period: periodSchema.optional().describe('Period (defaults to last 28 days)'),
  source: dataSourceSchema,
  minPosition: z.number().optional().describe('Minimum position (default 4)'),
  maxPosition: z.number().optional().describe('Maximum position (default 20)'),
  minImpressions: z.number().optional().describe('Minimum impressions (default 100)'),
  maxCtr: z.number().optional().describe('Maximum CTR (default 0.05 = 5%)'),
  sortBy: z.enum(['clicks', 'impressions', 'ctr', 'position', 'potentialClicks']).optional().describe('Sort metric (default potentialClicks)'),
  sortOrder: z.enum(['asc', 'desc']).optional().describe('Sort order (default desc)'),
})

export const yoyComparisonInput = z.object({
  siteUrl: siteUrlSchema,
  period: periodSchema.optional().describe('Current period to compare (defaults to last 28 days)'),
  source: dataSourceSchema,
})

export const moversAndShakersInput = z.object({
  siteUrl: siteUrlSchema,
  period: periodSchema.optional().describe('Recent period (defaults to last 7 days)'),
  comparePeriod: periodSchema.optional().describe('Baseline period (defaults to 4 weeks before period)'),
  source: dataSourceSchema,
  changeThreshold: z.number().optional().describe('Minimum change threshold (default 0.2 = 20%)'),
  minImpressions: z.number().optional().describe('Minimum impressions (default 50)'),
  sortBy: z.enum(['clicks', 'impressions', 'clicksChange', 'impressionsChange', 'positionChange']).optional().describe('Sort metric (default clicksChange)'),
})

export const contentDecayInput = z.object({
  siteUrl: siteUrlSchema,
  period: periodSchema.optional().describe('Current period to analyze (defaults to last 28 days)'),
  source: dataSourceSchema,
  lookbackDays: z.number().optional().describe('Number of days to look back for comparison (default 365)'),
  minPreviousClicks: z.number().optional().describe('Minimum clicks in previous period to consider (default 50)'),
  threshold: z.number().optional().describe('Minimum decline percentage 0-1 (default 0.2 = 20%)'),
  sortBy: z.enum(['lostClicks', 'declinePercent', 'currentClicks']).optional().describe('Sort metric (default lostClicks)'),
})

export const zeroClickInput = z.object({
  siteUrl: siteUrlSchema,
  period: periodSchema.optional().describe('Period (defaults to last 28 days)'),
  source: dataSourceSchema,
  minImpressions: z.number().optional().describe('Minimum impressions (default 1000)'),
  maxCtr: z.number().optional().describe('Maximum CTR (default 0.03 = 3%)'),
  maxPosition: z.number().optional().describe('Only consider queries in top X positions (default 10)'),
})

export const periodRangeInput = z.object({
  period: z.string().optional().describe('Period string like "30d", "3mo", "max" (default 30d)'),
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
  const days = Math.ceil((end.getTime() - start.getTime()) / (1000 * 60 * 60 * 24))

  const prevEnd = new Date(start)
  prevEnd.setDate(prevEnd.getDate() - 1)
  const prevStart = new Date(prevEnd)
  prevStart.setDate(prevStart.getDate() - days)

  return {
    period,
    prevPeriod: {
      start: prevStart.toISOString().split('T')[0],
      end: prevEnd.toISOString().split('T')[0],
    },
  }
}
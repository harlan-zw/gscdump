import type { GoogleSearchConsoleClient } from '../core/client'
import type { GSCQueryBuilder, Dimension } from '../query'
import { gsc, between, date } from '../query'
import { dayjs } from '../utils/dayjs'
import { resolveToBody, extractDateRange } from '../query/resolver'

// Common sort order used across analyses
export type SortOrder = 'asc' | 'desc'

// Common sort metrics that appear in most analyses
export type CommonSortMetric = 'clicks' | 'impressions' | 'ctr' | 'position'

/**
 * Base search metrics from GSC API.
 * Core metrics available on all query/page data.
 */
export interface BaseSearchMetrics {
  clicks: number
  impressions: number
  ctr: number
  position: number
}

/**
 * Query-centric metrics - extends base with query and optional page.
 * Used by analyses focused on keywords/queries.
 */
export interface QueryMetrics extends BaseSearchMetrics {
  query: string
  page?: string | null
}

/**
 * Page-centric metrics - extends base with page URL.
 * Used by analyses focused on pages/URLs.
 */
export interface PageMetrics extends BaseSearchMetrics {
  page: string
}

/**
 * Base options shared by all analysis functions.
 * Query provides filters, period - analysis adds its own dimensions.
 */
export interface BaseAnalysisOptions {
  /** Query builder with filters and period. Defaults to last 28 days. */
  query?: GSCQueryBuilder<any, any>
}

/**
 * Options for analyses that support sorting.
 * Generic T allows each analysis to define its own sort metrics.
 */
export interface SortableOptions<T extends string = string> extends BaseAnalysisOptions {
  sortBy?: T
  sortOrder?: SortOrder
}

// Default period length in days
export const DEFAULT_PERIOD_DAYS = 28

/**
 * Creates a default query with period ending today.
 * Analysis functions add their own dimensions.
 */
export function defaultQuery(days = DEFAULT_PERIOD_DAYS): GSCQueryBuilder<[], object> {
  const end = dayjs()
  const start = end.subtract(days, 'day')
  return gsc.where(between(date, start.format('YYYY-MM-DD'), end.format('YYYY-MM-DD')))
}

/**
 * Gets date range from a query builder. Throws if dates not set.
 */
export function getQueryDateRange(query: GSCQueryBuilder<any, any>): { startDate: string, endDate: string } {
  const state = query.getState()
  const { startDate, endDate } = extractDateRange(state.filters)
  if (!startDate || !endDate) {
    throw new Error('Query must have date range set via between(date, ...) or gte/lte(date, ...)')
  }
  return { startDate, endDate }
}

/**
 * Creates a generic sort function for arrays.
 * Handles both asc/desc order and common metric extraction.
 */
export function createSorter<T, M extends string>(
  getMetricValue: (item: T, metric: M) => number,
  defaultMetric: M,
  defaultOrder: SortOrder = 'desc',
) {
  return (items: T[], sortBy: M = defaultMetric, sortOrder: SortOrder = defaultOrder): T[] => {
    const mult = sortOrder === 'desc' ? -1 : 1
    return items.sort((a, b) => (getMetricValue(a, sortBy) - getMetricValue(b, sortBy)) * mult)
  }
}

/**
 * Sorts items by common BaseSearchMetrics fields.
 * Use for results that extend BaseSearchMetrics.
 */
export function sortByMetric<T extends BaseSearchMetrics>(
  items: T[],
  sortBy: CommonSortMetric,
  sortOrder: SortOrder = 'desc',
): T[] {
  const mult = sortOrder === 'desc' ? -1 : 1
  return items.sort((a, b) => (a[sortBy] - b[sortBy]) * mult)
}

/**
 * Row type from analysis queries - dimensions as named properties.
 */
export interface AnalysisRow {
  query?: string
  page?: string
  device?: string
  country?: string
  date?: string
  clicks: number
  impressions: number
  ctr: number
  position: number
}

/**
 * Execute a query with specific dimensions, keeping user's filters.
 * Analysis functions use this to fetch data with their required dimensions.
 */
export async function executeAnalysisQuery(
  client: GoogleSearchConsoleClient,
  siteUrl: string,
  query: GSCQueryBuilder<any, any>,
  dimensions: Dimension[],
): Promise<{ rows: AnalysisRow[] }> {
  const state = query.getState()
  const body = resolveToBody({
    ...state,
    dimensions,
    siteUrl,
  })

  const response = await client.searchAnalytics.query(siteUrl, body)

  return {
    rows: (response.rows ?? []).map((row) => {
      const result: AnalysisRow = {
        clicks: row.clicks ?? 0,
        impressions: row.impressions ?? 0,
        ctr: row.ctr ?? 0,
        position: row.position ?? 0,
      }
      dimensions.forEach((dim, i) => {
        (result as any)[dim] = row.keys?.[i]
      })
      return result
    }),
  }
}

/**
 * Creates a new query with the same filters but different date range.
 * Strips existing date filters and applies new dates.
 */
export function withDateRange(
  query: GSCQueryBuilder<any, any>,
  startDate: string,
  endDate: string,
): GSCQueryBuilder<any, any> {
  const state = query.getState()
  let newQuery = gsc.where(between(date, startDate, endDate))

  for (const filter of state.filters) {
    const nonDateFilters = filter._filters.filter((f: any) => f.dimension !== 'date')
    if (nonDateFilters.length > 0)
      newQuery = newQuery.where({ ...filter, _filters: nonDateFilters } as any)
  }

  return newQuery
}

/**
 * Fetches a map of query -> top page (by clicks).
 * Common pattern used by striking-distance, movers, opportunity, zero-click.
 */
export async function fetchQueryPageMap(
  client: GoogleSearchConsoleClient,
  siteUrl: string,
  query: GSCQueryBuilder<any, any>,
): Promise<Map<string, string>> {
  const { rows } = await executeAnalysisQuery(client, siteUrl, query, ['query', 'page'])

  const pageMap = new Map<string, string>()
  for (const row of rows) {
    // First occurrence is highest traffic page (GSC default sort)
    if (row.query && !pageMap.has(row.query))
      pageMap.set(row.query, row.page || '')
  }
  return pageMap
}

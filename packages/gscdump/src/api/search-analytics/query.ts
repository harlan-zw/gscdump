import { withoutTrailingSlash } from 'ufo'
import type { DataRow, DimensionFilter, SearchAnalyticsQuery } from '../../core/types'
import type { GoogleSearchConsoleClient } from '../../core/client'
import { dayjs } from '../../utils/dayjs'
import { formatDateGsc } from '../../utils/format'
import type { DataType, QueryOptions } from './types'

/**
 * Recursively queries GSC search analytics, automatically handling pagination for large datasets.
 */
export async function queryRecursive(
  client: GoogleSearchConsoleClient,
  siteUrl: string,
  query: SearchAnalyticsQuery,
  options: { onProgress?: (rows: number) => void } = {},
): Promise<{ rows: DataRow[], pages: number }> {
  const rowLimit = query.rowLimit || 25_000
  const rows: DataRow[] = []
  let page = 1

  // Initial query
  const res = await client.searchAnalytics.query(siteUrl, {
    ...query,
    startRow: 0,
    rowLimit,
  })

  const initialRows = res.rows || []
  rows.push(...initialRows)
  options.onProgress?.(rows.length)

  // If we hit the limit, keep querying
  if (initialRows.length === rowLimit) {
    while (true) {
      page++
      const nextRes = await client.searchAnalytics.query(siteUrl, {
        ...query,
        startRow: rows.length,
        rowLimit,
      })
      const nextRows = nextRes.rows || []
      rows.push(...nextRows)
      options.onProgress?.(rows.length)

      if (nextRows.length < rowLimit) {
        break
      }
    }
  }

  return { rows, pages: page }
}

/**
 * Creates a GSC search analytics query request body with standard defaults.
 */
export function createQueryBody(options: QueryOptions = {}): SearchAnalyticsQuery {
  const {
    domain,
    period = {
      start: dayjs().subtract(30, 'day').toDate(),
      end: dayjs().toDate(),
    },
    filters = [],
    type = 'web',
    dataState = 'all',
    aggregationType = 'byPage',
    rowLimit = 25_000,
  } = options

  const allFilters: DimensionFilter[] = [...filters]

  // Only add page filters for byPage aggregation
  if (aggregationType === 'byPage') {
    allFilters.unshift({
      dimension: 'page',
      operator: 'excludingRegex',
      expression: `#`,
    })

    if (domain) {
      allFilters.unshift({
        dimension: 'page',
        operator: 'includingRegex',
        expression: `^${withoutTrailingSlash(domain).replace(/\./g, '\\.')}/.*`,
      })
    }
  }

  const result: SearchAnalyticsQuery = {
    type,
    aggregationType,
    dataState,
    startDate: formatDateGsc(period.start),
    endDate: formatDateGsc(period.end),
    rowLimit,
  }

  if (allFilters.length > 0) {
    result.dimensionFilterGroups = [{ filters: allFilters }]
  }

  return result
}

// Query builder helpers

/**
 * Helper to add search appearance dimension filter.
 * Use with spread: createQueryBody({ ...withSearchAppearance('AMP'), period })
 */
export function withSearchAppearance(appearance: string): Pick<QueryOptions, 'filters'> {
  return { filters: [{ dimension: 'searchAppearance', operator: 'equals', expression: appearance }] }
}

/**
 * Helper to set data type (web, image, video, news, discover, googleNews).
 * Use with spread: createQueryBody({ ...withDataType('image'), period })
 */
export function withDataType(type: DataType): Pick<QueryOptions, 'type'> {
  return { type }
}

/**
 * Helper to include fresh/unfinalized data (last 3 days).
 * Use with spread: createQueryBody({ ...withFreshData(), period })
 */
export function withFreshData(): Pick<QueryOptions, 'dataState'> {
  return { dataState: 'all' }
}

/**
 * Helper to use only finalized data (excludes last 3 days).
 * Use with spread: createQueryBody({ ...withFinalData(), period })
 */
export function withFinalData(): Pick<QueryOptions, 'dataState'> {
  return { dataState: 'final' }
}

/**
 * Helper to use byProperty aggregation (domain-level rollup).
 * Use for sc-domain: properties to get true totals.
 * Use with spread: createQueryBody({ ...withPropertyAggregation(), period })
 */
export function withPropertyAggregation(): Pick<QueryOptions, 'aggregationType'> {
  return { aggregationType: 'byProperty' }
}
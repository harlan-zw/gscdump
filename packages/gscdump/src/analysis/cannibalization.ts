/**
 * Keyword cannibalization analysis - detects multiple pages ranking for same query.
 * Pure function operating on query+page rows.
 */

import type { QueryPageRow, SortOrder } from './types'
import { createSorter } from './types'

export type CannibalizationSortMetric = 'clicks' | 'impressions' | 'positionSpread' | 'pageCount'

export interface CannibalizationOptions {
  /** Minimum impressions for a query to be considered. Default: 10 */
  minImpressions?: number
  /** Maximum position spread to flag as cannibalization. Default: 10 */
  maxPositionSpread?: number
  /** Minimum number of pages ranking for same query. Default: 2 */
  minPages?: number
  /** Sort metric. Default: clicks */
  sortBy?: CannibalizationSortMetric
  /** Sort order. Default: desc */
  sortOrder?: SortOrder
}

export interface CannibalizationPage {
  page: string
  clicks: number
  impressions: number
  ctr: number
  position: number
}

export interface CannibalizationResult {
  query: string
  pages: CannibalizationPage[]
  totalClicks: number
  totalImpressions: number
  positionSpread: number
}

const sortResults = createSorter<CannibalizationResult, CannibalizationSortMetric>(
  (item, metric) => {
    switch (metric) {
      case 'clicks': return item.totalClicks
      case 'impressions': return item.totalImpressions
      case 'positionSpread': return item.positionSpread
      case 'pageCount': return item.pages.length
    }
  },
  'clicks',
)

/**
 * Detects keyword cannibalization - queries ranking for multiple pages.
 * Returns queries where multiple pages compete for the same search term.
 *
 * @param rows Query+page data rows
 * @param options Filtering and sorting options
 */
export function analyzeCannibalization(
  rows: QueryPageRow[],
  options: CannibalizationOptions = {},
): CannibalizationResult[] {
  const {
    minImpressions = 10,
    maxPositionSpread = 10,
    minPages = 2,
    sortBy = 'clicks',
    sortOrder = 'desc',
  } = options

  // Group by query
  const queryMap = new Map<string, CannibalizationPage[]>()

  for (const row of rows) {
    if (row.impressions < minImpressions)
      continue

    const pages = queryMap.get(row.query) || []
    pages.push({
      page: row.page,
      clicks: row.clicks,
      impressions: row.impressions,
      ctr: row.ctr,
      position: row.position,
    })
    queryMap.set(row.query, pages)
  }

  // Filter to queries with multiple pages
  const results: CannibalizationResult[] = []

  for (const [query, pages] of queryMap) {
    if (pages.length < minPages)
      continue

    // Sort pages by clicks desc
    pages.sort((a, b) => b.clicks - a.clicks)

    const positions = pages.map(p => p.position)
    const positionSpread = Math.max(...positions) - Math.min(...positions)

    if (positionSpread > maxPositionSpread)
      continue

    results.push({
      query,
      pages,
      totalClicks: pages.reduce((sum, p) => sum + p.clicks, 0),
      totalImpressions: pages.reduce((sum, p) => sum + p.impressions, 0),
      positionSpread,
    })
  }

  return sortResults(results, sortBy, sortOrder)
}

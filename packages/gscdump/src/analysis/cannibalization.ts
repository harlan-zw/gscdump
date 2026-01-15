import type { GoogleSearchConsoleClient } from '../core/client'
import type { BaseSearchMetrics, SortableOptions } from './types'
import { createSorter, defaultQuery, executeAnalysisQuery } from './types'

export type CannibalizationSortMetric = 'clicks' | 'impressions' | 'positionSpread' | 'pageCount'

export interface CannibalizationOptions extends SortableOptions<CannibalizationSortMetric> {
  /** Minimum impressions for a query to be considered. Default: 10 */
  minImpressions?: number
  /** Maximum position spread to flag as cannibalization. Default: 10 */
  maxPositionSpread?: number
  /** Minimum number of pages ranking for same query. Default: 2 */
  minPages?: number
}

export interface CannibalizationPage extends BaseSearchMetrics {
  page: string
}

export interface CannibalizationResult {
  query: string
  pages: CannibalizationPage[]
  totalClicks: number
  totalImpressions: number
  positionSpread: number
}

/**
 * Detects keyword cannibalization - queries ranking for multiple pages.
 * Returns queries where multiple pages compete for the same search term.
 */
const sortCannibalization = createSorter<CannibalizationResult, CannibalizationSortMetric>(
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

export async function analyzeCannibalization(
  client: GoogleSearchConsoleClient,
  siteUrl: string,
  options: CannibalizationOptions = {},
): Promise<CannibalizationResult[]> {
  const {
    query = defaultQuery(),
    minImpressions = 10,
    maxPositionSpread = 10,
    minPages = 2,
    sortBy = 'clicks',
    sortOrder = 'desc',
  } = options

  // Fetch query + page data
  const { rows } = await executeAnalysisQuery(client, siteUrl, query, ['query', 'page'])

  // Group by query
  const queryMap = new Map<string, CannibalizationPage[]>()

  for (const row of rows) {
    const rowQuery = row.query || ''

    if (row.impressions < minImpressions)
      continue

    const pages = queryMap.get(rowQuery) || []
    pages.push({
      page: row.page || '',
      clicks: row.clicks,
      impressions: row.impressions,
      ctr: row.ctr,
      position: row.position,
    })
    queryMap.set(rowQuery, pages)
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

  return sortCannibalization(results, sortBy, sortOrder)
}

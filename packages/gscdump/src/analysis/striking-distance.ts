import type { GoogleSearchConsoleClient } from '../core/client'
import type { QueryMetrics, SortableOptions } from './types'
import { createSorter, defaultQuery, executeAnalysisQuery, fetchQueryPageMap } from './types'

export type StrikingDistanceSortMetric = 'clicks' | 'impressions' | 'ctr' | 'position' | 'potentialClicks'

export interface StrikingDistanceOptions extends SortableOptions<StrikingDistanceSortMetric> {
  /** Minimum position (inclusive). Default: 4 */
  minPosition?: number
  /** Maximum position (inclusive). Default: 20 */
  maxPosition?: number
  /** Minimum impressions. Default: 100 */
  minImpressions?: number
  /** Maximum CTR (queries with low CTR have more potential). Default: 0.05 (5%) */
  maxCtr?: number
}

export interface StrikingDistanceResult extends QueryMetrics {
  /** Estimated clicks if position improved to top 3 */
  potentialClicks: number
}

const sortStrikingDistance = createSorter<StrikingDistanceResult, StrikingDistanceSortMetric>(
  (item, metric) => item[metric],
  'potentialClicks',
)

/**
 * Finds striking distance keywords - high impressions, low CTR, position 4-20.
 * These are "quick wins" that could gain significant traffic with small ranking improvements.
 */
export async function analyzeStrikingDistance(
  client: GoogleSearchConsoleClient,
  siteUrl: string,
  options: StrikingDistanceOptions = {},
): Promise<StrikingDistanceResult[]> {
  const {
    query = defaultQuery(),
    minPosition = 4,
    maxPosition = 20,
    minImpressions = 100,
    maxCtr = 0.05,
    sortBy = 'potentialClicks',
    sortOrder = 'desc',
  } = options

  // Fetch query data and page lookup in parallel
  const [queryData, pageMap] = await Promise.all([
    executeAnalysisQuery(client, siteUrl, query, ['query']),
    fetchQueryPageMap(client, siteUrl, query),
  ])

  const results: StrikingDistanceResult[] = []

  for (const row of queryData.rows) {
    const rowQuery = row.query || ''

    // Apply filters
    if (row.position < minPosition || row.position > maxPosition)
      continue
    if (row.impressions < minImpressions)
      continue
    if (row.ctr > maxCtr)
      continue

    // Estimate potential clicks if position improved to ~2.5 (avg CTR ~15%)
    const potentialCtr = 0.15
    const potentialClicks = Math.round(row.impressions * potentialCtr)

    results.push({
      query: rowQuery,
      page: pageMap.get(rowQuery) || null,
      clicks: row.clicks,
      impressions: row.impressions,
      ctr: row.ctr,
      position: row.position,
      potentialClicks,
    })
  }

  return sortStrikingDistance(results, sortBy, sortOrder)
}

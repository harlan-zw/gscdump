import type { GoogleSearchConsoleClient } from '../core/client'
import type { BaseAnalysisOptions, QueryMetrics } from './types'
import { defaultQuery, executeAnalysisQuery, sortByMetric } from './types'

export interface ZeroClickOptions extends BaseAnalysisOptions {
  /** Minimum impressions. Default: 1000 */
  minImpressions?: number
  /** Maximum CTR to be considered "Zero Click". Default: 0.03 (3%) */
  maxCtr?: number
  /** Only consider queries in top X positions. Default: 10 */
  maxPosition?: number
}

// ZeroClickResult is exactly QueryMetrics
export type ZeroClickResult = QueryMetrics

/**
 * Identifies potential "Zero-Click" queries.
 * These are high-volume queries where you rank well but get few clicks,
 * often due to SERP features (Answer Boxes, Knowledge Panels, AI Overviews).
 */
export async function analyzeZeroClickQueries(
  client: GoogleSearchConsoleClient,
  siteUrl: string,
  options: ZeroClickOptions = {},
): Promise<ZeroClickResult[]> {
  const {
    query = defaultQuery(),
    minImpressions = 1000,
    maxCtr = 0.03, // 3%
    maxPosition = 10,
  } = options

  // Fetch queries with pages
  const { rows } = await executeAnalysisQuery(client, siteUrl, query, ['query', 'page'])

  const results: ZeroClickResult[] = []

  // Group by query to find top page per query
  const queryMap = new Map<string, { page: string, clicks: number, impressions: number, position: number, ctr: number }>()

  for (const row of rows) {
    const rowQuery = row.query || ''

    if (row.impressions < minImpressions)
      continue
    if (row.position > maxPosition)
      continue
    if (row.ctr > maxCtr)
      continue

    // If query already exists, keep the one with better position (or more traffic)
    const existing = queryMap.get(rowQuery)
    if (!existing || row.position < existing.position) {
      queryMap.set(rowQuery, {
        page: row.page || '',
        clicks: row.clicks,
        impressions: row.impressions,
        position: row.position,
        ctr: row.ctr,
      })
    }
  }

  for (const [rowQuery, metrics] of queryMap) {
    results.push({
      query: rowQuery,
      ...metrics,
    })
  }

  return sortByMetric(results, 'impressions')
}

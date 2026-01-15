/**
 * Zero-click analysis - identifies queries with high impressions but low clicks.
 * Pure function operating on query+page rows.
 */

import type { QueryPageRow } from './types'
import { createSorter } from './types'

export interface ZeroClickOptions {
  /** Minimum impressions. Default: 1000 */
  minImpressions?: number
  /** Maximum CTR to be considered "Zero Click". Default: 0.03 (3%) */
  maxCtr?: number
  /** Only consider queries in top X positions. Default: 10 */
  maxPosition?: number
}

export interface ZeroClickResult {
  query: string
  page: string
  clicks: number
  impressions: number
  ctr: number
  position: number
}

const sortResults = createSorter<ZeroClickResult, 'impressions'>(
  item => item.impressions,
  'impressions',
)

/**
 * Identifies potential "Zero-Click" queries.
 * These are high-volume queries where you rank well but get few clicks,
 * often due to SERP features (Answer Boxes, Knowledge Panels, AI Overviews).
 *
 * @param rows Query+page data rows
 * @param options Filtering options
 */
export function analyzeZeroClick(
  rows: QueryPageRow[],
  options: ZeroClickOptions = {},
): ZeroClickResult[] {
  const {
    minImpressions = 1000,
    maxCtr = 0.03,
    maxPosition = 10,
  } = options

  // Group by query to find top page per query
  const queryMap = new Map<string, ZeroClickResult>()

  for (const row of rows) {
    if (row.impressions < minImpressions)
      continue
    if (row.position > maxPosition)
      continue
    if (row.ctr > maxCtr)
      continue

    // If query already exists, keep the one with better position
    const existing = queryMap.get(row.query)
    if (!existing || row.position < existing.position) {
      queryMap.set(row.query, {
        query: row.query,
        page: row.page,
        clicks: row.clicks,
        impressions: row.impressions,
        ctr: row.ctr,
        position: row.position,
      })
    }
  }

  return sortResults(Array.from(queryMap.values()), 'impressions', 'desc')
}

/**
 * Striking distance analysis - finds keywords close to page 1.
 */

import type { KeywordRow, SortOrder } from './types'
import { createSorter, num } from './types'

export type StrikingDistanceSortMetric = 'clicks' | 'impressions' | 'ctr' | 'position' | 'potentialClicks'

export interface StrikingDistanceOptions {
  /** Minimum position (inclusive). Default: 4 */
  minPosition?: number
  /** Maximum position (inclusive). Default: 20 */
  maxPosition?: number
  /** Minimum impressions. Default: 100 */
  minImpressions?: number
  /** Maximum CTR (queries with low CTR have more potential). Default: 0.05 (5%) */
  maxCtr?: number
  /** Sort metric. Default: potentialClicks */
  sortBy?: StrikingDistanceSortMetric
  /** Sort order. Default: desc */
  sortOrder?: SortOrder
}

export interface StrikingDistanceResult {
  keyword: string
  page: string | null
  clicks: number
  impressions: number
  ctr: number
  position: number
  /** Estimated clicks if position improved to top 3 */
  potentialClicks: number
}

const sortResults = createSorter<StrikingDistanceResult, StrikingDistanceSortMetric>(
  (item, metric) => item[metric],
  'potentialClicks',
)

/**
 * Finds striking distance keywords - high impressions, low CTR, position 4-20.
 * These are "quick wins" that could gain significant traffic with small ranking improvements.
 */
export function analyzeStrikingDistance(
  keywords: KeywordRow[],
  options: StrikingDistanceOptions = {},
): StrikingDistanceResult[] {
  const {
    minPosition = 4,
    maxPosition = 20,
    minImpressions = 100,
    maxCtr = 0.05,
    sortBy = 'potentialClicks',
    sortOrder = 'desc',
  } = options

  const results: StrikingDistanceResult[] = []

  for (const row of keywords) {
    const position = num(row.position)
    const impressions = num(row.impressions)
    const ctr = num(row.ctr)
    const clicks = num(row.clicks)

    if (position < minPosition || position > maxPosition)
      continue
    if (impressions < minImpressions)
      continue
    if (ctr > maxCtr)
      continue

    // Estimate potential clicks if position improved to ~2.5 (avg CTR ~15%)
    const potentialCtr = 0.15
    const potentialClicks = Math.round(impressions * potentialCtr)

    results.push({
      keyword: row.query,
      page: row.page ?? null,
      clicks,
      impressions,
      ctr,
      position,
      potentialClicks,
    })
  }

  return sortResults(results, sortBy, sortOrder)
}

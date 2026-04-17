/**
 * Content decay analysis - identifies pages that have lost traffic.
 */

import type { PageRow, SortOrder } from './types'
import { createSorter, num } from './types'

export type DecaySortMetric = 'lostClicks' | 'declinePercent' | 'currentClicks'

export interface DecayOptions {
  /** Minimum clicks in previous period to consider. Default: 50 */
  minPreviousClicks?: number
  /** Minimum decline percentage (0-1). Default: 0.2 (20%) */
  threshold?: number
  /** Metric to sort results by. Default: lostClicks */
  sortBy?: DecaySortMetric
}

export interface DecayInput {
  current: PageRow[]
  previous: PageRow[]
}

export interface DecayResult {
  page: string
  currentClicks: number
  previousClicks: number
  lostClicks: number
  declinePercent: number
  currentPosition: number
  previousPosition: number
  positionDrop: number
}

const SORT_ORDER: Record<DecaySortMetric, SortOrder> = {
  lostClicks: 'desc',
  declinePercent: 'desc',
  currentClicks: 'asc',
}

const sortResults = createSorter<DecayResult, DecaySortMetric>(
  (item, metric) => item[metric],
  'lostClicks',
)

/**
 * Identifies "decaying" content - pages that have lost significant traffic.
 */
export function analyzeDecay(
  input: DecayInput,
  options: DecayOptions = {},
): DecayResult[] {
  const {
    minPreviousClicks = 50,
    threshold = 0.2,
    sortBy = 'lostClicks',
  } = options

  const currentMap = new Map<string, { clicks: number, position: number }>()
  for (const row of input.current) {
    currentMap.set(row.page, {
      clicks: num(row.clicks),
      position: num(row.position),
    })
  }

  const previousMap = new Map<string, { clicks: number, position: number }>()
  for (const row of input.previous) {
    const clicks = num(row.clicks)
    if (clicks >= minPreviousClicks) {
      previousMap.set(row.page, {
        clicks,
        position: num(row.position),
      })
    }
  }

  const results: DecayResult[] = []

  for (const [page, prev] of previousMap) {
    const curr = currentMap.get(page) || { clicks: 0, position: 0 }

    const lostClicks = prev.clicks - curr.clicks
    const declinePercent = prev.clicks > 0 ? lostClicks / prev.clicks : 0

    if (declinePercent >= threshold && lostClicks > 0) {
      results.push({
        page,
        currentClicks: curr.clicks,
        previousClicks: prev.clicks,
        lostClicks,
        declinePercent,
        currentPosition: curr.position,
        previousPosition: prev.position,
        positionDrop: curr.position - prev.position,
      })
    }
  }

  return sortResults(results, sortBy, SORT_ORDER[sortBy])
}

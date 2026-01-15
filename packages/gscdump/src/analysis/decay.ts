import type { GoogleSearchConsoleClient } from '../core/client'
import type { BaseAnalysisOptions, SortOrder } from './types'
import { createSorter, defaultQuery, executeAnalysisQuery, getQueryDateRange, withDateRange } from './types'
import { dayjs } from '../utils/dayjs'

export type DecaySortMetric = 'lostClicks' | 'declinePercent' | 'currentClicks'

export interface ContentDecayOptions extends BaseAnalysisOptions {
  /** Number of days to look back for comparison. Default: 365 (1 year) */
  lookbackDays?: number
  /** Minimum clicks in previous period to consider. Default: 50 */
  minPreviousClicks?: number
  /** Minimum decline percentage (0-1). Default: 0.2 (20%) */
  threshold?: number
  /** Metric to sort results by. Default: 'lostClicks' */
  sortBy?: DecaySortMetric
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

// currentClicks sorts ascending (lowest first), others descending
const DECAY_SORT_ORDER: Record<DecaySortMetric, SortOrder> = {
  lostClicks: 'desc',
  declinePercent: 'desc',
  currentClicks: 'asc',
}

const sortDecay = createSorter<DecayResult, DecaySortMetric>(
  (item, metric) => item[metric],
  'lostClicks',
)

/**
 * Identifies "decaying" content - pages that have lost significant traffic compared to the past.
 * Useful for finding old blog posts that need updating.
 */
export async function analyzeContentDecay(
  client: GoogleSearchConsoleClient,
  siteUrl: string,
  options: ContentDecayOptions = {},
): Promise<DecayResult[]> {
  const {
    query = defaultQuery(),
    lookbackDays = 365,
    minPreviousClicks = 50,
    threshold = 0.2,
    sortBy = 'lostClicks',
  } = options

  const { startDate: currentStartStr, endDate: currentEndStr } = getQueryDateRange(query)
  const currentStart = dayjs(currentStartStr)
  const currentEnd = dayjs(currentEndStr)
  const duration = currentEnd.diff(currentStart, 'day')

  // Calculate historical period (shifted back by lookbackDays)
  const prevStart = currentStart.subtract(lookbackDays, 'day')
  const prevEnd = prevStart.add(duration, 'day')

  // Check if within GSC limits (~16 months = 486 days)
  if (dayjs().diff(prevStart, 'day') > 486) {
    throw new Error(`Lookback period exceeds GSC 16-month retention limit. Reduce lookbackDays (currently ${lookbackDays}).`)
  }

  const prevQuery = withDateRange(query, prevStart.format('YYYY-MM-DD'), prevEnd.format('YYYY-MM-DD'))

  // Fetch data
  const [currentData, prevData] = await Promise.all([
    executeAnalysisQuery(client, siteUrl, query, ['page']),
    executeAnalysisQuery(client, siteUrl, prevQuery, ['page']),
  ])

  // Map previous data
  const prevMap = new Map<string, { clicks: number, position: number }>()
  for (const row of prevData.rows) {
    if (row.clicks >= minPreviousClicks) {
      prevMap.set(row.page || '', {
        clicks: row.clicks,
        position: row.position,
      })
    }
  }

  const results: DecayResult[] = []

  // Compare with current
  const currentMap = new Map<string, { clicks: number, position: number }>()
  for (const row of currentData.rows) {
    currentMap.set(row.page || '', {
      clicks: row.clicks,
      position: row.position,
    })
  }

  // Iterate over PREVIOUS pages (since we care about what was lost)
  for (const [page, prev] of prevMap) {
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

  return sortDecay(results, sortBy, DECAY_SORT_ORDER[sortBy])
}

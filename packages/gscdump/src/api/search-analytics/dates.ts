import type { GoogleSearchConsoleClient } from '../../core/client'
import type { Period } from '../../core/types'
import type { DateData, QueryOptions } from './types'
import { dayjs } from '../../utils/dayjs'
import { formatDateGsc, percentDifference } from '../../utils/format'
import { createQueryBody } from './query'

export interface DatesComparisonResult {
  current: DateData[]
  previous: DateData[]
  metadata: {
    currentCount: number
    previousCount: number
    totals: {
      current: { clicks: number, impressions: number, ctr: number, position: number }
      previous: { clicks: number, impressions: number, ctr: number, position: number }
      clicksPercent: number
      impressionsPercent: number
      ctrPercent: number
      positionPercent: number
    }
  }
}

function computeTotals(rows: DateData[]): { clicks: number, impressions: number, ctr: number, position: number } {
  if (!rows.length)
    return { clicks: 0, impressions: 0, ctr: 0, position: 0 }
  return {
    clicks: rows.reduce((sum, r) => sum + (r.clicks || 0), 0),
    impressions: rows.reduce((sum, r) => sum + (r.impressions || 0), 0),
    ctr: rows.reduce((sum, r) => sum + (r.ctr || 0), 0) / rows.length,
    position: rows.reduce((sum, r) => sum + (r.position || 0), 0) / rows.length,
  }
}

/**
 * Fetches daily search analytics data with period-over-period comparison.
 */
export async function fetchDatesWithComparison(client: GoogleSearchConsoleClient, siteUrl: string, options: QueryOptions = {}): Promise<DatesComparisonResult> {
  const [current, previous] = await Promise.all([
    client.searchAnalytics.query(siteUrl, {
      ...createQueryBody({ ...options }),
      dimensions: ['date'],
    }).then(res => (res.rows || []).map(row => ({
      ...row,
      dimension: 'date' as const,
      date: row.keys?.[0] || '',
      keys: null,
    }))),
    options.prevPeriod
      ? client.searchAnalytics.query(siteUrl, {
          ...createQueryBody({ ...options, period: options.prevPeriod }),
          dimensions: ['date'],
        }).then(res => (res.rows || []).map(row => ({
          ...row,
          dimension: 'date' as const,
          date: row.keys?.[0] || '',
          keys: null,
        })))
      : Promise.resolve([]),
  ])

  const currentTotals = computeTotals(current)
  const previousTotals = computeTotals(previous)

  return {
    current,
    previous,
    metadata: {
      currentCount: current.length,
      previousCount: previous.length,
      totals: {
        current: currentTotals,
        previous: previousTotals,
        clicksPercent: percentDifference(currentTotals.clicks, previousTotals.clicks),
        impressionsPercent: percentDifference(currentTotals.impressions, previousTotals.impressions),
        ctrPercent: percentDifference(currentTotals.ctr, previousTotals.ctr),
        positionPercent: percentDifference(currentTotals.position, previousTotals.position),
      },
    },
  }
}

// ============================================================================
// Year-over-Year Comparison
// ============================================================================

export interface YoYComparisonOptions {
  /** Current period to compare. If not provided, uses last 28 days */
  period?: Period
}

export interface YoYMetrics {
  clicks: number
  impressions: number
  ctr: number
  position: number
}

export interface YoYComparisonResult {
  current: YoYMetrics
  previous: YoYMetrics
  change: {
    clicks: number
    clicksPercent: number
    impressions: number
    impressionsPercent: number
    ctr: number
    ctrPercent: number
    position: number
    positionPercent: number
  }
  periodDays: number
  withinLimit: boolean
}

/**
 * Fetches year-over-year comparison for site metrics.
 * GSC has ~16 months history, so works for periods up to ~4 months.
 */
export async function fetchYoYComparison(
  client: GoogleSearchConsoleClient,
  siteUrl: string,
  options: YoYComparisonOptions = {},
): Promise<YoYComparisonResult> {
  const {
    period = { start: dayjs().subtract(28, 'day').toDate(), end: dayjs().toDate() },
  } = options

  const startDate = dayjs(period.start)
  const endDate = dayjs(period.end)
  const periodDays = endDate.diff(startDate, 'day')

  // Calculate YoY period (same dates last year)
  const prevStart = startDate.subtract(1, 'year')
  const prevEnd = endDate.subtract(1, 'year')

  // Check if within GSC's ~16 month limit
  const daysSincePrevStart = dayjs().diff(prevStart, 'day')
  const withinLimit = daysSincePrevStart <= 480 // ~16 months

  const [currentRes, previousRes] = await Promise.all([
    client.searchAnalytics.query(siteUrl, {
      ...createQueryBody({ period }),
      dimensions: ['date'],
    }),
    withinLimit
      ? client.searchAnalytics.query(siteUrl, {
          startDate: formatDateGsc(prevStart.toDate()) || '',
          endDate: formatDateGsc(prevEnd.toDate()) || '',
          dimensions: ['date'],
          rowLimit: 25_000,
        })
      : Promise.resolve({ rows: [] }),
  ])

  const currentRows = currentRes.rows || []
  const previousRows = previousRes.rows || []

  const sumMetrics = (rows: typeof currentRows): YoYMetrics => {
    if (!rows.length)
      return { clicks: 0, impressions: 0, ctr: 0, position: 0 }
    return {
      clicks: rows.reduce((sum, r) => sum + (r.clicks || 0), 0),
      impressions: rows.reduce((sum, r) => sum + (r.impressions || 0), 0),
      ctr: rows.reduce((sum, r) => sum + (r.ctr || 0), 0) / rows.length,
      position: rows.reduce((sum, r) => sum + (r.position || 0), 0) / rows.length,
    }
  }

  const current = sumMetrics(currentRows)
  const previous = sumMetrics(previousRows)

  return {
    current,
    previous,
    change: {
      clicks: current.clicks - previous.clicks,
      clicksPercent: percentDifference(current.clicks, previous.clicks),
      impressions: current.impressions - previous.impressions,
      impressionsPercent: percentDifference(current.impressions, previous.impressions),
      ctr: current.ctr - previous.ctr,
      ctrPercent: percentDifference(current.ctr, previous.ctr),
      position: current.position - previous.position,
      positionPercent: percentDifference(current.position, previous.position),
    },
    periodDays,
    withinLimit,
  }
}

/**
 * Fetches daily search analytics data for a site.
 */
export async function fetchDates(client: GoogleSearchConsoleClient, siteUrl: string, options: QueryOptions = {}): Promise<DateData[]> {
  const dates = await client.searchAnalytics.query(siteUrl, {
    ...createQueryBody(options),
    dimensions: ['date'],
  }).then((res) => {
    return (res.rows || []).map((row) => {
      return {
        ...row,
        dimension: 'date' as const,
        date: row.keys?.[0] || '',
        keys: null,
      }
    })
  })
  return dates
}

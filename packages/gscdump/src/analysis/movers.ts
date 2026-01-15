import type { Dayjs } from 'dayjs'
import type { GoogleSearchConsoleClient } from '../core/client'
import type { BaseAnalysisOptions } from './types'
import type { GSCQueryBuilder } from '../query'
import { defaultQuery, executeAnalysisQuery, getQueryDateRange, withDateRange } from './types'
import { dayjs } from '../utils/dayjs'
import { percentDifference } from '../utils/format'

export type MoversSortMetric = 'clicks' | 'impressions' | 'clicksChange' | 'impressionsChange' | 'positionChange'

export interface MoversAndShakersOptions extends BaseAnalysisOptions {
  /** Baseline query to compare against. Default: 4 weeks before main query period */
  compareQuery?: GSCQueryBuilder<any, any>
  /** Minimum change threshold to flag. Default: 0.2 (20%) */
  changeThreshold?: number
  /** Minimum impressions in recent period. Default: 50 */
  minImpressions?: number
  /** Metric to sort results by. Default: 'clicksChange' */
  sortBy?: MoversSortMetric
}

export interface MoverData {
  query: string
  page: string | null
  recentClicks: number
  recentImpressions: number
  recentPosition: number
  baselineClicks: number
  baselineImpressions: number
  baselinePosition: number
  clicksChange: number
  clicksChangePercent: number
  impressionsChangePercent: number
  positionChange: number
}

export interface MoversAndShakersResult {
  rising: MoverData[]
  declining: MoverData[]
  stable: MoverData[]
  periods: {
    recent: { start: string, end: string }
    baseline: { start: string, end: string }
  }
}

/**
 * Identifies movers and shakers - queries with significant recent changes.
 * Compares recent week against previous 4-week average baseline.
 */
export async function analyzeMoversAndShakers(
  client: GoogleSearchConsoleClient,
  siteUrl: string,
  options: MoversAndShakersOptions = {},
): Promise<MoversAndShakersResult> {
  const {
    query = defaultQuery(7),
    compareQuery,
    changeThreshold = 0.2,
    minImpressions = 50,
    sortBy = 'clicksChange',
  } = options

  const { startDate: recentStartStr, endDate: recentEndStr } = getQueryDateRange(query)
  const recentStart = dayjs(recentStartStr)
  const recentEnd = dayjs(recentEndStr)

  // Default baseline: 4 weeks before the recent period
  // Use compareQuery if provided, otherwise derive from recent query
  let baselineQuery: GSCQueryBuilder<any, any>
  let baselineStart: Dayjs
  let baselineEnd: Dayjs

  if (compareQuery) {
    baselineQuery = compareQuery
    const { startDate: baseStartStr, endDate: baseEndStr } = getQueryDateRange(compareQuery)
    baselineStart = dayjs(baseStartStr)
    baselineEnd = dayjs(baseEndStr)
  }
  else {
    // Create baseline query with same filters, different period
    baselineEnd = recentStart.subtract(1, 'day')
    baselineStart = baselineEnd.subtract(28, 'day')
    baselineQuery = withDateRange(query, baselineStart.format('YYYY-MM-DD'), baselineEnd.format('YYYY-MM-DD'))
  }

  // Fetch both periods with user's filters applied
  const [recentData, baselineData, recentPages, baselinePages] = await Promise.all([
    executeAnalysisQuery(client, siteUrl, query, ['query']),
    executeAnalysisQuery(client, siteUrl, baselineQuery, ['query']),
    executeAnalysisQuery(client, siteUrl, query, ['query', 'page']),
    executeAnalysisQuery(client, siteUrl, baselineQuery, ['query', 'page']),
  ])

  // Calculate period lengths for normalization
  const recentDays = recentEnd.diff(recentStart, 'day') || 1
  const baselineDays = baselineEnd.diff(baselineStart, 'day') || 1
  const normalizationFactor = baselineDays / recentDays

  // Build lookup maps
  const baselineMap = new Map<string, { clicks: number, impressions: number, position: number }>()
  for (const row of baselineData.rows) {
    const rowQuery = row.query || ''
    // Normalize baseline to same period length as recent for fair comparison
    baselineMap.set(rowQuery, {
      clicks: row.clicks / normalizationFactor,
      impressions: row.impressions / normalizationFactor,
      position: row.position,
    })
  }

  // Build page lookup (top page per query from recent)
  const pageMap = new Map<string, string>()
  for (const row of recentPages.rows) {
    const rowQuery = row.query || ''
    if (!pageMap.has(rowQuery))
      pageMap.set(rowQuery, row.page || '')
  }
  // Fill in from baseline for queries not in recent
  for (const row of baselinePages.rows) {
    const rowQuery = row.query || ''
    if (!pageMap.has(rowQuery))
      pageMap.set(rowQuery, row.page || '')
  }

  const rising: MoverData[] = []
  const declining: MoverData[] = []
  const stable: MoverData[] = []

  // Process recent queries
  for (const row of recentData.rows) {
    const rowQuery = row.query || ''

    if (row.impressions < minImpressions)
      continue

    const baseline = baselineMap.get(rowQuery) || { clicks: 0, impressions: 0, position: 0 }
    const clicksChangePercent = percentDifference(row.clicks, baseline.clicks)
    const impressionsChangePercent = percentDifference(row.impressions, baseline.impressions)

    const data: MoverData = {
      query: rowQuery,
      page: pageMap.get(rowQuery) || null,
      recentClicks: row.clicks,
      recentImpressions: row.impressions,
      recentPosition: row.position,
      baselineClicks: Math.round(baseline.clicks),
      baselineImpressions: Math.round(baseline.impressions),
      baselinePosition: baseline.position,
      clicksChange: row.clicks - Math.round(baseline.clicks),
      clicksChangePercent,
      impressionsChangePercent,
      positionChange: row.position - baseline.position,
    }

    const absChange = Math.abs(clicksChangePercent / 100)

    if (clicksChangePercent > 0 && absChange >= changeThreshold)
      rising.push(data)
    else if (clicksChangePercent < 0 && absChange >= changeThreshold)
      declining.push(data)
    else
      stable.push(data)
  }

  // Sort by selected metric
  const sortFn = (a: MoverData, b: MoverData): number => {
    switch (sortBy) {
      case 'clicks':
        return b.recentClicks - a.recentClicks
      case 'impressions':
        return b.recentImpressions - a.recentImpressions
      case 'clicksChange':
        return Math.abs(b.clicksChangePercent) - Math.abs(a.clicksChangePercent)
      case 'impressionsChange':
        return Math.abs(b.impressionsChangePercent) - Math.abs(a.impressionsChangePercent)
      case 'positionChange':
        return Math.abs(b.positionChange) - Math.abs(a.positionChange)
      default:
        return Math.abs(b.clicksChangePercent) - Math.abs(a.clicksChangePercent)
    }
  }

  rising.sort(sortFn)
  declining.sort(sortFn)
  stable.sort((a, b) => b.recentClicks - a.recentClicks)

  return {
    rising,
    declining,
    stable,
    periods: {
      recent: {
        start: recentStart.format('YYYY-MM-DD'),
        end: recentEnd.format('YYYY-MM-DD'),
      },
      baseline: {
        start: baselineStart.format('YYYY-MM-DD'),
        end: baselineEnd.format('YYYY-MM-DD'),
      },
    },
  }
}

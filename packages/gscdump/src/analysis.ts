import type { GscAuth } from './client'
import type { Period } from './types'
import { gscClient } from './client'
import { dayjs } from './dayjs'
import { createQueryBody, queryRecursive } from './searchanalytics'
import { formatDateGsc, percentDifference } from './utils'

// ============================================================================
// Shared Types
// ============================================================================

export type SortMetric = 'clicks' | 'impressions' | 'ctr' | 'position'
export type SortOrder = 'asc' | 'desc'

// ============================================================================
// Cannibalization Detection
// ============================================================================

export type CannibalizationSortMetric = 'clicks' | 'impressions' | 'positionSpread' | 'pageCount'

export interface CannibalizationOptions {
  period?: Period
  /** Minimum impressions for a query to be considered. Default: 10 */
  minImpressions?: number
  /** Maximum position spread to flag as cannibalization. Default: 10 */
  maxPositionSpread?: number
  /** Minimum number of pages ranking for same query. Default: 2 */
  minPages?: number
  /** Metric to sort results by. Default: 'clicks' */
  sortBy?: CannibalizationSortMetric
  /** Sort order. Default: 'desc' */
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

/**
 * Detects keyword cannibalization - queries ranking for multiple pages.
 * Returns queries where multiple pages compete for the same search term.
 */
export async function detectCannibalization(
  auth: GscAuth,
  siteUrl: string,
  options: CannibalizationOptions = {},
): Promise<CannibalizationResult[]> {
  const {
    period = { start: dayjs().subtract(28, 'day').toDate(), end: dayjs().toDate() },
    minImpressions = 10,
    maxPositionSpread = 10,
    minPages = 2,
    sortBy = 'clicks',
    sortOrder = 'desc',
  } = options

  // Fetch query + page data
  const { data } = await queryRecursive(auth, siteUrl, {
    ...createQueryBody({ period }),
    dimensions: ['query', 'page'],
  })

  // Group by query
  const queryMap = new Map<string, CannibalizationPage[]>()

  for (const row of data.rows) {
    const query = row.keys?.[0] || ''
    const page = row.keys?.[1] || ''
    const impressions = row.impressions || 0

    if (impressions < minImpressions)
      continue

    const pages = queryMap.get(query) || []
    pages.push({
      page,
      clicks: row.clicks || 0,
      impressions,
      ctr: row.ctr || 0,
      position: row.position || 0,
    })
    queryMap.set(query, pages)
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

  // Sort results
  const sortMultiplier = sortOrder === 'desc' ? -1 : 1
  return results.sort((a, b) => {
    switch (sortBy) {
      case 'clicks':
        return (a.totalClicks - b.totalClicks) * sortMultiplier
      case 'impressions':
        return (a.totalImpressions - b.totalImpressions) * sortMultiplier
      case 'positionSpread':
        return (a.positionSpread - b.positionSpread) * sortMultiplier
      case 'pageCount':
        return (a.pages.length - b.pages.length) * sortMultiplier
      default:
        return (a.totalClicks - b.totalClicks) * sortMultiplier
    }
  })
}

// ============================================================================
// Striking Distance Keywords
// ============================================================================

export type StrikingDistanceSortMetric = 'clicks' | 'impressions' | 'ctr' | 'position' | 'potentialClicks'

export interface StrikingDistanceOptions {
  period?: Period
  /** Minimum position (inclusive). Default: 4 */
  minPosition?: number
  /** Maximum position (inclusive). Default: 20 */
  maxPosition?: number
  /** Minimum impressions. Default: 100 */
  minImpressions?: number
  /** Maximum CTR (queries with low CTR have more potential). Default: 0.05 (5%) */
  maxCtr?: number
  /** Metric to sort results by. Default: 'potentialClicks' */
  sortBy?: StrikingDistanceSortMetric
  /** Sort order. Default: 'desc' */
  sortOrder?: SortOrder
}

export interface StrikingDistanceResult {
  query: string
  page: string | null
  clicks: number
  impressions: number
  ctr: number
  position: number
  /** Estimated clicks if position improved to top 3 */
  potentialClicks: number
}

/**
 * Finds striking distance keywords - high impressions, low CTR, position 4-20.
 * These are "quick wins" that could gain significant traffic with small ranking improvements.
 */
export async function findStrikingDistance(
  auth: GscAuth,
  siteUrl: string,
  options: StrikingDistanceOptions = {},
): Promise<StrikingDistanceResult[]> {
  const {
    period = { start: dayjs().subtract(28, 'day').toDate(), end: dayjs().toDate() },
    minPosition = 4,
    maxPosition = 20,
    minImpressions = 100,
    maxCtr = 0.05,
    sortBy = 'potentialClicks',
    sortOrder = 'desc',
  } = options

  // Fetch query data with pages
  const [queryData, pageData] = await Promise.all([
    queryRecursive(auth, siteUrl, {
      ...createQueryBody({ period }),
      dimensions: ['query'],
    }),
    queryRecursive(auth, siteUrl, {
      ...createQueryBody({ period }),
      dimensions: ['query', 'page'],
    }),
  ])

  // Build page lookup (top page per query)
  const pageMap = new Map<string, string>()
  for (const row of pageData.data.rows) {
    const query = row.keys?.[0] || ''
    const page = row.keys?.[1] || ''
    // First occurrence is highest traffic page
    if (!pageMap.has(query))
      pageMap.set(query, page)
  }

  const results: StrikingDistanceResult[] = []

  for (const row of queryData.data.rows) {
    const query = row.keys?.[0] || ''
    const position = row.position || 0
    const impressions = row.impressions || 0
    const ctr = row.ctr || 0
    const clicks = row.clicks || 0

    // Apply filters
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
      query,
      page: pageMap.get(query) || null,
      clicks,
      impressions,
      ctr,
      position,
      potentialClicks,
    })
  }

  // Sort results
  const sortMultiplier = sortOrder === 'desc' ? -1 : 1
  return results.sort((a, b) => {
    switch (sortBy) {
      case 'clicks':
        return (a.clicks - b.clicks) * sortMultiplier
      case 'impressions':
        return (a.impressions - b.impressions) * sortMultiplier
      case 'ctr':
        return (a.ctr - b.ctr) * sortMultiplier
      case 'position':
        return (a.position - b.position) * sortMultiplier
      case 'potentialClicks':
        return (a.potentialClicks - b.potentialClicks) * sortMultiplier
      default:
        return (a.potentialClicks - b.potentialClicks) * sortMultiplier
    }
  })
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
  withinGscLimit: boolean
}

/**
 * Fetches year-over-year comparison for site metrics.
 * GSC has ~16 months history, so works for periods up to ~4 months.
 */
export async function fetchYoYComparison(
  auth: GscAuth,
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
  const withinGscLimit = daysSincePrevStart <= 480 // ~16 months

  const [currentRes, previousRes] = await Promise.all([
    gscClient.searchAnalytics.query(auth, siteUrl, {
      ...createQueryBody({ period }),
      dimensions: ['date'],
    }),
    withinGscLimit
      ? gscClient.searchAnalytics.query(auth, siteUrl, {
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
    withinGscLimit,
  }
}

// ============================================================================
// Movers & Shakers (Trend Detection)
// ============================================================================

export type MoversSortMetric = 'clicks' | 'impressions' | 'clicksChange' | 'impressionsChange' | 'positionChange'

export interface MoversAndShakersOptions {
  /** Recent/current period to analyze. Default: last 7 days */
  period?: Period
  /** Baseline period to compare against. Default: 4 weeks before period */
  comparePeriod?: Period
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
  auth: GscAuth,
  siteUrl: string,
  options: MoversAndShakersOptions = {},
): Promise<MoversAndShakersResult> {
  const {
    period,
    comparePeriod,
    changeThreshold = 0.2,
    minImpressions = 50,
    sortBy = 'clicksChange',
  } = options

  // Default period: last 7 days
  const recentStart = period ? dayjs(period.start) : dayjs().subtract(7, 'day')
  const recentEnd = period ? dayjs(period.end) : dayjs()

  // Default compare period: 4 weeks before the recent period
  const baselineEnd = comparePeriod ? dayjs(comparePeriod.end) : recentStart.subtract(1, 'day')
  const baselineStart = comparePeriod ? dayjs(comparePeriod.start) : baselineEnd.subtract(28, 'day')

  // Fetch both periods
  const [recentData, baselineData, recentPages, baselinePages] = await Promise.all([
    queryRecursive(auth, siteUrl, {
      ...createQueryBody({ period: { start: recentStart.toDate(), end: recentEnd.toDate() } }),
      dimensions: ['query'],
    }),
    queryRecursive(auth, siteUrl, {
      ...createQueryBody({ period: { start: baselineStart.toDate(), end: baselineEnd.toDate() } }),
      dimensions: ['query'],
    }),
    queryRecursive(auth, siteUrl, {
      ...createQueryBody({ period: { start: recentStart.toDate(), end: recentEnd.toDate() } }),
      dimensions: ['query', 'page'],
    }),
    queryRecursive(auth, siteUrl, {
      ...createQueryBody({ period: { start: baselineStart.toDate(), end: baselineEnd.toDate() } }),
      dimensions: ['query', 'page'],
    }),
  ])

  // Calculate period lengths for normalization
  const recentDays = recentEnd.diff(recentStart, 'day') || 1
  const baselineDays = baselineEnd.diff(baselineStart, 'day') || 1
  const normalizationFactor = baselineDays / recentDays

  // Build lookup maps
  const baselineMap = new Map<string, { clicks: number, impressions: number, position: number }>()
  for (const row of baselineData.data.rows) {
    const query = row.keys?.[0] || ''
    // Normalize baseline to same period length as recent for fair comparison
    baselineMap.set(query, {
      clicks: (row.clicks || 0) / normalizationFactor,
      impressions: (row.impressions || 0) / normalizationFactor,
      position: row.position || 0,
    })
  }

  // Build page lookup (top page per query from recent)
  const pageMap = new Map<string, string>()
  for (const row of recentPages.data.rows) {
    const query = row.keys?.[0] || ''
    const page = row.keys?.[1] || ''
    if (!pageMap.has(query))
      pageMap.set(query, page)
  }
  // Fill in from baseline for queries not in recent
  for (const row of baselinePages.data.rows) {
    const query = row.keys?.[0] || ''
    const page = row.keys?.[1] || ''
    if (!pageMap.has(query))
      pageMap.set(query, page)
  }

  const rising: MoverData[] = []
  const declining: MoverData[] = []
  const stable: MoverData[] = []

  // Process recent queries
  for (const row of recentData.data.rows) {
    const query = row.keys?.[0] || ''
    const recentClicks = row.clicks || 0
    const recentImpressions = row.impressions || 0
    const recentPosition = row.position || 0

    if (recentImpressions < minImpressions)
      continue

    const baseline = baselineMap.get(query) || { clicks: 0, impressions: 0, position: 0 }
    const clicksChangePercent = percentDifference(recentClicks, baseline.clicks)
    const impressionsChangePercent = percentDifference(recentImpressions, baseline.impressions)

    const data: MoverData = {
      query,
      page: pageMap.get(query) || null,
      recentClicks,
      recentImpressions,
      recentPosition,
      baselineClicks: Math.round(baseline.clicks),
      baselineImpressions: Math.round(baseline.impressions),
      baselinePosition: baseline.position,
      clicksChange: recentClicks - Math.round(baseline.clicks),
      clicksChangePercent,
      impressionsChangePercent,
      positionChange: recentPosition - baseline.position,
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
  const sortFn = (a: MoverData, b: MoverData) => {
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

// ============================================================================
// Content Decay Detection
// ============================================================================

export type DecaySortMetric = 'lostClicks' | 'declinePercent' | 'currentClicks'

export interface ContentDecayOptions {
  /** Current period to analyze. Default: last 28 days */
  period?: Period
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

/**
 * Identifies "decaying" content - pages that have lost significant traffic compared to the past.
 * Useful for finding old blog posts that need updating.
 */
export async function detectContentDecay(
  auth: GscAuth,
  siteUrl: string,
  options: ContentDecayOptions = {},
): Promise<DecayResult[]> {
  const {
    period = { start: dayjs().subtract(28, 'day').toDate(), end: dayjs().toDate() },
    lookbackDays = 365,
    minPreviousClicks = 50,
    threshold = 0.2,
    sortBy = 'lostClicks',
  } = options

  const currentStart = dayjs(period.start)
  const currentEnd = dayjs(period.end)
  const duration = currentEnd.diff(currentStart, 'day')

  // Calculate historical period (shifted back by lookbackDays)
  const prevStart = currentStart.subtract(lookbackDays, 'day')
  const prevEnd = prevStart.add(duration, 'day')

  // Check if within GSC limits (~16 months = 486 days)
  if (dayjs().diff(prevStart, 'day') > 486) {
    throw new Error(`Lookback period exceeds GSC 16-month retention limit. Reduce lookbackDays (currently ${lookbackDays}).`)
  }

  // Fetch data
  const [currentData, prevData] = await Promise.all([
    queryRecursive(auth, siteUrl, {
      ...createQueryBody({ period: { start: currentStart.toDate(), end: currentEnd.toDate() } }),
      dimensions: ['page'],
    }),
    queryRecursive(auth, siteUrl, {
      ...createQueryBody({ period: { start: prevStart.toDate(), end: prevEnd.toDate() } }),
      dimensions: ['page'],
    }),
  ])

  // Map previous data
  const prevMap = new Map<string, { clicks: number, position: number }>()
  for (const row of prevData.data.rows) {
    const page = row.keys?.[0] || ''
    if ((row.clicks || 0) >= minPreviousClicks) {
      prevMap.set(page, {
        clicks: row.clicks || 0,
        position: row.position || 0,
      })
    }
  }

  const results: DecayResult[] = []

  // Compare with current
  const currentMap = new Map<string, { clicks: number, position: number }>()
  for (const row of currentData.data.rows) {
    const page = row.keys?.[0] || ''
    currentMap.set(page, {
      clicks: row.clicks || 0,
      position: row.position || 0,
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

  // Sort
  return results.sort((a, b) => {
    switch (sortBy) {
      case 'lostClicks':
        return b.lostClicks - a.lostClicks
      case 'declinePercent':
        return b.declinePercent - a.declinePercent
      case 'currentClicks':
        return a.currentClicks - b.currentClicks // Ascending (lowest traffic first)
      default:
        return b.lostClicks - a.lostClicks
    }
  })
}

// ============================================================================
// Zero-Click Query Detection
// ============================================================================

export interface ZeroClickOptions {
  period?: Period
  /** Minimum impressions. Default: 1000 */
  minImpressions?: number
  /** Maximum CTR to be considered "Zero Click". Default: 0.03 (3%) */
  maxCtr?: number
  /** Only consider queries in top X positions. Default: 10 */
  maxPosition?: number
}

export interface ZeroClickResult {
  query: string
  impressions: number
  clicks: number
  ctr: number
  position: number
  page: string | null
}

/**
 * Identifies potential "Zero-Click" queries.
 * These are high-volume queries where you rank well but get few clicks,
 * often due to SERP features (Answer Boxes, Knowledge Panels, AI Overviews).
 */
export async function findZeroClickQueries(
  auth: GscAuth,
  siteUrl: string,
  options: ZeroClickOptions = {},
): Promise<ZeroClickResult[]> {
  const {
    period = { start: dayjs().subtract(28, 'day').toDate(), end: dayjs().toDate() },
    minImpressions = 1000,
    maxCtr = 0.03, // 3%
    maxPosition = 10,
  } = options

  // Fetch queries with pages
  const { data } = await queryRecursive(auth, siteUrl, {
    ...createQueryBody({ period }),
    dimensions: ['query', 'page'],
  })

  const results: ZeroClickResult[] = []

  // Group by query to find top page per query
  const queryMap = new Map<string, { page: string, clicks: number, impressions: number, position: number, ctr: number }>()

  for (const row of data.rows) {
    const query = row.keys?.[0] || ''
    const page = row.keys?.[1] || ''
    const impressions = row.impressions || 0
    const position = row.position || 0
    const ctr = row.ctr || 0
    const clicks = row.clicks || 0

    if (impressions < minImpressions)
      continue
    if (position > maxPosition)
      continue
    if (ctr > maxCtr)
      continue

    // If query already exists, keep the one with better position (or more traffic)
    const existing = queryMap.get(query)
    if (!existing || position < existing.position) {
      queryMap.set(query, { page, clicks, impressions, position, ctr })
    }
  }

  for (const [query, metrics] of queryMap) {
    results.push({
      query,
      ...metrics,
    })
  }

  return results.sort((a, b) => b.impressions - a.impressions)
}

/**
 * Movers and shakers analysis - identifies keywords with significant changes.
 */

import type { KeywordRow } from './types'
import { num } from './types'

export type MoversSortMetric = 'clicks' | 'impressions' | 'clicksChange' | 'impressionsChange' | 'positionChange'

export interface MoversOptions {
  /** Minimum change threshold to flag. Default: 0.2 (20%) */
  changeThreshold?: number
  /** Minimum impressions in recent period. Default: 50 */
  minImpressions?: number
  /** Metric to sort results by. Default: clicksChange */
  sortBy?: MoversSortMetric
}

export interface MoversInput {
  current: KeywordRow[]
  previous: KeywordRow[]
  /** If periods have different lengths, provide normalization factor (previous/current) */
  normalizationFactor?: number
}

export interface MoverData {
  keyword: string
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

export interface MoversResult {
  rising: MoverData[]
  declining: MoverData[]
  stable: MoverData[]
}

function percentDifference(current: number, previous: number): number {
  if (previous === 0)
    return current > 0 ? 100 : 0
  return ((current - previous) / previous) * 100
}

/**
 * Identifies movers and shakers - keywords with significant recent changes.
 */
export function analyzeMovers(
  input: MoversInput,
  options: MoversOptions = {},
): MoversResult {
  const {
    changeThreshold = 0.2,
    minImpressions = 50,
    sortBy = 'clicksChange',
  } = options

  const normFactor = input.normalizationFactor ?? 1

  const baselineMap = new Map<string, { clicks: number, impressions: number, position: number, page: string | null }>()
  for (const row of input.previous) {
    baselineMap.set(row.query, {
      clicks: num(row.clicks) / normFactor,
      impressions: num(row.impressions) / normFactor,
      position: num(row.position),
      page: row.page ?? null,
    })
  }

  const pageMap = new Map<string, string>()
  for (const row of input.current) {
    if (!pageMap.has(row.query) && row.page)
      pageMap.set(row.query, row.page)
  }
  for (const row of input.previous) {
    if (!pageMap.has(row.query) && row.page)
      pageMap.set(row.query, row.page)
  }

  const rising: MoverData[] = []
  const declining: MoverData[] = []
  const stable: MoverData[] = []

  for (const row of input.current) {
    const impressions = num(row.impressions)
    const clicks = num(row.clicks)
    const position = num(row.position)

    if (impressions < minImpressions)
      continue

    const baseline = baselineMap.get(row.query) || { clicks: 0, impressions: 0, position: 0, page: null }
    const clicksChangePercent = percentDifference(clicks, baseline.clicks)
    const impressionsChangePercent = percentDifference(impressions, baseline.impressions)

    const data: MoverData = {
      keyword: row.query,
      page: pageMap.get(row.query) ?? null,
      recentClicks: clicks,
      recentImpressions: impressions,
      recentPosition: position,
      baselineClicks: Math.round(baseline.clicks),
      baselineImpressions: Math.round(baseline.impressions),
      baselinePosition: baseline.position,
      clicksChange: clicks - Math.round(baseline.clicks),
      clicksChangePercent,
      impressionsChangePercent,
      positionChange: position - baseline.position,
    }

    const absChange = Math.abs(clicksChangePercent / 100)

    if (clicksChangePercent > 0 && absChange >= changeThreshold)
      rising.push(data)
    else if (clicksChangePercent < 0 && absChange >= changeThreshold)
      declining.push(data)
    else
      stable.push(data)
  }

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

  return { rising, declining, stable }
}

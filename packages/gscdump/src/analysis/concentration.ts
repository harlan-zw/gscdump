import type { GoogleSearchConsoleClient } from '../core/client'
import type { BaseAnalysisOptions } from './types'
import { defaultQuery, executeAnalysisQuery } from './types'

export type ConcentrationDimension = 'page' | 'keyword'
export type ConcentrationRiskLevel = 'low' | 'medium' | 'high'

export interface ConcentrationOptions extends BaseAnalysisOptions {
  /** Dimension to analyze concentration for. Default: 'page' */
  dimension?: ConcentrationDimension
  /** Number of top items to report. Default: 10 */
  topN?: number
}

export interface ConcentrationItem {
  key: string
  clicks: number
  share: number // 0-1
}

export interface ConcentrationResult {
  /** Gini coefficient: 0 = equal distribution, 1 = fully concentrated */
  giniCoefficient: number
  /** Herfindahl-Hirschman Index: 0-10000, >2500 = highly concentrated */
  hhi: number
  /** Percentage of total clicks from top N items */
  topNConcentration: number
  topNItems: ConcentrationItem[]
  totalItems: number
  totalClicks: number
  /** Risk level derived from HHI: <1500 low, 1500-2500 medium, >2500 high */
  riskLevel: ConcentrationRiskLevel
}

/**
 * Calculates Gini coefficient for a list of values.
 * Formula: sum((2*i - n - 1) * x_i) / (n * sum(x_i))
 * where i is 1-indexed rank and x_i is sorted ascending
 */
function calculateGini(values: number[]): number {
  if (values.length === 0)
    return 0
  const sorted = [...values].sort((a, b) => a - b)
  const n = sorted.length
  const sum = sorted.reduce((a, b) => a + b, 0)
  if (sum === 0)
    return 0

  let weightedSum = 0
  for (let i = 0; i < n; i++) {
    weightedSum += (2 * (i + 1) - n - 1) * sorted[i]
  }
  return weightedSum / (n * sum)
}

/**
 * Calculates Herfindahl-Hirschman Index (HHI).
 * Formula: sum((share_i * 100)^2) where share = clicks/total
 * Range: 0-10000 (0 = perfect competition, 10000 = monopoly)
 */
function calculateHHI(shares: number[]): number {
  return shares.reduce((sum, share) => sum + (share * 100) ** 2, 0)
}

/**
 * Analyzes traffic concentration across pages or keywords.
 * Returns Gini coefficient, HHI, and top-N concentration metrics.
 */
export async function analyzeTrafficConcentration(
  client: GoogleSearchConsoleClient,
  siteUrl: string,
  options: ConcentrationOptions = {},
): Promise<ConcentrationResult> {
  const {
    query = defaultQuery(),
    dimension = 'page',
    topN = 10,
  } = options

  const gscDimension = dimension === 'keyword' ? 'query' : 'page'

  const { rows } = await executeAnalysisQuery(client, siteUrl, query, [gscDimension])

  if (rows.length === 0) {
    return {
      giniCoefficient: 0,
      hhi: 0,
      topNConcentration: 0,
      topNItems: [],
      totalItems: 0,
      totalClicks: 0,
      riskLevel: 'low',
    }
  }

  // Extract clicks per item
  const items: { key: string, clicks: number }[] = rows.map(row => ({
    key: (gscDimension === 'query' ? row.query : row.page) || '',
    clicks: row.clicks,
  }))

  // Sort by clicks desc
  items.sort((a, b) => b.clicks - a.clicks)

  const totalClicks = items.reduce((sum, item) => sum + item.clicks, 0)
  const clickValues = items.map(i => i.clicks)

  // Calculate shares
  const shares = totalClicks > 0 ? items.map(i => i.clicks / totalClicks) : []

  // Calculate metrics
  const giniCoefficient = calculateGini(clickValues)
  const hhi = calculateHHI(shares)

  // Top N
  const topNItems: ConcentrationItem[] = items.slice(0, topN).map(item => ({
    key: item.key,
    clicks: item.clicks,
    share: totalClicks > 0 ? item.clicks / totalClicks : 0,
  }))

  const topNClicks = topNItems.reduce((sum, item) => sum + item.clicks, 0)
  const topNConcentration = totalClicks > 0 ? topNClicks / totalClicks : 0

  // Determine risk level from HHI
  let riskLevel: ConcentrationRiskLevel = 'low'
  if (hhi > 2500)
    riskLevel = 'high'
  else if (hhi > 1500)
    riskLevel = 'medium'

  return {
    giniCoefficient,
    hhi,
    topNConcentration,
    topNItems,
    totalItems: items.length,
    totalClicks,
    riskLevel,
  }
}

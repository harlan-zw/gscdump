/**
 * Traffic concentration analysis - measures distribution across pages/keywords.
 * Pure function operating on page or keyword data.
 */

import { num } from './types'

export type ConcentrationRiskLevel = 'low' | 'medium' | 'high'

export interface ConcentrationOptions {
  /** Number of top items to report. Default: 10 */
  topN?: number
}

export interface ConcentrationItem {
  key: string
  clicks: number
  share: number
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
 * Formula: sum((share_i * 100)^2)
 * Range: 0-10000 (0 = perfect competition, 10000 = monopoly)
 */
function calculateHHI(shares: number[]): number {
  return shares.reduce((sum, share) => sum + (share * 100) ** 2, 0)
}

/** Item with a key and clicks for concentration analysis */
export interface ConcentrationInput {
  key: string
  clicks: number
}

/**
 * Analyzes traffic concentration across items (pages or keywords).
 * Returns Gini coefficient, HHI, and top-N concentration metrics.
 *
 * @param items Array of items with key and clicks
 * @param options Configuration options
 */
export function analyzeConcentration(
  items: ConcentrationInput[],
  options: ConcentrationOptions = {},
): ConcentrationResult {
  const { topN = 10 } = options

  if (items.length === 0) {
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

  // Sort by clicks desc
  const sorted = [...items].sort((a, b) => b.clicks - a.clicks)

  const totalClicks = sorted.reduce((sum, item) => sum + item.clicks, 0)
  const clickValues = sorted.map(i => i.clicks)

  // Calculate shares
  const shares = totalClicks > 0 ? sorted.map(i => i.clicks / totalClicks) : []

  // Calculate metrics
  const giniCoefficient = calculateGini(clickValues)
  const hhi = calculateHHI(shares)

  // Top N
  const topNItems: ConcentrationItem[] = sorted.slice(0, topN).map(item => ({
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

/** Item with page and optional/nullable clicks */
interface PageLike {
  page: string
  clicks?: number | null
}

/** Item with keyword and optional/nullable clicks */
interface KeywordLike {
  keyword: string
  clicks?: number | null
}

/**
 * Convenience wrapper for page concentration analysis.
 */
export function analyzePageConcentration(
  pages: PageLike[],
  options?: ConcentrationOptions,
): ConcentrationResult {
  return analyzeConcentration(
    pages.map(p => ({ key: p.page, clicks: num(p.clicks) })),
    options,
  )
}

/**
 * Convenience wrapper for keyword concentration analysis.
 */
export function analyzeKeywordConcentration(
  keywords: KeywordLike[],
  options?: ConcentrationOptions,
): ConcentrationResult {
  return analyzeConcentration(
    keywords.map(k => ({ key: k.keyword, clicks: num(k.clicks) })),
    options,
  )
}

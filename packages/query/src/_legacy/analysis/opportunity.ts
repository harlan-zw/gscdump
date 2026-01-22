/**
 * Opportunity score analysis - scores keywords by optimization potential.
 * Pure function operating on keyword data.
 */

import type { KeywordData } from '../api/search-analytics/types'
import type { SortOrder } from './types'
import { createSorter, num } from './types'

export type OpportunitySortMetric = 'opportunityScore' | 'potentialClicks' | 'impressions' | 'position'

export interface OpportunityWeights {
  position?: number
  impressions?: number
  ctrGap?: number
}

export interface OpportunityOptions {
  /** Minimum impressions to consider. Default: 100 */
  minImpressions?: number
  /** Custom weights for score factors. Default: all 1 */
  weights?: OpportunityWeights
  /** Sort metric. Default: opportunityScore */
  sortBy?: OpportunitySortMetric
}

export interface OpportunityFactors {
  positionScore: number
  impressionScore: number
  ctrGapScore: number
}

export interface OpportunityResult {
  keyword: string
  page: string | null
  clicks: number
  impressions: number
  ctr: number
  position: number
  opportunityScore: number
  potentialClicks: number
  factors: OpportunityFactors
}

// Expected CTR by position (rough industry averages)
const EXPECTED_CTR_BY_POSITION: Record<number, number> = {
  1: 0.30,
  2: 0.15,
  3: 0.10,
  4: 0.07,
  5: 0.05,
  6: 0.04,
  7: 0.03,
  8: 0.025,
  9: 0.02,
  10: 0.015,
}

function getExpectedCtr(position: number): number {
  const roundedPos = Math.round(Math.max(1, Math.min(position, 10)))
  return EXPECTED_CTR_BY_POSITION[roundedPos] || 0.01
}

/**
 * Position score: higher for positions 4-20 (improvable range).
 * Peak opportunity at positions 8-15.
 */
function calculatePositionScore(position: number): number {
  if (position <= 3)
    return 0.2 // Already ranking well
  if (position > 50)
    return 0.1 // Too far gone

  // Bell curve peaking around position 10-12
  const optimal = 11
  const distance = Math.abs(position - optimal)
  return Math.max(0, 1 - (distance / 15))
}

/**
 * Impression score using log scale.
 * Higher impressions = more traffic potential.
 */
function calculateImpressionScore(impressions: number): number {
  if (impressions <= 0)
    return 0
  // Log scale, normalized roughly to 0-1
  // 100 impressions ~ 0.3, 1000 ~ 0.5, 10000 ~ 0.7
  return Math.min(Math.log10(impressions) / 5, 1)
}

/**
 * CTR gap score: difference between actual and expected CTR.
 * Higher gap = more opportunity for improvement.
 */
function calculateCtrGapScore(actualCtr: number, position: number): number {
  const expectedCtr = getExpectedCtr(position)
  if (actualCtr >= expectedCtr)
    return 0 // Already performing at or above expected
  const gap = expectedCtr - actualCtr
  // Normalize gap to 0-1 range
  return Math.min(gap / expectedCtr, 1)
}

const SORT_ORDER: Record<OpportunitySortMetric, SortOrder> = {
  opportunityScore: 'desc',
  potentialClicks: 'desc',
  impressions: 'desc',
  position: 'asc',
}

const sortResults = createSorter<OpportunityResult, OpportunitySortMetric>(
  (item, metric) => item[metric],
  'opportunityScore',
)

/**
 * Scores keywords by optimization opportunity.
 * Composite score combining position, impressions, and CTR gap factors.
 */
export function analyzeOpportunity(
  keywords: KeywordData[],
  options: OpportunityOptions = {},
): OpportunityResult[] {
  const {
    minImpressions = 100,
    weights = {},
    sortBy = 'opportunityScore',
  } = options

  const positionWeight = weights.position ?? 1
  const impressionsWeight = weights.impressions ?? 1
  const ctrGapWeight = weights.ctrGap ?? 1

  const results: OpportunityResult[] = []

  for (const row of keywords) {
    const impressions = num(row.impressions)
    const position = num(row.position)
    const ctr = num(row.ctr)
    const clicks = num(row.clicks)

    if (impressions < minImpressions)
      continue

    // Calculate factor scores
    const positionScore = calculatePositionScore(position)
    const impressionScore = calculateImpressionScore(impressions)
    const ctrGapScore = calculateCtrGapScore(ctr, position)

    // Composite opportunity score (weighted geometric mean, normalized to 0-100)
    const weightedProduct
      = (positionScore ** positionWeight)
        * (impressionScore ** impressionsWeight)
        * (ctrGapScore ** ctrGapWeight)

    const totalWeight = positionWeight + impressionsWeight + ctrGapWeight
    const geometricMean = weightedProduct ** (1 / totalWeight)
    const opportunityScore = Math.round(geometricMean * 100)

    // Calculate potential clicks if position improved to 3
    const targetCtr = getExpectedCtr(Math.min(3, position))
    const potentialClicks = Math.round(impressions * targetCtr)

    results.push({
      keyword: row.keyword,
      page: row.page ?? null,
      clicks,
      impressions,
      ctr,
      position,
      opportunityScore,
      potentialClicks,
      factors: {
        positionScore,
        impressionScore,
        ctrGapScore,
      },
    })
  }

  return sortResults(results, sortBy, SORT_ORDER[sortBy])
}

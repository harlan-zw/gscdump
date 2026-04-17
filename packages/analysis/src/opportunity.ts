/**
 * Opportunity score analysis - scores keywords by optimization potential.
 */

import type { KeywordRow, SortOrder } from './types'
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

function calculatePositionScore(position: number): number {
  if (position <= 3)
    return 0.2
  if (position > 50)
    return 0.1
  const optimal = 11
  const distance = Math.abs(position - optimal)
  return Math.max(0, 1 - (distance / 15))
}

function calculateImpressionScore(impressions: number): number {
  if (impressions <= 0)
    return 0
  return Math.min(Math.log10(impressions) / 5, 1)
}

function calculateCtrGapScore(actualCtr: number, position: number): number {
  const expectedCtr = getExpectedCtr(position)
  if (actualCtr >= expectedCtr)
    return 0
  const gap = expectedCtr - actualCtr
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
  keywords: KeywordRow[],
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

    const positionScore = calculatePositionScore(position)
    const impressionScore = calculateImpressionScore(impressions)
    const ctrGapScore = calculateCtrGapScore(ctr, position)

    const weightedProduct
      = (positionScore ** positionWeight)
        * (impressionScore ** impressionsWeight)
        * (ctrGapScore ** ctrGapWeight)

    const totalWeight = positionWeight + impressionsWeight + ctrGapWeight
    const geometricMean = weightedProduct ** (1 / totalWeight)
    const opportunityScore = Math.round(geometricMean * 100)

    const targetCtr = getExpectedCtr(Math.min(3, position))
    const potentialClicks = Math.round(impressions * targetCtr)

    results.push({
      keyword: row.query,
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

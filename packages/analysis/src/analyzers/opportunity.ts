/**
 * `opportunity` — scores keywords by optimization potential. SQL groups by
 * (query, url) and computes the composite score in DuckDB; the row reducer
 * mirrors the same scoring logic against live-GSC rows. Plans diverge in
 * mechanics (DuckDB CASE expressions vs JS helpers) but produce equivalent
 * `OpportunityResult` shapes.
 */

import type { AnalysisParams } from '@gscdump/engine/analysis-types'
import type { Row } from '@gscdump/engine/contracts'
import type { QueriesRow } from '../types'
import { num } from '@gscdump/engine/analysis-types'
import { defineAnalyzer } from '@gscdump/engine/analyzer'
import { periodOf } from '@gscdump/engine/period'
import { enumeratePartitions } from '@gscdump/engine/planner'
import { METRIC_EXPR } from '@gscdump/engine/sql-fragments'
import { queriesQueryState } from '../analyzer/adapt-rows'
import { paginateClause, paginateSortedInMemory } from '../analyzer/paginate'

export type OpportunitySortMetric = 'opportunityScore' | 'potentialClicks' | 'impressions' | 'position'

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

export interface OpportunityWeights {
  position?: number
  impressions?: number
  ctrGap?: number
}

export interface OpportunityOptions {
  minImpressions?: number
  weights?: OpportunityWeights
  sortBy?: OpportunitySortMetric
  limit?: number
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

const SORT_DIR: Record<OpportunitySortMetric, 'asc' | 'desc'> = {
  opportunityScore: 'desc',
  potentialClicks: 'desc',
  impressions: 'desc',
  position: 'asc',
}

/** Pure opportunity scorer shared by hosted and package analyzer callers. */
export function analyzeOpportunity(
  keywords: QueriesRow[],
  options: OpportunityOptions = {},
): OpportunityResult[] {
  const minImpressions = options.minImpressions ?? 100
  const positionWeight = options.weights?.position ?? 1
  const impressionsWeight = options.weights?.impressions ?? 1
  const ctrGapWeight = options.weights?.ctrGap ?? 1
  const totalWeight = positionWeight + impressionsWeight + ctrGapWeight
  const sortBy = options.sortBy ?? 'opportunityScore'
  const results: OpportunityResult[] = []

  for (const row of keywords) {
    const impressions = num(row.impressions)
    if (impressions < minImpressions)
      continue
    const position = num(row.position)
    const ctr = num(row.ctr)
    const clicks = num(row.clicks)
    const positionScore = calculatePositionScore(position)
    const impressionScore = calculateImpressionScore(impressions)
    const ctrGapScore = calculateCtrGapScore(ctr, position)
    const weightedProduct
      = (positionScore ** positionWeight)
        * (impressionScore ** impressionsWeight)
        * (ctrGapScore ** ctrGapWeight)
    const opportunityScore = Math.round(weightedProduct ** (1 / totalWeight) * 100)
    const potentialClicks = Math.round(impressions * getExpectedCtr(Math.min(3, position)))

    results.push({
      keyword: row.query,
      page: row.page ?? null,
      clicks,
      impressions,
      ctr,
      position,
      opportunityScore,
      potentialClicks,
      factors: { positionScore, impressionScore, ctrGapScore },
    })
  }

  const direction = SORT_DIR[sortBy]
  results.sort((left, right) => direction === 'asc'
    ? left[sortBy] - right[sortBy]
    : right[sortBy] - left[sortBy])
  return options.limit ? results.slice(0, options.limit) : results
}

export const opportunityAnalyzer = defineAnalyzer<AnalysisParams, Row, OpportunityResult[]>({
  id: 'opportunity',

  buildSql(params) {
    const { startDate, endDate } = periodOf(params)
    const minImpressions = params.minImpressions ?? 100
    const w1 = 1
    const w2 = 1
    const w3 = 1
    const totalW = w1 + w2 + w3
    const limit = params.limit ?? 1000

    const sql = `
    WITH agg AS (
      SELECT
        query AS keyword,
        url AS page,
        ${METRIC_EXPR.clicks} AS clicks,
        ${METRIC_EXPR.impressions} AS impressions,
        ${METRIC_EXPR.ctr} AS ctr,
        ${METRIC_EXPR.position} AS position
      FROM read_parquet({{FILES}}, union_by_name = true)
      WHERE date >= ? AND date <= ?
      GROUP BY query, url
      HAVING SUM(impressions) >= ?
    ),
    scored AS (
      SELECT
        keyword, page, clicks, impressions, ctr, position,
        CASE
          WHEN position <= 3 THEN 0.2
          WHEN position > 50 THEN 0.1
          ELSE GREATEST(0.0, 1.0 - ABS(position - 11.0) / 15.0)
        END AS positionScore,
        CASE WHEN impressions <= 0 THEN 0.0 ELSE LEAST(LOG10(impressions) / 5.0, 1.0) END AS impressionScore,
        CASE CAST(ROUND(GREATEST(LEAST(position, 10.0), 1.0)) AS INTEGER)
          WHEN 1 THEN 0.30
          WHEN 2 THEN 0.15
          WHEN 3 THEN 0.10
          WHEN 4 THEN 0.07
          WHEN 5 THEN 0.05
          WHEN 6 THEN 0.04
          WHEN 7 THEN 0.03
          WHEN 8 THEN 0.025
          WHEN 9 THEN 0.02
          WHEN 10 THEN 0.015
          ELSE 0.01
        END AS expectedCtr
      FROM agg
    ),
    gapped AS (
      SELECT
        *,
        CASE WHEN ctr >= expectedCtr THEN 0.0 ELSE LEAST((expectedCtr - ctr) / expectedCtr, 1.0) END AS ctrGapScore
      FROM scored
    )
    SELECT
      keyword, page, clicks, impressions, ctr, position,
      CAST(ROUND(POWER(
        POWER(positionScore, ${w1}) * POWER(impressionScore, ${w2}) * POWER(ctrGapScore, ${w3}),
        1.0 / ${totalW}
      ) * 100) AS DOUBLE) AS opportunityScore,
      CAST(ROUND(impressions * (
        CASE CAST(ROUND(GREATEST(LEAST(position, 3.0), 1.0)) AS INTEGER)
          WHEN 1 THEN 0.30
          WHEN 2 THEN 0.15
          WHEN 3 THEN 0.10
          ELSE 0.10
        END
      )) AS DOUBLE) AS potentialClicks,
      positionScore, impressionScore, ctrGapScore
    FROM gapped
    ORDER BY opportunityScore DESC
    ${paginateClause({ limit, offset: params.offset })}
  `

    return {
      sql,
      params: [startDate, endDate, minImpressions],
      current: { table: 'page_queries', partitions: enumeratePartitions(startDate, endDate) },
    }
  },

  reduceSql(rows) {
    const arr = Array.isArray(rows) ? rows : []
    return {
      results: arr.map(r => ({
        keyword: r.keyword == null ? '' : String(r.keyword),
        page: r.page == null ? null : String(r.page),
        clicks: num(r.clicks),
        impressions: num(r.impressions),
        ctr: num(r.ctr),
        position: num(r.position),
        opportunityScore: num(r.opportunityScore),
        potentialClicks: num(r.potentialClicks),
        factors: {
          positionScore: num(r.positionScore),
          impressionScore: num(r.impressionScore),
          ctrGapScore: num(r.ctrGapScore),
        },
      })),
      meta: { total: arr.length },
    }
  },

  buildRows(params) {
    return {
      queries: queriesQueryState(periodOf(params), params.limit),
    }
  },

  reduceRows(rows, params) {
    const keywords = (Array.isArray(rows) ? (rows as unknown as QueriesRow[]) : []) ?? []
    const results = analyzeOpportunity(keywords, { minImpressions: params.minImpressions })

    const paged = paginateSortedInMemory(
      results,
      { limit: params.limit, offset: params.offset },
      (left, right) => right.opportunityScore - left.opportunityScore,
    )
    return { results: paged, meta: { total: results.length, returned: paged.length } }
  },
})

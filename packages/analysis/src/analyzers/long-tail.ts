/**
 * long-tail
 *
 * Per-page power-law fit on log(rank) vs log(impressions) via DuckDB's
 * REGR_SLOPE / REGR_INTERCEPT / REGR_R2 regression aggregates.
 */

import type { Row } from '@gscdump/engine/contracts'
import type { AnalysisParams } from '@gscdump/engine/analysis-types'
import { enumeratePartitions } from '@gscdump/engine/planner'
import { METRIC_EXPR } from '@gscdump/engine/sql-fragments'
import { defineAnalyzer } from '@gscdump/engine/analyzer'
import { periodOf } from '@gscdump/engine/period'
import { num } from '@gscdump/engine/analysis-types'

function str(v: unknown): string {
  return v == null ? '' : String(v)
}

function parseJsonList(v: unknown): Row[] {
  if (Array.isArray(v))
    return v as Row[]
  if (typeof v === 'string' && v.length > 0) {
    const parsed = JSON.parse(v)
    return Array.isArray(parsed) ? parsed : []
  }
  return []
}

export interface LongTailResult {
  page: string
  queryCount: number
  totalImpressions: number
  totalClicks: number
  slope: number
  intercept: number
  r2: number
  headImpressions: number
  headShare: number
  fingerprint: 'flat-tail' | 'balanced' | 'head-heavy'
  points: Array<{ rank: number, impressions: number, clicks: number, query: string }>
}

function downsampleLogRank(points: Row[]): Array<{ rank: number, impressions: number, clicks: number, query: string }> {
  const all = points.map(p => ({
    rank: num(p.rank),
    impressions: num(p.impressions),
    clicks: num(p.clicks),
    query: str(p.query),
  }))
  if (all.length <= 80)
    return all
  const top = all.slice(0, 10)
  const rest = all.slice(10)
  const stepped: typeof all = []
  let nextThreshold = 1.15
  for (const p of rest) {
    if (p.rank >= nextThreshold) {
      stepped.push(p)
      nextThreshold *= 1.15
    }
  }
  return [...top, ...stepped]
}

export const longTailAnalyzer = defineAnalyzer<AnalysisParams, Row, LongTailResult[]>({
  id: 'long-tail',

  buildSql(params) {
    const { startDate, endDate } = periodOf(params)
    const minQueries = 10
    const minQueryImpressions = params.minImpressions ?? 5
    const limit = params.limit ?? 100

    const sql = `
    WITH page_queries AS (
      SELECT
        url AS page,
        query,
        ${METRIC_EXPR.impressions} AS impressions,
        ${METRIC_EXPR.clicks} AS clicks
      FROM read_parquet({{FILES}}, union_by_name = true)
      WHERE date >= ? AND date <= ?
        AND query IS NOT NULL AND query <> ''
        AND url IS NOT NULL AND url <> ''
      GROUP BY url, query
      HAVING SUM(impressions) >= ?
    ),
    ranked AS (
      SELECT
        page, query, impressions, clicks,
        ROW_NUMBER() OVER (PARTITION BY page ORDER BY impressions DESC, query ASC) AS rnk
      FROM page_queries
    ),
    log_space AS (
      SELECT *,
        LN(rnk) AS log_rank,
        LN(impressions) AS log_impr
      FROM ranked
    ),
    fit AS (
      SELECT
        page,
        COUNT(*) AS query_count,
        SUM(impressions) AS total_impressions,
        SUM(clicks) AS total_clicks,
        REGR_SLOPE(log_impr, log_rank) AS slope,
        REGR_INTERCEPT(log_impr, log_rank) AS intercept,
        REGR_R2(log_impr, log_rank) AS r2,
        MAX(impressions) AS head_impressions,
        MAX(CASE WHEN rnk = 1 THEN impressions END) / NULLIF(SUM(impressions), 0) AS head_share
      FROM log_space
      GROUP BY page
      HAVING COUNT(*) >= ${Number(minQueries)}
    ),
    scatter AS (
      SELECT
        l.page,
        to_json(list({
          'rank': l.rnk,
          'impressions': l.impressions,
          'clicks': l.clicks,
          'query': l.query
        } ORDER BY l.rnk)) AS pointsJson
      FROM log_space l
      JOIN fit f USING (page)
      GROUP BY l.page
    )
    SELECT
      f.page,
      f.query_count AS queryCount,
      f.total_impressions AS totalImpressions,
      f.total_clicks AS totalClicks,
      f.slope AS slope,
      f.intercept AS intercept,
      f.r2 AS r2,
      f.head_impressions AS headImpressions,
      f.head_share AS headShare,
      s.pointsJson AS pointsJson,
      CASE
        WHEN f.slope > -0.6 THEN 'flat-tail'
        WHEN f.slope > -1.2 THEN 'balanced'
        ELSE 'head-heavy'
      END AS fingerprint
    FROM fit f
    LEFT JOIN scatter s USING (page)
    ORDER BY f.total_impressions DESC
    LIMIT ${Number(limit)}
  `

    return {
      sql,
      params: [startDate, endDate, minQueryImpressions],
      current: { table: 'page_keywords', partitions: enumeratePartitions(startDate, endDate) },
    }
  },

  reduceSql(rows) {
    const arr = Array.isArray(rows) ? rows : []
    const results = arr.map(r => ({
      page: str(r.page),
      queryCount: num(r.queryCount),
      totalImpressions: num(r.totalImpressions),
      totalClicks: num(r.totalClicks),
      slope: num(r.slope),
      intercept: num(r.intercept),
      r2: num(r.r2),
      headImpressions: num(r.headImpressions),
      headShare: num(r.headShare),
      fingerprint: str(r.fingerprint) as 'flat-tail' | 'balanced' | 'head-heavy',
      // Down-sample the scatter to <=80 points (log-spaced) to keep payload
      // tight; the fingerprint is visible at this resolution.
      points: downsampleLogRank(parseJsonList(r.pointsJson)),
    }))
    const counts = { 'flat-tail': 0, 'balanced': 0, 'head-heavy': 0 }
    for (const r of results) counts[r.fingerprint]++
    return {
      results,
      meta: {
        total: results.length,
        fingerprints: counts,
        avgSlope: results.length > 0 ? results.reduce((s, r) => s + r.slope, 0) / results.length : 0,
      },
    }
  },
})

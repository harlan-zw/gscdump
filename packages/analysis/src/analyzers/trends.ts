/**
 * trends — weekly trajectory over a rolling window (default 28 weeks)
 */

import type { Row, TableName } from '@gscdump/engine/contracts'
import type { AnalysisParams } from '../types'
import { enumeratePartitions } from '@gscdump/engine/planner'
import { METRIC_EXPR } from '@gscdump/engine/sql-fragments'
import { MS_PER_DAY, toIsoDate } from 'gscdump'
import { defineAnalyzer } from '../analyzer/define'
import { defaultEndDate } from '../period'
import { num } from '../types'

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

export type TrendCategory = 'accelerating' | 'growing' | 'steady' | 'declining' | 'cratering'

export interface TrendSeriesPoint {
  week: string
  clicks: number
  impressions: number
}

export interface TrendsResult {
  query?: string
  page?: string
  totalClicks: number
  totalImpressions: number
  weeksWithData: number
  slope: number
  growthRatio: number
  avgPosition: number
  trend: TrendCategory
  series: TrendSeriesPoint[]
}

export const trendsAnalyzer = defineAnalyzer<AnalysisParams, Row, TrendsResult[]>({
  id: 'trends',

  buildSql(params) {
    const weeks = params.weeks ?? 28
    const endDate = params.endDate || defaultEndDate()
    const startDate = params.startDate
      || toIsoDate(new Date(Date.parse(endDate) - (weeks * 7 - 1) * MS_PER_DAY))
    const minImpressions = params.minImpressions ?? 100
    const minWeeksWithData = params.minWeeksWithData ?? Math.max(2, Math.floor(weeks / 4))
    const limit = params.limit ?? 500
    const dim = params.dimension === 'keywords' ? 'keywords' : 'pages'
    const table: TableName = dim === 'keywords' ? 'keywords' : 'pages'
    const keyCol = dim === 'keywords' ? 'query' : 'url'

    // DuckDB's `date_trunc('week', d)` buckets to Monday. Series rows store
    // the week start as YYYY-MM-DD. regr_slope(clicks, week_idx) gives the
    // least-squares slope in clicks per week; growthRatio compares sum of
    // second half vs first half of the series (halves split at floor(n/2)).
    const sql = `
    WITH bucketed AS (
      SELECT
        ${keyCol} AS entity,
        date_trunc('week', CAST(date AS DATE)) AS week,
        ${METRIC_EXPR.clicks} AS clicks,
        ${METRIC_EXPR.impressions} AS impressions,
        SUM(sum_position) AS sum_position_sum
      FROM read_parquet({{FILES}}, union_by_name = true)
      WHERE date >= ? AND date <= ?
      GROUP BY entity, week
    ),
    with_meta AS (
      SELECT
        entity, week, clicks, impressions, sum_position_sum,
        ROW_NUMBER() OVER (PARTITION BY entity ORDER BY week) - 1 AS week_idx,
        COUNT(*) OVER (PARTITION BY entity) AS n_weeks,
        (ROW_NUMBER() OVER (PARTITION BY entity ORDER BY week) - 1)
          < (COUNT(*) OVER (PARTITION BY entity) / 2) AS is_first_half
      FROM bucketed
    ),
    agg AS (
      SELECT
        entity,
        SUM(clicks) AS totalClicks,
        SUM(impressions) AS totalImpressions,
        any_value(n_weeks) AS weeksWithData,
        COALESCE(regr_slope(clicks, CAST(week_idx AS DOUBLE)), 0.0) AS slope,
        SUM(CASE WHEN is_first_half THEN clicks ELSE 0 END) AS firstHalfClicks,
        SUM(CASE WHEN NOT is_first_half THEN clicks ELSE 0 END) AS secondHalfClicks,
        SUM(sum_position_sum) / NULLIF(SUM(impressions), 0) + 1 AS avgPosition,
        to_json(list({
          'week': strftime(week, '%Y-%m-%d'),
          'clicks': clicks,
          'impressions': impressions
        } ORDER BY week)) AS seriesJson
      FROM with_meta
      GROUP BY entity
      HAVING SUM(impressions) >= ? AND any_value(n_weeks) >= ?
    ),
    classified AS (
      SELECT
        *,
        CASE
          WHEN firstHalfClicks = 0 AND secondHalfClicks > 0 THEN 10.0
          WHEN firstHalfClicks = 0 THEN 1.0
          ELSE secondHalfClicks / firstHalfClicks
        END AS growthRatio
      FROM agg
    )
    SELECT
      entity,
      totalClicks,
      totalImpressions,
      weeksWithData,
      slope,
      growthRatio,
      avgPosition,
      CASE
        WHEN growthRatio >= 1.5 AND slope > 0 THEN 'accelerating'
        WHEN growthRatio >= 1.1 AND slope >= 0 THEN 'growing'
        WHEN growthRatio < 0.5 THEN 'cratering'
        WHEN growthRatio < 0.9 AND slope < 0 THEN 'declining'
        ELSE 'steady'
      END AS trend,
      seriesJson
    FROM classified
    ORDER BY
      CASE
        WHEN growthRatio >= 1.5 AND slope > 0 THEN 0
        WHEN growthRatio < 0.5 THEN 1
        WHEN growthRatio >= 1.1 AND slope >= 0 THEN 2
        WHEN growthRatio < 0.9 AND slope < 0 THEN 3
        ELSE 4
      END,
      ABS(growthRatio - 1) DESC,
      totalClicks DESC
    LIMIT ${Number(limit)}
  `

    return {
      sql,
      params: [startDate, endDate, minImpressions, minWeeksWithData],
      current: { table, partitions: enumeratePartitions(startDate, endDate) },
    }
  },

  reduceSql(rows, params) {
    const arr = Array.isArray(rows) ? rows : []
    const weeks = params.weeks ?? 28
    const endDate = params.endDate || defaultEndDate()
    const startDate = params.startDate
      || toIsoDate(new Date(Date.parse(endDate) - (weeks * 7 - 1) * MS_PER_DAY))
    const dim = params.dimension === 'keywords' ? 'keywords' : 'pages'

    const results: TrendsResult[] = arr.map((r) => {
      const series = parseJsonList(r.seriesJson).map(s => ({
        week: str(s.week),
        clicks: num(s.clicks),
        impressions: num(s.impressions),
      }))
      return {
        [dim === 'keywords' ? 'query' : 'page']: str(r.entity),
        totalClicks: num(r.totalClicks),
        totalImpressions: num(r.totalImpressions),
        weeksWithData: num(r.weeksWithData),
        slope: num(r.slope),
        growthRatio: num(r.growthRatio),
        avgPosition: num(r.avgPosition),
        trend: str(r.trend) as TrendCategory,
        series,
      } as TrendsResult
    })
    const counts = {
      accelerating: 0,
      growing: 0,
      steady: 0,
      declining: 0,
      cratering: 0,
    } as Record<string, number>
    for (const r of results) counts[r.trend] = (counts[r.trend] ?? 0) + 1
    return {
      results,
      meta: {
        total: results.length,
        dimension: dim,
        weeks: Number(weeks),
        startDate,
        endDate,
        counts,
      },
    }
  },
})

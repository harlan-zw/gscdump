/**
 * `change-point` — per-(query, url) timeseries change-point detection. SQL-only.
 *
 * Migrated from `engine-duckdb-node/src/analyzers/change-point.ts`.
 */

import type { AnalysisParams } from '@gscdump/engine/analysis-types'
import type { Row } from '@gscdump/engine/contracts'
import { defineAnalyzer } from '@gscdump/engine/analyzer'
import { defaultEndDate } from '@gscdump/engine/period'
import { enumeratePartitions } from '@gscdump/engine/planner'
import { METRIC_EXPR } from '@gscdump/engine/sql-fragments'
import { daysAgo } from 'gscdump'

function num(v: unknown): number {
  if (typeof v === 'number')
    return v
  if (typeof v === 'bigint')
    return Number(v)
  if (v == null)
    return 0
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}

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

export interface ChangePointSeriesPoint {
  date: string
  value: number
}

export interface ChangePointResult {
  keyword: string
  page: string
  totalDays: number
  totalImpressions: number
  changeDate: string
  llr: number
  leftMean: number
  rightMean: number
  delta: number
  leftStddev: number
  rightStddev: number
  direction: 'improved' | 'worsened'
  series: ChangePointSeriesPoint[]
}

export const changePointAnalyzer = defineAnalyzer<AnalysisParams, Row, ChangePointResult[]>({
  id: 'change-point',

  buildSql(params) {
    const endDate = params.endDate ?? defaultEndDate()
    const startDate = params.startDate ?? daysAgo(93)
    const minDays = 21
    const minSide = 7
    const threshold = params.threshold ?? 10
    const minImpressions = params.minImpressions ?? 50
    const metric = params.metric === 'clicks' || params.metric === 'impressions' ? params.metric : 'position'
    const limit = params.limit ?? 100

    const valueExpr = metric === 'position'
      ? METRIC_EXPR.position
      : `CAST(SUM(${metric}) AS DOUBLE)`

    const sql = `
    WITH daily AS (
      SELECT
        query,
        url AS page,
        -- Normalize at the source CTE: union_by_name=true can coerce date to
        -- VARCHAR across parquets with mixed schemas, which makes downstream
        -- strftime(date, ...) binder-error.
        CAST(date AS DATE) AS date,
        ${METRIC_EXPR.clicks} AS clicks,
        ${METRIC_EXPR.impressions} AS impressions,
        ${valueExpr} AS value
      FROM read_parquet({{FILES}}, union_by_name = true)
      WHERE date >= ? AND date <= ?
        AND query IS NOT NULL AND query <> ''
        AND url IS NOT NULL AND url <> ''
      GROUP BY query, url, date
      HAVING SUM(impressions) >= 1
    ),
    entity_stats AS (
      SELECT query, page,
        COUNT(*) AS n_total,
        SUM(impressions) AS total_impressions,
        SUM(value) AS sum_total,
        SUM(value * value) AS sumsq_total
      FROM daily
      GROUP BY query, page
      HAVING COUNT(*) >= ${Number(minDays)}
        AND SUM(impressions) >= ?
    ),
    filtered AS (
      SELECT d.*,
        e.n_total, e.sum_total, e.sumsq_total, e.total_impressions
      FROM daily d
      JOIN entity_stats e USING (query, page)
    ),
    cumulated AS (
      SELECT *,
        COUNT(*) OVER w AS n_left,
        SUM(value) OVER w AS sum_left,
        SUM(value * value) OVER w AS sumsq_left
      FROM filtered
      WINDOW w AS (
        PARTITION BY query, page
        ORDER BY date
        ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
      )
    ),
    llr_scored AS (
      SELECT *,
        (n_total - n_left) AS n_right,
        (sum_total - sum_left) AS sum_right,
        (sumsq_total - sumsq_left) AS sumsq_right,
        GREATEST(
          (sumsq_left / NULLIF(n_left, 0))
            - (sum_left / NULLIF(n_left, 0)) * (sum_left / NULLIF(n_left, 0)),
          1e-9
        ) AS var_left,
        GREATEST(
          ((sumsq_total - sumsq_left) / NULLIF(n_total - n_left, 0))
            - ((sum_total - sum_left) / NULLIF(n_total - n_left, 0))
              * ((sum_total - sum_left) / NULLIF(n_total - n_left, 0)),
          1e-9
        ) AS var_right,
        GREATEST(
          (sumsq_total / NULLIF(n_total, 0))
            - (sum_total / NULLIF(n_total, 0)) * (sum_total / NULLIF(n_total, 0)),
          1e-9
        ) AS var_single
      FROM cumulated
    ),
    llr AS (
      SELECT *,
        CASE
          WHEN n_left >= ${Number(minSide)} AND (n_total - n_left) >= ${Number(minSide)}
          THEN n_total * LN(var_single)
            - n_left * LN(var_left)
            - (n_total - n_left) * LN(var_right)
          ELSE NULL
        END AS llr
      FROM llr_scored
    ),
    best AS (
      SELECT query, page, n_total, total_impressions,
        arg_max(date, llr) AS change_date,
        MAX(llr) AS best_llr,
        arg_max(sum_left / NULLIF(n_left, 0), llr) AS left_mean,
        arg_max((sum_total - sum_left) / NULLIF(n_total - n_left, 0), llr) AS right_mean,
        arg_max(sqrt(var_left), llr) AS left_std,
        arg_max(sqrt(var_right), llr) AS right_std
      FROM llr
      WHERE llr IS NOT NULL
      GROUP BY query, page, n_total, total_impressions
      HAVING MAX(llr) > ${Number(threshold)}
    ),
    series AS (
      SELECT query, page,
        to_json(list({
          'date': strftime(date, '%Y-%m-%d'),
          'value': value
        } ORDER BY date)) AS seriesJson
      FROM daily
      GROUP BY query, page
    )
    SELECT
      b.query AS keyword,
      b.page,
      CAST(b.n_total AS DOUBLE) AS totalDays,
      CAST(b.total_impressions AS DOUBLE) AS totalImpressions,
      strftime(b.change_date, '%Y-%m-%d') AS changeDate,
      b.best_llr AS llr,
      b.left_mean AS leftMean,
      b.right_mean AS rightMean,
      (b.right_mean - b.left_mean) AS delta,
      b.left_std AS leftStddev,
      b.right_std AS rightStddev,
      s.seriesJson
    FROM best b
    LEFT JOIN series s USING (query, page)
    ORDER BY b.best_llr DESC
    LIMIT ${Number(limit)}
  `

    return {
      sql,
      params: [startDate, endDate, minImpressions],
      current: { table: 'page_queries', partitions: enumeratePartitions(startDate, endDate) },
    }
  },

  reduceSql(rows, params) {
    const arr = Array.isArray(rows) ? rows : []
    const threshold = params.threshold ?? 10
    const metric = params.metric === 'clicks' || params.metric === 'impressions' ? params.metric : 'position'
    const lowerIsBetter = metric === 'position'
    const results: ChangePointResult[] = arr.map((r) => {
      const delta = num(r.delta)
      const improved = lowerIsBetter ? delta < 0 : delta > 0
      return {
        keyword: str(r.keyword),
        page: str(r.page),
        totalDays: num(r.totalDays),
        totalImpressions: num(r.totalImpressions),
        changeDate: str(r.changeDate),
        llr: num(r.llr),
        leftMean: num(r.leftMean),
        rightMean: num(r.rightMean),
        delta,
        leftStddev: num(r.leftStddev),
        rightStddev: num(r.rightStddev),
        direction: (improved ? 'improved' : 'worsened') as 'improved' | 'worsened',
        series: parseJsonList(r.seriesJson).map(s => ({
          date: str(s.date),
          value: num(s.value),
        })),
      }
    })
    return {
      results,
      meta: {
        total: results.length,
        metric,
        threshold,
        improved: results.filter(r => r.direction === 'improved').length,
        worsened: results.filter(r => r.direction === 'worsened').length,
      },
    }
  },
})

/**
 * stl-decompose
 *
 * Classical additive decomposition: observed = trend + seasonal + residual.
 * Trend is a centered 7-day moving average; seasonal is the mean of detrended
 * residuals per-dayofweek per-entity; residual is the leftover. Entities with
 * a large |residual| relative to STDDEV_POP(residual) are flagged anomalous.
 * Not true STL (no iterative LOESS), but faithful where it matters and
 * expressible in pure DuckDB window functions.
 */

import type { AnalysisParams } from '@gscdump/engine/analysis-types'
import type { Row } from '@gscdump/engine/contracts'
import { num } from '@gscdump/engine/analysis-types'
import { defineAnalyzer } from '@gscdump/engine/analyzer'
import { defaultEndDate } from '@gscdump/engine/period'
import { enumeratePartitions } from '@gscdump/engine/planner'
import { METRIC_EXPR } from '@gscdump/engine/sql-fragments'
import { daysAgo } from 'gscdump'

export interface StlDecomposeSeriesPoint {
  date: string
  observed: number
  trend: number | null
  seasonal: number | null
  residual: number | null
  anomaly: boolean
}

export interface StlDecomposeResult {
  keyword: string
  page: string
  totalImpressions: number
  days: number
  seasonalStrength: number
  trendStrength: number
  residualAnomalies: number
  trendSlope: number
  series: StlDecomposeSeriesPoint[]
}

function str(v: unknown): string {
  return v == null ? '' : String(v)
}

function bool(v: unknown): boolean {
  return v === true || v === 1 || v === 'true'
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

export const stlDecomposeAnalyzer = defineAnalyzer<AnalysisParams, Row, StlDecomposeResult[]>({
  id: 'stl-decompose',

  buildSql(params) {
    const endDate = params.endDate ?? defaultEndDate()
    const startDate = params.startDate ?? daysAgo(93)
    const minImpressions = params.minImpressions ?? 100
    const minDays = 21
    const metric = params.metric === 'clicks' ? 'clicks' : 'impressions'
    const limit = params.limit ?? 100

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
        CAST(SUM(${metric}) AS DOUBLE) AS observed
      FROM read_parquet({{FILES}}, union_by_name = true)
      WHERE date >= ? AND date <= ?
        AND query IS NOT NULL AND query <> ''
        AND url IS NOT NULL AND url <> ''
      GROUP BY query, url, date
    ),
    entity_stats AS (
      SELECT query, page,
        COUNT(*) AS days,
        SUM(impressions) AS total_impressions
      FROM daily
      GROUP BY query, page
      HAVING COUNT(*) >= ${Number(minDays)}
        AND SUM(impressions) >= ?
    ),
    filtered AS (
      SELECT d.*
      FROM daily d
      JOIN entity_stats e USING (query, page)
    ),
    trended AS (
      SELECT *,
        CASE
          WHEN COUNT(*) OVER w = 7
            THEN AVG(observed) OVER w
          ELSE NULL
        END AS trend
      FROM filtered
      WINDOW w AS (
        PARTITION BY query, page
        ORDER BY date
        ROWS BETWEEN 3 PRECEDING AND 3 FOLLOWING
      )
    ),
    detrended AS (
      SELECT *,
        observed - trend AS detrended,
        dayofweek(date) AS dow
      FROM trended
    ),
    seasonal_raw AS (
      SELECT *,
        AVG(detrended) OVER (PARTITION BY query, page, dow) AS seasonal_dow
      FROM detrended
    ),
    seasonal_centered AS (
      SELECT *,
        seasonal_dow - AVG(seasonal_dow) OVER (PARTITION BY query, page) AS seasonal
      FROM seasonal_raw
    ),
    residualed AS (
      SELECT *,
        CASE
          WHEN trend IS NULL OR seasonal IS NULL THEN NULL
          ELSE observed - trend - seasonal
        END AS residual
      FROM seasonal_centered
    ),
    scored AS (
      SELECT *,
        STDDEV_POP(residual) OVER (PARTITION BY query, page) AS resid_std,
        CASE
          WHEN residual IS NOT NULL
            AND STDDEV_POP(residual) OVER (PARTITION BY query, page) > 0
            AND ABS(residual) > 2.0 * STDDEV_POP(residual) OVER (PARTITION BY query, page)
          THEN true ELSE false
        END AS anomaly
      FROM residualed
    ),
    per_entity AS (
      SELECT query, page,
        COUNT(*) AS days,
        SUM(impressions) AS total_impressions,
        VAR_POP(detrended) AS var_detrended,
        VAR_POP(seasonal) AS var_seasonal,
        VAR_POP(residual) AS var_residual,
        COUNT(*) FILTER (WHERE anomaly) AS residual_anomalies,
        REGR_SLOPE(observed, epoch(date) / 86400.0) AS trend_slope
      FROM scored
      GROUP BY query, page
    ),
    series AS (
      SELECT query, page,
        to_json(list({
          'date': strftime(date, '%Y-%m-%d'),
          'observed': observed,
          'trend': trend,
          'seasonal': seasonal,
          'residual': residual,
          'anomaly': anomaly
        } ORDER BY date)) AS seriesJson
      FROM scored
      GROUP BY query, page
    )
    SELECT
      e.query AS keyword,
      e.page,
      CAST(e.total_impressions AS DOUBLE) AS totalImpressions,
      CAST(e.days AS DOUBLE) AS days,
      CASE
        WHEN e.var_detrended IS NULL OR e.var_detrended = 0 THEN 0.0
        ELSE LEAST(e.var_seasonal / NULLIF(e.var_detrended, 0), 1.0)
      END AS seasonalStrength,
      CASE
        WHEN e.var_detrended IS NULL OR e.var_detrended = 0 THEN 0.0
        ELSE GREATEST(0.0, 1.0 - e.var_residual / NULLIF(e.var_detrended, 0))
      END AS trendStrength,
      CAST(e.residual_anomalies AS DOUBLE) AS residualAnomalies,
      COALESCE(e.trend_slope, 0.0) AS trendSlope,
      s.seriesJson
    FROM per_entity e
    LEFT JOIN series s USING (query, page)
    ORDER BY seasonalStrength DESC, ABS(COALESCE(e.trend_slope, 0.0)) DESC
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
    const metric = params.metric === 'clicks' ? 'clicks' : 'impressions'
    const results: StlDecomposeResult[] = arr.map(r => ({
      keyword: str(r.keyword),
      page: str(r.page),
      totalImpressions: num(r.totalImpressions),
      days: num(r.days),
      seasonalStrength: num(r.seasonalStrength),
      trendStrength: num(r.trendStrength),
      residualAnomalies: num(r.residualAnomalies),
      trendSlope: num(r.trendSlope),
      series: parseJsonList(r.seriesJson).map(s => ({
        date: str(s.date),
        observed: num(s.observed),
        trend: s.trend == null ? null : num(s.trend),
        seasonal: s.seasonal == null ? null : num(s.seasonal),
        residual: s.residual == null ? null : num(s.residual),
        anomaly: bool(s.anomaly),
      })),
    }))
    return {
      results,
      meta: {
        total: results.length,
        metric,
        avgSeasonalStrength: results.length > 0
          ? results.reduce((a, r) => a + r.seasonalStrength, 0) / results.length
          : 0,
      },
    }
  },
})

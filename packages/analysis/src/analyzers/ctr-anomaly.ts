/**
 * `ctr-anomaly` — rolling CTR envelope per (query, page). SQL-only colocation.
 *
 * Migrated from `engine-duckdb-node/src/analyzers/ctr-anomaly.ts`.
 */

import type { Row } from '@gscdump/engine/contracts'
import type { AnalysisParams } from '@gscdump/engine/analysis-types'
import { enumeratePartitions } from '@gscdump/engine/planner'
import { METRIC_EXPR } from '@gscdump/engine/sql-fragments'
import { daysAgo } from 'gscdump'
import { defineAnalyzer } from '@gscdump/engine/analyzer'
import { defaultEndDate } from '@gscdump/engine/period'

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

export interface CtrAnomalySeriesPoint {
  date: string
  ctr: number
  position: number
  impressions: number
  rollingCtr: number | null
  rollingStddev: number | null
  z: number
  breach: boolean
}

export interface CtrAnomalyResult {
  keyword: string
  page: string
  breachDaysDown: number
  breachDaysUp: number
  clicksLost: number
  severity: number
  maxZ: number
  baselineCtr: number
  baselinePosition: number
  totalImpressions: number
  totalClicks: number
  series: CtrAnomalySeriesPoint[]
}

export const ctrAnomalyAnalyzer = defineAnalyzer<AnalysisParams, Row, CtrAnomalyResult[]>({
  id: 'ctr-anomaly',

  buildSql(params) {
    // Default to 90 days so the rolling window has ≥14 warm-up days and still
    // leaves ~60 days for breach detection. The shared 28-day default is too
    // tight for a rolling-STDDEV analyzer.
    const endDate = params.endDate ?? defaultEndDate()
    const startDate = params.startDate ?? daysAgo(93)
    const minDailyImpressions = params.minImpressions ?? 5
    const minRollingN = 14
    const zThreshold = params.threshold ?? 2.0
    const maxPositionDelta = 1.5
    const minBreachDays = 2
    const limit = params.limit ?? 200

    const sql = `
    WITH daily AS (
      SELECT
        query,
        url AS page,
        date,
        ${METRIC_EXPR.clicks} AS day_clicks,
        ${METRIC_EXPR.impressions} AS day_impressions,
        ${METRIC_EXPR.ctr} AS day_ctr,
        ${METRIC_EXPR.position} AS day_position
      FROM read_parquet({{FILES}}, union_by_name = true)
      WHERE date >= ? AND date <= ?
        AND query IS NOT NULL AND query <> ''
        AND url IS NOT NULL AND url <> ''
      GROUP BY query, url, date
      HAVING SUM(impressions) >= ?
    ),
    rolled AS (
      SELECT *,
        AVG(day_ctr)           OVER w AS rolling_ctr,
        STDDEV_POP(day_ctr)    OVER w AS rolling_stddev,
        AVG(day_position)      OVER w AS rolling_position,
        COUNT(*)               OVER w AS rolling_n
      FROM daily
      WINDOW w AS (
        PARTITION BY query, page
        ORDER BY date
        ROWS BETWEEN 28 PRECEDING AND 1 PRECEDING
      )
    ),
    flagged AS (
      SELECT *,
        CASE
          WHEN rolling_n >= ${Number(minRollingN)} AND rolling_stddev > 0
            THEN (day_ctr - rolling_ctr) / rolling_stddev
          ELSE 0.0
        END AS z_score,
        CASE
          WHEN rolling_position IS NULL THEN 0.0
          ELSE ABS(day_position - rolling_position)
        END AS position_delta
      FROM rolled
    ),
    breaches AS (
      SELECT *,
        CASE
          WHEN ABS(z_score) >= ${zThreshold}
            AND position_delta <= ${maxPositionDelta}
            AND rolling_n >= ${Number(minRollingN)}
          THEN true ELSE false
        END AS is_breach
      FROM flagged
    ),
    per_entity AS (
      SELECT
        query, page,
        COUNT(*) FILTER (WHERE is_breach AND z_score < 0) AS breach_days_down,
        COUNT(*) FILTER (WHERE is_breach AND z_score > 0) AS breach_days_up,
        SUM(CASE
          WHEN is_breach AND z_score < 0
            THEN (rolling_ctr - day_ctr) * day_impressions
          ELSE 0.0
        END) AS clicks_lost,
        SUM(CASE
          WHEN is_breach AND z_score < 0
            THEN ABS(z_score) * day_impressions
          ELSE 0.0
        END) AS severity_raw,
        MAX(CASE WHEN is_breach THEN ABS(z_score) ELSE 0.0 END) AS max_z,
        AVG(rolling_ctr) FILTER (WHERE rolling_n >= ${Number(minRollingN)}) AS baseline_ctr,
        AVG(rolling_position) FILTER (WHERE rolling_n >= ${Number(minRollingN)}) AS baseline_position,
        SUM(day_impressions) AS total_impressions,
        SUM(day_clicks) AS total_clicks
      FROM breaches
      GROUP BY query, page
      HAVING COUNT(*) FILTER (WHERE is_breach AND z_score < 0) >= ${Number(minBreachDays)}
    ),
    series AS (
      SELECT query, page,
        to_json(list({
          'date': strftime(date, '%Y-%m-%d'),
          'ctr': day_ctr,
          'position': day_position,
          'impressions': day_impressions,
          'rollingCtr': rolling_ctr,
          'rollingStddev': rolling_stddev,
          'z': z_score,
          'breach': is_breach AND z_score < 0
        } ORDER BY date)) AS seriesJson
      FROM breaches
      GROUP BY query, page
    )
    SELECT
      e.query AS keyword,
      e.page,
      CAST(e.breach_days_down AS DOUBLE) AS breachDaysDown,
      CAST(e.breach_days_up AS DOUBLE) AS breachDaysUp,
      CAST(ROUND(e.clicks_lost) AS DOUBLE) AS clicksLost,
      e.severity_raw AS severityRaw,
      e.max_z AS maxZ,
      e.baseline_ctr AS baselineCtr,
      e.baseline_position AS baselinePosition,
      e.total_impressions AS totalImpressions,
      e.total_clicks AS totalClicks,
      s.seriesJson
    FROM per_entity e
    LEFT JOIN series s USING (query, page)
    ORDER BY clicksLost DESC
    LIMIT ${Number(limit)}
  `

    return {
      sql,
      params: [startDate, endDate, minDailyImpressions],
      current: { table: 'page_keywords', partitions: enumeratePartitions(startDate, endDate) },
    }
  },

  reduceSql(rows, params) {
    const arr = Array.isArray(rows) ? rows : []
    const minRollingN = 14
    const zThreshold = params.threshold ?? 2.0
    const anomalies: CtrAnomalyResult[] = arr.map(r => ({
      keyword: str(r.keyword),
      page: str(r.page),
      breachDaysDown: num(r.breachDaysDown),
      breachDaysUp: num(r.breachDaysUp),
      clicksLost: num(r.clicksLost),
      severity: num(r.severityRaw),
      maxZ: num(r.maxZ),
      baselineCtr: num(r.baselineCtr),
      baselinePosition: num(r.baselinePosition),
      totalImpressions: num(r.totalImpressions),
      totalClicks: num(r.totalClicks),
      series: parseJsonList(r.seriesJson).map(s => ({
        date: str(s.date),
        ctr: num(s.ctr),
        position: num(s.position),
        impressions: num(s.impressions),
        rollingCtr: s.rollingCtr == null ? null : num(s.rollingCtr),
        rollingStddev: s.rollingStddev == null ? null : num(s.rollingStddev),
        z: num(s.z),
        breach: bool(s.breach),
      })),
    }))
    const totalClicksLost = anomalies.reduce((s, a) => s + a.clicksLost, 0)
    const totalBreachDays = anomalies.reduce((s, a) => s + a.breachDaysDown, 0)
    return {
      results: anomalies,
      meta: {
        total: anomalies.length,
        totalClicksLost,
        totalBreachDays,
        zThreshold,
        minRollingN,
      },
    }
  },
})

/**
 * ctr-anomaly
 *
 * Rolling CTR envelope per (query, page): 28-day preceding AVG + STDDEV_POP
 * via window functions. A "breach" is a day where the observed CTR falls
 * outside ±z·σ while position stays flat — i.e. the page didn't drop, but
 * clicks did. That's the signature of SERP feature theft (AI Overview,
 * People-Also-Ask, featured-snippet reclaim), detected without ever calling
 * a SERP-rendering API.
 *
 * clicksLost = Σ (rollingCtr − dayCtr) · impressions for downward breaches.
 * Entities are ranked by clicksLost DESC; the daily series is returned as
 * JSON so the frontend can draw a sparkline with breach markers.
 */

import type { AnalysisParams, AnalyzerSpec } from '../shared'

import { enumeratePartitions } from '@gscdump/engine/planner'
import { bool, DEFAULT_END, num, parseJsonList, str } from '../shared'

export function buildCtrAnomaly(params: AnalysisParams): AnalyzerSpec {
  // Default to 90 days so the rolling window has ≥14 warm-up days and still
  // leaves ~60 days for breach detection. The shared 28-day default is too
  // tight for a rolling-STDDEV analyzer.
  const endDate = params.endDate ?? DEFAULT_END()
  const startDate = params.startDate ?? new Date(Date.now() - 93 * 86400000).toISOString().split('T')[0]!
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
        CAST(SUM(clicks) AS DOUBLE) AS day_clicks,
        CAST(SUM(impressions) AS DOUBLE) AS day_impressions,
        CAST(SUM(clicks) AS DOUBLE) / NULLIF(SUM(impressions), 0) AS day_ctr,
        SUM(sum_position) / NULLIF(SUM(impressions), 0) + 1 AS day_position
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
    shape: (rows) => {
      const anomalies = rows.map(r => ({
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
  }
}

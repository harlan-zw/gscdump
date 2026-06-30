/**
 * survival (Kaplan-Meier)
 *
 * Models "keyword survival in top-10". An episode starts the first day a
 * (query, url) daily avg position drops to ≤10; it ends the first day
 * position rises above 10 (simpler than the 3-day grace rule — a single bad
 * day is rare enough at the daily-aggregate level to still give a clean
 * tenure signal, and it avoids a windowed state machine in SQL). If the run
 * reaches window_end - 2, the episode is censored (still alive).
 *
 * KM cumulative product is computed via EXP(SUM(LN(...)) OVER ...) — DuckDB
 * has no CUMPROD, but running sums of logs with GREATEST(.., 1e-9) give the
 * same result without any host-side math.
 */

import type { AnalysisParams } from '@gscdump/engine/analysis-types'
import type { Row } from '@gscdump/engine/contracts'
import { num } from '@gscdump/engine/analysis-types'
import { defineAnalyzer } from '@gscdump/engine/analyzer'
import { defaultEndDate } from '@gscdump/engine/period'
import { enumeratePartitions } from '@gscdump/engine/planner'
import { METRIC_EXPR } from '@gscdump/engine/sql-fragments'
import { daysAgo, MS_PER_DAY } from 'gscdump'
import { parseJsonRows as parseJsonList, rowString as str } from '../analyzer/row-values'

export interface SurvivalCurvePoint {
  tenure: number
  survival: number
  atRisk: number
  events: number
}

export interface SurvivalResult {
  cohort: string
  episodeCount: number
  censoringRate: number
  medianTenure: number
  curve: SurvivalCurvePoint[]
}

export const survivalAnalyzer = defineAnalyzer<AnalysisParams, Row, SurvivalResult[]>({
  id: 'survival',

  buildSql(params) {
    const endDate = params.endDate ?? defaultEndDate()
    const startDate = params.startDate ?? daysAgo(183)
    const minImpressions = params.minImpressions ?? 5
    const positionThreshold = 10

    const sql = `
    WITH daily AS (
      SELECT
        query,
        url,
        date,
        ${METRIC_EXPR.clicks} AS day_clicks,
        ${METRIC_EXPR.impressions} AS day_impressions,
        ${METRIC_EXPR.position} AS day_position
      FROM read_parquet({{FILES}}, union_by_name = true)
      WHERE date >= ? AND date <= ?
        AND query IS NOT NULL AND query <> ''
        AND url IS NOT NULL AND url <> ''
      GROUP BY query, url, date
      HAVING SUM(impressions) >= ?
    ),
    classified AS (
      SELECT *,
        (day_position <= ${positionThreshold}) AS in_top10
      FROM daily
    ),
    transitions AS (
      SELECT *,
        CASE
          WHEN in_top10 AND (LAG(in_top10) OVER w IS NULL OR NOT LAG(in_top10) OVER w)
            THEN 1 ELSE 0
        END AS is_entry
      FROM classified
      WINDOW w AS (PARTITION BY query, url ORDER BY date)
    ),
    run_ids AS (
      SELECT *,
        SUM(is_entry) OVER (PARTITION BY query, url ORDER BY date) AS run_id
      FROM transitions
      WHERE in_top10
    ),
    window_bounds AS (
      SELECT MIN(date) AS window_start, MAX(date) AS window_end FROM daily
    ),
    episodes_raw AS (
      SELECT
        query, url, run_id,
        MIN(date) AS entry_date,
        MAX(date) AS exit_date,
        DATEDIFF('day', MIN(date), MAX(date)) + 1 AS tenure
      FROM run_ids
      GROUP BY query, url, run_id
    ),
    episodes AS (
      SELECT
        e.query, e.url, e.run_id, e.entry_date, e.exit_date, e.tenure,
        (e.exit_date >= wb.window_end - INTERVAL 2 DAY) AS censored,
        CASE
          WHEN regexp_extract(e.url, '^(?:https?://[^/]+)?(/[^/?#]*)', 1) = '/' OR e.url = '/'
            THEN 'home'
          WHEN regexp_extract(e.url, '^(?:https?://[^/]+)?/([^/?#]+)', 1) = ''
            THEN 'home'
          ELSE regexp_extract(e.url, '^(?:https?://[^/]+)?/([^/?#]+)', 1)
        END AS cohort
      FROM episodes_raw e
      CROSS JOIN window_bounds wb
    ),
    episodes_all AS (
      SELECT query, url, tenure, censored, cohort FROM episodes
      UNION ALL
      SELECT query, url, tenure, censored, '__all__' AS cohort FROM episodes
    ),
    cohort_totals AS (
      SELECT cohort, COUNT(*) AS n_total
      FROM episodes_all
      GROUP BY cohort
    ),
    events AS (
      SELECT
        cohort,
        tenure,
        COUNT(*) FILTER (WHERE NOT censored) AS d_t,
        COUNT(*) AS n_ending_at_t
      FROM episodes_all
      GROUP BY cohort, tenure
    ),
    km AS (
      SELECT
        e.cohort,
        e.tenure,
        e.d_t,
        e.n_ending_at_t,
        SUM(e.n_ending_at_t) OVER (PARTITION BY e.cohort ORDER BY e.tenure DESC
          ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS at_risk
      FROM events e
    ),
    km_surv AS (
      SELECT
        cohort, tenure, d_t, at_risk,
        EXP(SUM(LN(GREATEST(1.0 - CAST(d_t AS DOUBLE) / NULLIF(at_risk, 0), 1e-9)))
          OVER (PARTITION BY cohort ORDER BY tenure
            ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW)) AS survival
      FROM km
    ),
    curve_agg AS (
      SELECT
        cohort,
        to_json(list({
          'tenure': tenure,
          'survival': survival,
          'atRisk': at_risk,
          'events': d_t
        } ORDER BY tenure)) AS curveJson
      FROM km_surv
      GROUP BY cohort
    ),
    cohort_stats AS (
      SELECT
        ea.cohort,
        COUNT(*) AS episode_count,
        AVG(CASE WHEN ea.censored THEN 1.0 ELSE 0.0 END) AS censoring_rate
      FROM episodes_all ea
      GROUP BY ea.cohort
    )
    SELECT
      cs.cohort,
      cs.episode_count AS episodeCount,
      cs.censoring_rate AS censoringRate,
      ca.curveJson
    FROM cohort_stats cs
    LEFT JOIN curve_agg ca USING (cohort)
    ORDER BY cs.cohort
  `

    return {
      sql,
      params: [startDate, endDate, minImpressions],
      current: { table: 'page_queries', partitions: enumeratePartitions(startDate, endDate) },
    }
  },

  reduceSql(rows, params) {
    const arr = Array.isArray(rows) ? rows : []
    const endDate = params.endDate ?? defaultEndDate()
    const startDate = params.startDate ?? daysAgo(183)
    const windowDays
      = Math.round((new Date(endDate).getTime() - new Date(startDate).getTime()) / MS_PER_DAY) + 1

    const results: SurvivalResult[] = arr.map((r) => {
      const curve = parseJsonList(r.curveJson).map(p => ({
        tenure: num(p.tenure),
        survival: num(p.survival),
        atRisk: num(p.atRisk),
        events: num(p.events),
      }))

      // Median tenure via linear interpolation at S = 0.5.
      let medianTenure = 0
      for (let i = 0; i < curve.length; i++) {
        const cur = curve[i]!
        if (cur.survival <= 0.5) {
          if (i === 0) {
            medianTenure = cur.tenure
          }
          else {
            const prev = curve[i - 1]!
            const span = prev.survival - cur.survival
            const frac = span > 0 ? (prev.survival - 0.5) / span : 0
            medianTenure = prev.tenure + frac * (cur.tenure - prev.tenure)
          }
          break
        }
      }
      // If survival never dips to 0.5, report the max observed tenure as a
      // lower bound (episode population is too censored to resolve median).
      const last = curve[curve.length - 1]
      if (medianTenure === 0 && last && last.survival > 0.5)
        medianTenure = last.tenure

      return {
        cohort: str(r.cohort),
        episodeCount: num(r.episodeCount),
        censoringRate: num(r.censoringRate),
        medianTenure,
        curve,
      }
    })

    const ungrouped = results.find(r => r.cohort === '__all__')
    const totalEpisodes = ungrouped?.episodeCount ?? 0

    return {
      results,
      meta: {
        totalEpisodes,
        cohortCount: results.filter(r => r.cohort !== '__all__').length,
        windowDays,
      },
    }
  },
})

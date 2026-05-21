/**
 * position-volatility
 *
 * Per (page, day) compute query-level position STDDEV_POP plus day-over-day
 * shift in weighted avg position via LAG. The resulting "volatility score"
 * (σ + |Δpos|) surfaces pages whose SERP positioning is genuinely noisy,
 * not just pages that rank well. Output is a pages × dates matrix for a
 * calendar-style heatmap.
 */

import type { AnalysisParams } from '@gscdump/engine/analysis-types'
import type { Row } from '@gscdump/engine/contracts'
import { num } from '@gscdump/engine/analysis-types'
import { defineAnalyzer } from '@gscdump/engine/analyzer'
import { periodOf } from '@gscdump/engine/period'
import { enumeratePartitions } from '@gscdump/engine/planner'
import { METRIC_EXPR } from '@gscdump/engine/sql-fragments'

export interface PositionVolatilityDay {
  date: string
  queryCount: number
  dayImpressions: number
  avgPosition: number
  posStddev: number
  bestPosition: number
  worstPosition: number
  dodShift: number
  volatility: number
}

export interface PositionVolatilityResult {
  page: string
  avgVolatility: number
  peakVolatility: number
  totalImpressions: number
  days: PositionVolatilityDay[]
}

function str(v: unknown): string {
  return v == null ? '' : String(v)
}

export const positionVolatilityAnalyzer = defineAnalyzer<AnalysisParams, Row, PositionVolatilityResult[]>({
  id: 'position-volatility',

  buildSql(params) {
    const { startDate, endDate } = periodOf(params)
    const topN = params.topN ?? 30
    const minDayImpressions = params.minImpressions ?? 10
    const minDays = params.minWeeksWithData ?? 7

    const sql = `
    WITH query_day AS (
      SELECT
        url AS page,
        query,
        -- Normalize at the source CTE: union_by_name=true can coerce date to
        -- VARCHAR across parquets with mixed schemas, which makes downstream
        -- strftime(date, ...) binder-error.
        CAST(date AS DATE) AS date,
        ${METRIC_EXPR.impressions} AS q_impressions,
        ${METRIC_EXPR.position} AS q_position
      FROM read_parquet({{FILES}}, union_by_name = true)
      WHERE date >= ? AND date <= ?
        AND query IS NOT NULL AND query <> ''
        AND url IS NOT NULL AND url <> ''
      GROUP BY url, query, date
      HAVING SUM(impressions) >= 1
    ),
    daily AS (
      SELECT
        page, date,
        COUNT(*) AS query_count,
        SUM(q_impressions) AS day_impressions,
        SUM(q_position * q_impressions) / NULLIF(SUM(q_impressions), 0) AS avg_position,
        COALESCE(STDDEV_POP(q_position), 0.0) AS pos_stddev,
        MIN(q_position) AS best_position,
        MAX(q_position) AS worst_position
      FROM query_day
      GROUP BY page, date
      HAVING SUM(q_impressions) >= ?
    ),
    with_shift AS (
      SELECT *,
        LAG(avg_position) OVER (PARTITION BY page ORDER BY date) AS prev_position,
        COALESCE(
          ABS(avg_position - LAG(avg_position) OVER (PARTITION BY page ORDER BY date)),
          0.0
        ) AS dod_shift
      FROM daily
    ),
    scored AS (
      SELECT *,
        pos_stddev + dod_shift AS volatility
      FROM with_shift
    ),
    top_pages AS (
      SELECT page,
        SUM(day_impressions) AS total_impressions,
        AVG(volatility) AS avg_volatility,
        MAX(volatility) AS peak_volatility,
        COUNT(*) AS days_with_data
      FROM scored
      GROUP BY page
      HAVING COUNT(*) >= ?
      ORDER BY avg_volatility DESC
      LIMIT ${Number(topN)}
    )
    SELECT
      s.page,
      strftime(s.date, '%Y-%m-%d') AS date,
      s.query_count AS queryCount,
      s.day_impressions AS dayImpressions,
      s.avg_position AS avgPosition,
      s.pos_stddev AS posStddev,
      s.best_position AS bestPosition,
      s.worst_position AS worstPosition,
      s.dod_shift AS dodShift,
      s.volatility AS volatility,
      t.avg_volatility AS pageAvgVolatility,
      t.peak_volatility AS pagePeakVolatility,
      t.total_impressions AS pageTotalImpressions
    FROM scored s
    JOIN top_pages t USING (page)
    ORDER BY t.avg_volatility DESC, s.date ASC
  `

    return {
      sql,
      params: [startDate, endDate, minDayImpressions, minDays],
      current: { table: 'page_queries', partitions: enumeratePartitions(startDate, endDate) },
    }
  },

  reduceSql(rows) {
    const arr = Array.isArray(rows) ? rows : []
    const byPage = new Map<string, PositionVolatilityResult>()

    const allDates = new Set<string>()
    for (const r of arr) {
      const page = str(r.page)
      const date = str(r.date)
      allDates.add(date)
      const entry = byPage.get(page) ?? {
        page,
        avgVolatility: num(r.pageAvgVolatility),
        peakVolatility: num(r.pagePeakVolatility),
        totalImpressions: num(r.pageTotalImpressions),
        days: [],
      }
      entry.days.push({
        date,
        queryCount: num(r.queryCount),
        dayImpressions: num(r.dayImpressions),
        avgPosition: num(r.avgPosition),
        posStddev: num(r.posStddev),
        bestPosition: num(r.bestPosition),
        worstPosition: num(r.worstPosition),
        dodShift: num(r.dodShift),
        volatility: num(r.volatility),
      })
      byPage.set(page, entry)
    }

    const pages = [...byPage.values()].sort((a, b) => b.avgVolatility - a.avgVolatility)
    const dates = [...allDates].sort()
    const maxVolatility = pages.reduce((m, p) => Math.max(m, p.peakVolatility), 0)

    return {
      results: pages,
      meta: {
        total: pages.length,
        dates,
        maxVolatility,
      },
    }
  },
})

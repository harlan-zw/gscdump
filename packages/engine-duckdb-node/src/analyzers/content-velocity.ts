/**
 * content-velocity — weekly new-keyword cadence.
 * Matches `/api/sites/[siteId]/content-velocity.get.ts`.
 *
 * Server uses SQLite's `strftime('%Y-W%W', ...)`; we use DuckDB's
 * `strftime(date, '%G-W%V')` which produces ISO-week keys. Both are
 * lexicographically sortable. Day-of-week edge cases differ by at most a
 * week at year boundaries; acceptable for a trend card.
 */

import type { AnalysisParams, AnalyzerSpec } from '../shared'

import { enumeratePartitions } from '@gscdump/engine/planner'
import { num, period, str } from '../shared'

export function buildContentVelocity(params: AnalysisParams): AnalyzerSpec {
  const days = Math.min(Math.max(Number(params.days ?? 90), 7), 365)
  const { endDate } = period(params)
  const start = new Date(endDate)
  start.setUTCDate(start.getUTCDate() - days)
  const startDate = start.toISOString().split('T')[0]!

  const sql = `
    WITH src AS (
      SELECT query, date
      FROM read_parquet({{FILES}}, union_by_name = true)
      WHERE date >= ? AND date <= ? AND impressions > 0
    ),
    first_seen AS (
      SELECT query, MIN(date) AS first_date FROM src GROUP BY query
    ),
    per_week AS (
      SELECT
        strftime(date, '%G-W%V') AS week,
        MIN(date) AS week_start,
        CAST(COUNT(DISTINCT query) AS DOUBLE) AS totalKeywords
      FROM src
      GROUP BY week
    ),
    new_per_week AS (
      SELECT
        strftime(first_date, '%G-W%V') AS week,
        CAST(COUNT(*) AS DOUBLE) AS newKeywords
      FROM first_seen
      GROUP BY week
    )
    SELECT
      pw.week AS week,
      COALESCE(npw.newKeywords, 0) AS newKeywords,
      pw.totalKeywords AS totalKeywords
    FROM per_week pw
    LEFT JOIN new_per_week npw ON pw.week = npw.week
    ORDER BY pw.week ASC
  `
  return {
    sql,
    params: [startDate, endDate],
    current: { table: 'keywords', partitions: enumeratePartitions(startDate, endDate) },
    shape: (rows) => {
      const weekly = rows.map(r => ({
        week: str(r.week),
        newKeywords: num(r.newKeywords),
        totalKeywords: num(r.totalKeywords),
      }))
      const total = weekly.reduce((s, w) => s + w.newKeywords, 0)
      const avg = weekly.length > 0 ? total / weekly.length : 0
      // First-half vs second-half average → trend (matches server logic).
      const mid = Math.floor(weekly.length / 2)
      const firstAvg = mid > 0
        ? weekly.slice(0, mid).reduce((s, w) => s + w.newKeywords, 0) / mid
        : 0
      const secondAvg = weekly.length - mid > 0
        ? weekly.slice(mid).reduce((s, w) => s + w.newKeywords, 0) / (weekly.length - mid)
        : 0
      const diff = secondAvg - firstAvg
      const threshold = Math.max(1, avg * 0.15)
      const trend: 'stable' | 'accelerating' | 'decelerating'
        = diff > threshold ? 'accelerating' : diff < -threshold ? 'decelerating' : 'stable'
      return {
        results: weekly,
        meta: {
          summary: {
            totalNewKeywords: total,
            avgPerWeek: avg,
            trend,
          },
          days,
          startDate,
          endDate,
        },
      }
    },
  }
}

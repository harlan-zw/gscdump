/**
 * `content-velocity` — weekly new-keyword cadence. SQL-only colocation.
 *
 * Migrated from `engine-duckdb-node/src/analyzers/content-velocity.ts`.
 */

import type { AnalysisParams } from '@gscdump/engine/analysis-types'
import type { Row } from '@gscdump/engine/contracts'
import { defineAnalyzer } from '@gscdump/engine/analyzer'
import { periodOf } from '@gscdump/engine/period'
import { enumeratePartitions } from '@gscdump/engine/planner'
import { toIsoDate } from 'gscdump'
import { rowNumber as num, rowString as str } from '../analyzer/row-values'

export interface ContentVelocityWeek {
  week: string
  newKeywords: number
  totalKeywords: number
}

export const contentVelocityAnalyzer = defineAnalyzer<AnalysisParams, Row, ContentVelocityWeek[]>({
  id: 'content-velocity',

  buildSql(params) {
    const days = Math.min(Math.max(Number(params.days ?? 90), 7), 365)
    const { endDate } = periodOf(params)
    const start = new Date(endDate)
    start.setUTCDate(start.getUTCDate() - days)
    const startDate = toIsoDate(start)

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
        strftime(CAST(date AS DATE), '%G-W%V') AS week,
        MIN(date) AS week_start,
        CAST(COUNT(DISTINCT query) AS DOUBLE) AS totalKeywords
      FROM src
      GROUP BY week
    ),
    new_per_week AS (
      SELECT
        strftime(CAST(first_date AS DATE), '%G-W%V') AS week,
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
      current: { table: 'queries', partitions: enumeratePartitions(startDate, endDate) },
    }
  },

  reduceSql(rows, params) {
    const arr = Array.isArray(rows) ? rows : []
    const days = Math.min(Math.max(Number(params.days ?? 90), 7), 365)
    const { endDate } = periodOf(params)
    const startDateD = new Date(endDate)
    startDateD.setUTCDate(startDateD.getUTCDate() - days)
    const startDate = toIsoDate(startDateD)

    const weekly: ContentVelocityWeek[] = arr.map(r => ({
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
})

/**
 * position-distribution — daily count of keywords per position bucket.
 * Matches `/api/sites/[siteId]/position-distribution.get.ts`.
 */

import type { Row } from '@gscdump/engine/contracts'
import type { AnalysisParams } from '../types'
import { enumeratePartitions } from '@gscdump/engine/planner'
import { defineAnalyzer } from '../analyzer/define'
import { periodOf } from '../period'
import { num } from '../types'

export interface PositionDistributionResult {
  date: string
  pos_1_3: number
  pos_4_10: number
  pos_11_20: number
  pos_20_plus: number
  total: number
}

function str(v: unknown): string {
  return v == null ? '' : String(v)
}

export const positionDistributionAnalyzer = defineAnalyzer<AnalysisParams, Row, PositionDistributionResult[]>({
  id: 'position-distribution',

  buildSql(params) {
    const { startDate, endDate } = periodOf(params)
    const sql = `
    WITH pos AS (
      SELECT
        date,
        (sum_position / NULLIF(impressions, 0) + 1) AS avg_pos
      FROM read_parquet({{FILES}}, union_by_name = true)
      WHERE date >= ? AND date <= ? AND impressions > 0
    )
    SELECT
      date,
      CAST(SUM(CASE WHEN avg_pos <= 3 THEN 1 ELSE 0 END) AS DOUBLE) AS pos_1_3,
      CAST(SUM(CASE WHEN avg_pos > 3 AND avg_pos <= 10 THEN 1 ELSE 0 END) AS DOUBLE) AS pos_4_10,
      CAST(SUM(CASE WHEN avg_pos > 10 AND avg_pos <= 20 THEN 1 ELSE 0 END) AS DOUBLE) AS pos_11_20,
      CAST(SUM(CASE WHEN avg_pos > 20 THEN 1 ELSE 0 END) AS DOUBLE) AS pos_20_plus,
      CAST(COUNT(*) AS DOUBLE) AS total
    FROM pos
    GROUP BY date
    ORDER BY date ASC
  `
    return {
      sql,
      params: [startDate, endDate],
      current: { table: 'keywords', partitions: enumeratePartitions(startDate, endDate) },
    }
  },

  reduceSql(rows, params) {
    const arr = Array.isArray(rows) ? rows : []
    const { startDate, endDate } = periodOf(params)
    return {
      results: arr.map(r => ({
        date: str(r.date),
        pos_1_3: num(r.pos_1_3),
        pos_4_10: num(r.pos_4_10),
        pos_11_20: num(r.pos_11_20),
        pos_20_plus: num(r.pos_20_plus),
        total: num(r.total),
      })),
      meta: { total: arr.length, startDate, endDate },
    }
  },
})

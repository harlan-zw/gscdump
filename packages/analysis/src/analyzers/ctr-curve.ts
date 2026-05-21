/**
 * `ctr-curve` — CTR by position bucket plus over/under-performing outliers.
 * SQL-only colocation.
 *
 * Migrated from `engine-duckdb-node/src/analyzers/ctr-curve.ts`.
 */

import type { AnalysisParams } from '@gscdump/engine/analysis-types'
import type { Row } from '@gscdump/engine/contracts'
import { defineAnalyzer } from '@gscdump/engine/analyzer'
import { periodOf } from '@gscdump/engine/period'
import { enumeratePartitions } from '@gscdump/engine/planner'
import { METRIC_EXPR } from '@gscdump/engine/sql-fragments'

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

export interface CtrCurveBucket {
  bucket: string
  avgCtr: number
  medianPosition: number
  keywordCount: number
  totalClicks: number
  totalImpressions: number
}

export interface CtrCurveOutlier {
  query: string
  clicks: number
  impressions: number
  ctr: number
  position: number
  expectedCtr: number
  ctrDiff: number
}

export const ctrCurveAnalyzer = defineAnalyzer<AnalysisParams, Row, CtrCurveBucket[]>({
  id: 'ctr-curve',

  buildSql(params) {
    const { startDate, endDate } = periodOf(params)
    const sql = `
    WITH src AS (
      SELECT
        query,
        clicks,
        impressions,
        sum_position,
        (sum_position / NULLIF(impressions, 0) + 1) AS avg_pos
      FROM read_parquet({{FILES}}, union_by_name = true)
      WHERE date >= ? AND date <= ? AND impressions > 0
    ),
    curve AS (
      SELECT
        CASE
          WHEN avg_pos <= 1.5 THEN '1'
          WHEN avg_pos <= 2.5 THEN '2'
          WHEN avg_pos <= 3.5 THEN '3'
          WHEN avg_pos <= 5.5 THEN '4-5'
          WHEN avg_pos <= 10.5 THEN '6-10'
          WHEN avg_pos <= 20.5 THEN '11-20'
          ELSE '20+'
        END AS bucket,
        AVG(CAST(clicks AS DOUBLE) / NULLIF(impressions, 0)) AS avgCtr,
        AVG(avg_pos) AS medianPosition,
        CAST(COUNT(DISTINCT query) AS DOUBLE) AS keywordCount,
        ${METRIC_EXPR.clicks} AS totalClicks,
        ${METRIC_EXPR.impressions} AS totalImpressions
      FROM src
      GROUP BY bucket
    ),
    ks AS (
      SELECT
        query,
        ${METRIC_EXPR.clicks} AS clicks,
        ${METRIC_EXPR.impressions} AS impressions,
        ${METRIC_EXPR.ctr} AS ctr,
        ${METRIC_EXPR.position} AS position,
        CASE
          WHEN ${METRIC_EXPR.position} <= 3.5 THEN 'top3'
          WHEN ${METRIC_EXPR.position} <= 10.5 THEN 'page1'
          WHEN ${METRIC_EXPR.position} <= 20.5 THEN 'page2'
          ELSE 'deep'
        END AS band
      FROM src
      GROUP BY query
      HAVING SUM(impressions) >= 20
    ),
    band_avg AS (
      SELECT band, AVG(ctr) AS band_avg_ctr FROM ks GROUP BY band
    ),
    outliers AS (
      SELECT
        ks.query, ks.clicks, ks.impressions, ks.ctr, ks.position,
        ba.band_avg_ctr AS expectedCtr,
        ks.ctr - ba.band_avg_ctr AS ctrDiff
      FROM ks JOIN band_avg ba ON ks.band = ba.band
      ORDER BY ABS(ks.ctr - ba.band_avg_ctr) DESC
      LIMIT 50
    )
    SELECT
      (SELECT to_json(list({
        'bucket': bucket,
        'avgCtr': avgCtr,
        'medianPosition': medianPosition,
        'keywordCount': keywordCount,
        'totalClicks': totalClicks,
        'totalImpressions': totalImpressions
      })) FROM curve) AS curve_json,
      (SELECT to_json(list({
        'query': query,
        'clicks': clicks,
        'impressions': impressions,
        'ctr': ctr,
        'position': position,
        'expectedCtr': expectedCtr,
        'ctrDiff': ctrDiff
      })) FROM outliers) AS outliers_json
  `
    return {
      sql,
      params: [startDate, endDate],
      current: { table: 'queries', partitions: enumeratePartitions(startDate, endDate) },
    }
  },

  reduceSql(rows, params) {
    const arr = Array.isArray(rows) ? rows : []
    const { startDate, endDate } = periodOf(params)
    const row = arr[0] ?? {}
    const curve: CtrCurveBucket[] = parseJsonList(row.curve_json).map(r => ({
      bucket: str(r.bucket),
      avgCtr: num(r.avgCtr),
      medianPosition: num(r.medianPosition),
      keywordCount: num(r.keywordCount),
      totalClicks: num(r.totalClicks),
      totalImpressions: num(r.totalImpressions),
    }))
    const outliers: CtrCurveOutlier[] = parseJsonList(row.outliers_json).map(r => ({
      query: str(r.query),
      clicks: num(r.clicks),
      impressions: num(r.impressions),
      ctr: num(r.ctr),
      position: num(r.position),
      expectedCtr: num(r.expectedCtr),
      ctrDiff: num(r.ctrDiff),
    }))
    // Server splits into over/underperforming by sign of ctrDiff and takes 25 of each.
    const over = outliers.filter(o => o.ctrDiff > 0).slice(0, 25)
    const under = outliers.filter(o => o.ctrDiff < 0).slice(0, 25)
    return {
      results: curve,
      meta: { overperforming: over, underperforming: under, startDate, endDate },
    }
  },
})

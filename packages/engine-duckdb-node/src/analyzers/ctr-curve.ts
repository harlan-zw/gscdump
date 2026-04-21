/**
 * ctr-curve — CTR by position bucket plus over/under-performing outliers.
 * Matches `/api/sites/[siteId]/ctr-curve.get.ts`.
 *
 * Returns two result sections via to_json(list(...)) so the whole thing fits
 * in one SQL pass. Shape splits them into results (curve) and meta
 * (overperforming / underperforming).
 */

import type { AnalysisParams, AnalyzerSpec } from '../shared'

import { enumeratePartitions } from '@gscdump/engine/planner'
import { num, parseJsonList, period, str } from '../shared'

export function buildCtrCurve(params: AnalysisParams): AnalyzerSpec {
  const { startDate, endDate } = period(params)
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
        CAST(SUM(clicks) AS DOUBLE) AS totalClicks,
        CAST(SUM(impressions) AS DOUBLE) AS totalImpressions
      FROM src
      GROUP BY bucket
    ),
    ks AS (
      SELECT
        query,
        CAST(SUM(clicks) AS DOUBLE) AS clicks,
        CAST(SUM(impressions) AS DOUBLE) AS impressions,
        CAST(SUM(clicks) AS DOUBLE) / NULLIF(SUM(impressions), 0) AS ctr,
        SUM(sum_position) / NULLIF(SUM(impressions), 0) + 1 AS position,
        CASE
          WHEN SUM(sum_position) / NULLIF(SUM(impressions), 0) + 1 <= 3.5 THEN 'top3'
          WHEN SUM(sum_position) / NULLIF(SUM(impressions), 0) + 1 <= 10.5 THEN 'page1'
          WHEN SUM(sum_position) / NULLIF(SUM(impressions), 0) + 1 <= 20.5 THEN 'page2'
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
    current: { table: 'keywords', partitions: enumeratePartitions(startDate, endDate) },
    shape: (rows) => {
      const row = rows[0] ?? {}
      const curve = parseJsonList(row.curve_json).map(r => ({
        bucket: str(r.bucket),
        avgCtr: num(r.avgCtr),
        medianPosition: num(r.medianPosition),
        keywordCount: num(r.keywordCount),
        totalClicks: num(r.totalClicks),
        totalImpressions: num(r.totalImpressions),
      }))
      const outliers = parseJsonList(row.outliers_json).map(r => ({
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
  }
}

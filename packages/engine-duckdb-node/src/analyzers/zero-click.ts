import type { AnalysisParams, AnalyzerSpec } from '../shared'

import { enumeratePartitions } from '@gscdump/engine/planner'
import { num, period, str } from '../shared'

export function buildZeroClick(params: AnalysisParams): AnalyzerSpec {
  const { startDate, endDate } = period(params)
  const minImpressions = params.minImpressions ?? 1000
  const maxCtr = params.maxCtr ?? 0.03
  const maxPosition = params.maxPosition ?? 10
  const limit = params.limit ?? 1000

  // Group by query+url, filter on impressions/position/ctr, and compute
  // missedClicks via tiered expected-CTR. Ordering mirrors the server-side
  // analyzer (impressions DESC) so parity tests stay byte-identical.
  const sql = `
    WITH agg AS (
      SELECT
        query,
        url AS page,
        CAST(SUM(clicks) AS DOUBLE) AS clicks,
        CAST(SUM(impressions) AS DOUBLE) AS impressions,
        CAST(SUM(clicks) AS DOUBLE) / NULLIF(SUM(impressions), 0) AS ctr,
        SUM(sum_position) / NULLIF(SUM(impressions), 0) + 1 AS position
      FROM read_parquet({{FILES}}, union_by_name = true)
      WHERE date >= ? AND date <= ?
      GROUP BY query, url
      HAVING SUM(impressions) >= ?
    )
    SELECT
      query, page, clicks, impressions, ctr, position,
      CAST(GREATEST(0, ROUND(impressions * (
        CASE
          WHEN position <= 1 THEN 0.30
          WHEN position <= 3 THEN 0.15
          WHEN position <= 5 THEN 0.08
          ELSE 0.04
        END
      )) - clicks) AS DOUBLE) AS missedClicks
    FROM agg
    WHERE position <= ? AND ctr < ?
    ORDER BY impressions DESC
    LIMIT ${Number(limit)}
  `

  return {
    sql,
    params: [startDate, endDate, minImpressions, maxPosition, maxCtr],
    current: { table: 'page_keywords', partitions: enumeratePartitions(startDate, endDate) },
    shape: rows => ({
      results: rows.map(r => ({
        query: str(r.query),
        page: r.page == null ? null : str(r.page),
        clicks: num(r.clicks),
        impressions: num(r.impressions),
        ctr: num(r.ctr),
        position: num(r.position),
        missedClicks: num(r.missedClicks),
      })),
      meta: {
        total: rows.length,
        minImpressions,
        maxCtr,
        maxPosition,
      },
    }),
  }
}

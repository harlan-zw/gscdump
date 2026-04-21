import type { AnalysisParams, AnalyzerSpec } from '../shared'

import { enumeratePartitions } from '@gscdump/engine/planner'
import { num, period, str } from '../shared'

export function buildOpportunity(params: AnalysisParams): AnalyzerSpec {
  const { startDate, endDate } = period(params)
  const minImpressions = params.minImpressions ?? 100
  const w1 = 1
  const w2 = 1
  const w3 = 1
  const totalW = w1 + w2 + w3
  const limit = params.limit ?? 1000

  const sql = `
    WITH agg AS (
      SELECT
        query AS keyword,
        url AS page,
        CAST(SUM(clicks) AS DOUBLE) AS clicks,
        CAST(SUM(impressions) AS DOUBLE) AS impressions,
        CAST(SUM(clicks) AS DOUBLE) / NULLIF(SUM(impressions), 0) AS ctr,
        SUM(sum_position) / NULLIF(SUM(impressions), 0) + 1 AS position
      FROM read_parquet({{FILES}}, union_by_name = true)
      WHERE date >= ? AND date <= ?
      GROUP BY query, url
      HAVING SUM(impressions) >= ?
    ),
    scored AS (
      SELECT
        keyword, page, clicks, impressions, ctr, position,
        CASE
          WHEN position <= 3 THEN 0.2
          WHEN position > 50 THEN 0.1
          ELSE GREATEST(0.0, 1.0 - ABS(position - 11.0) / 15.0)
        END AS positionScore,
        CASE WHEN impressions <= 0 THEN 0.0 ELSE LEAST(LOG10(impressions) / 5.0, 1.0) END AS impressionScore,
        CASE CAST(ROUND(GREATEST(LEAST(position, 10.0), 1.0)) AS INTEGER)
          WHEN 1 THEN 0.30
          WHEN 2 THEN 0.15
          WHEN 3 THEN 0.10
          WHEN 4 THEN 0.07
          WHEN 5 THEN 0.05
          WHEN 6 THEN 0.04
          WHEN 7 THEN 0.03
          WHEN 8 THEN 0.025
          WHEN 9 THEN 0.02
          WHEN 10 THEN 0.015
          ELSE 0.01
        END AS expectedCtr
      FROM agg
    ),
    gapped AS (
      SELECT
        *,
        CASE WHEN ctr >= expectedCtr THEN 0.0 ELSE LEAST((expectedCtr - ctr) / expectedCtr, 1.0) END AS ctrGapScore
      FROM scored
    )
    SELECT
      keyword, page, clicks, impressions, ctr, position,
      CAST(ROUND(POWER(
        POWER(positionScore, ${w1}) * POWER(impressionScore, ${w2}) * POWER(ctrGapScore, ${w3}),
        1.0 / ${totalW}
      ) * 100) AS DOUBLE) AS opportunityScore,
      CAST(ROUND(impressions * (
        CASE CAST(ROUND(GREATEST(LEAST(position, 3.0), 1.0)) AS INTEGER)
          WHEN 1 THEN 0.30
          WHEN 2 THEN 0.15
          WHEN 3 THEN 0.10
          ELSE 0.10
        END
      )) AS DOUBLE) AS potentialClicks,
      positionScore, impressionScore, ctrGapScore
    FROM gapped
    ORDER BY opportunityScore DESC
    LIMIT ${Number(limit)}
  `

  return {
    sql,
    params: [startDate, endDate, minImpressions],
    current: { table: 'page_keywords', partitions: enumeratePartitions(startDate, endDate) },
    shape: rows => ({
      results: rows.map(r => ({
        keyword: str(r.keyword),
        page: r.page == null ? null : str(r.page),
        clicks: num(r.clicks),
        impressions: num(r.impressions),
        ctr: num(r.ctr),
        position: num(r.position),
        opportunityScore: num(r.opportunityScore),
        potentialClicks: num(r.potentialClicks),
        factors: {
          positionScore: num(r.positionScore),
          impressionScore: num(r.impressionScore),
          ctrGapScore: num(r.ctrGapScore),
        },
      })),
      meta: { total: rows.length },
    }),
  }
}

import type { AnalysisParams, AnalyzerSpec, Row, TableName } from '../shared'

import { enumeratePartitions } from '@gscdump/engine/planner'
import { num, parseJsonList, period, str } from '../shared'

export function buildConcentration(params: AnalysisParams): AnalyzerSpec {
  const { startDate, endDate } = period(params)
  const dim = params.dimension || 'pages'
  const topN = params.topN ?? 10
  const table: TableName = dim === 'keywords' ? 'keywords' : 'pages'
  const keyCol = dim === 'keywords' ? 'query' : 'url'

  const sql = `
    WITH items AS (
      SELECT
        ${keyCol} AS key,
        CAST(SUM(clicks) AS DOUBLE) AS clicks
      FROM read_parquet({{FILES}}, union_by_name = true)
      WHERE date >= ? AND date <= ?
      GROUP BY ${keyCol}
      HAVING SUM(clicks) > 0
    ),
    totals AS (
      SELECT SUM(clicks) AS total_clicks, COUNT(*) AS total_items FROM items
    ),
    ranked AS (
      SELECT
        i.key, i.clicks,
        i.clicks / NULLIF(t.total_clicks, 0) AS share,
        ROW_NUMBER() OVER (ORDER BY i.clicks DESC, i.key ASC) AS rnk_desc,
        ROW_NUMBER() OVER (ORDER BY i.clicks ASC, i.key ASC) AS rnk_asc,
        t.total_clicks AS tclicks,
        t.total_items AS titems
      FROM items i, totals t
    ),
    gini_num AS (
      SELECT SUM((2.0 * rnk_asc - titems - 1) * clicks) AS weighted_sum FROM ranked
    ),
    hhi_calc AS (
      SELECT SUM(POWER(share * 100, 2)) AS hhi FROM ranked
    ),
    top_list AS (
      SELECT
        list({ 'key': key, 'clicks': clicks, 'share': share } ORDER BY clicks DESC, key ASC) AS items,
        SUM(clicks) AS top_clicks
      FROM ranked WHERE rnk_desc <= ?
    )
    SELECT
      COALESCE(
        (SELECT weighted_sum FROM gini_num)
          / NULLIF((SELECT total_items FROM totals) * (SELECT total_clicks FROM totals), 0),
        0.0
      ) AS giniCoefficient,
      COALESCE((SELECT hhi FROM hhi_calc), 0.0) AS hhi,
      COALESCE(
        CAST((SELECT top_clicks FROM top_list) AS DOUBLE)
          / NULLIF((SELECT total_clicks FROM totals), 0),
        0.0
      ) AS topNConcentration,
      COALESCE((SELECT to_json(items) FROM top_list), '[]') AS topNItems,
      COALESCE((SELECT total_items FROM totals), 0) AS totalItems,
      COALESCE((SELECT total_clicks FROM totals), 0.0) AS totalClicks,
      CASE
        WHEN COALESCE((SELECT hhi FROM hhi_calc), 0.0) > 2500 THEN 'high'
        WHEN COALESCE((SELECT hhi FROM hhi_calc), 0.0) > 1500 THEN 'medium'
        ELSE 'low'
      END AS riskLevel
  `

  return {
    sql,
    params: [startDate, endDate, topN],
    current: { table, partitions: enumeratePartitions(startDate, endDate) },
    shape: (rows) => {
      const r = rows[0] ?? {}
      const topRaw: Row[] = parseJsonList(r.topNItems)
      const summary = {
        giniCoefficient: num(r.giniCoefficient),
        hhi: num(r.hhi),
        topNConcentration: num(r.topNConcentration),
        topNItems: topRaw.map(t => ({
          key: str(t.key),
          clicks: num(t.clicks),
          share: num(t.share),
        })),
        totalItems: num(r.totalItems),
        totalClicks: num(r.totalClicks),
        riskLevel: str(r.riskLevel) as 'low' | 'medium' | 'high',
      }
      return {
        results: [summary],
        meta: { total: 1, dimension: dim },
      }
    },
  }
}

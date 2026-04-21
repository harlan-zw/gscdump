import type { AnalysisParams, AnalyzerSpec } from '../shared'

import { enumeratePartitions } from '@gscdump/engine/planner'
import { escapeRegexAlt, num, period, str } from '../shared'

export function buildBrand(params: AnalysisParams): AnalyzerSpec {
  if (!params.brandTerms?.length)
    throw new Error('Brand analysis requires brandTerms')
  const { startDate, endDate } = period(params)
  const minImpressions = params.minImpressions ?? 10
  const limit = params.limit ?? 10000

  const regex = `(${params.brandTerms.map(t => escapeRegexAlt(t.toLowerCase())).join('|')})`

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
      CASE WHEN regexp_matches(LOWER(query), ?) THEN 'brand' ELSE 'non-brand' END AS segment
    FROM agg
    ORDER BY clicks DESC
    LIMIT ${Number(limit)}
  `

  return {
    sql,
    params: [startDate, endDate, minImpressions, regex],
    current: { table: 'page_keywords', partitions: enumeratePartitions(startDate, endDate) },
    shape: (rows) => {
      const normalized = rows.map(r => ({
        query: str(r.query),
        page: r.page == null ? undefined : str(r.page),
        clicks: num(r.clicks),
        impressions: num(r.impressions),
        ctr: num(r.ctr),
        position: num(r.position),
        segment: str(r.segment) as 'brand' | 'non-brand',
      }))
      let brandClicks = 0
      let nonBrandClicks = 0
      let brandImpressions = 0
      let nonBrandImpressions = 0
      for (const r of normalized) {
        if (r.segment === 'brand') {
          brandClicks += r.clicks
          brandImpressions += r.impressions
        }
        else {
          nonBrandClicks += r.clicks
          nonBrandImpressions += r.impressions
        }
      }
      const totalClicks = brandClicks + nonBrandClicks
      return {
        results: normalized,
        meta: {
          total: normalized.length,
          summary: {
            brandClicks,
            nonBrandClicks,
            brandShare: totalClicks > 0 ? brandClicks / totalClicks : 0,
            brandImpressions,
            nonBrandImpressions,
          },
        },
      }
    },
  }
}

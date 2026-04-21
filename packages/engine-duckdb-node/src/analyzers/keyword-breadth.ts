/**
 * keyword-breadth — keyword-count histogram across pages + fragile/authority
 * classification. Matches `/api/sites/[siteId]/keyword-breadth.get.ts`.
 */

import type { AnalysisParams, AnalyzerSpec } from '../shared'

import { enumeratePartitions } from '@gscdump/engine/planner'
import { num, parseJsonList, period, str } from '../shared'

export function buildKeywordBreadth(params: AnalysisParams): AnalyzerSpec {
  const { startDate, endDate } = period(params)
  const sql = `
    WITH per_page AS (
      SELECT
        url,
        CAST(COUNT(DISTINCT query) AS DOUBLE) AS keywordCount,
        CAST(SUM(clicks) AS DOUBLE) AS clicks,
        CAST(SUM(impressions) AS DOUBLE) AS impressions
      FROM read_parquet({{FILES}}, union_by_name = true)
      WHERE date >= ? AND date <= ? AND impressions > 0
      GROUP BY url
    ),
    bucketed AS (
      SELECT
        CASE
          WHEN keywordCount = 1 THEN '1'
          WHEN keywordCount BETWEEN 2 AND 5 THEN '2-5'
          WHEN keywordCount BETWEEN 6 AND 15 THEN '6-15'
          WHEN keywordCount BETWEEN 16 AND 50 THEN '16-50'
          ELSE '50+'
        END AS bucket,
        MIN(keywordCount) AS sort_key,
        CAST(COUNT(*) AS DOUBLE) AS pageCount
      FROM per_page
      GROUP BY bucket
    ),
    fragile AS (
      SELECT url, keywordCount, clicks, impressions
      FROM per_page
      WHERE keywordCount <= 2 AND clicks >= 5
      ORDER BY clicks DESC
      LIMIT 20
    ),
    authority AS (
      SELECT url, keywordCount, clicks, impressions
      FROM per_page
      WHERE keywordCount >= 20
      ORDER BY keywordCount DESC
      LIMIT 20
    ),
    stats AS (
      SELECT
        CAST(COUNT(*) AS DOUBLE) AS totalPages,
        CAST(AVG(keywordCount) AS DOUBLE) AS avgKeywordsPerPage,
        CAST(SUM(CASE WHEN keywordCount <= 2 THEN 1 ELSE 0 END) AS DOUBLE) AS fragileCount,
        CAST(SUM(CASE WHEN keywordCount >= 20 THEN 1 ELSE 0 END) AS DOUBLE) AS authorityCount
      FROM per_page
    )
    SELECT
      (SELECT to_json(list({ 'bucket': bucket, 'pageCount': pageCount, 'sortKey': sort_key })
        ORDER BY sort_key ASC) FROM bucketed) AS distribution_json,
      (SELECT to_json(list({ 'url': url, 'keywordCount': keywordCount, 'clicks': clicks, 'impressions': impressions })) FROM fragile) AS fragile_json,
      (SELECT to_json(list({ 'url': url, 'keywordCount': keywordCount, 'clicks': clicks, 'impressions': impressions })) FROM authority) AS authority_json,
      (SELECT to_json({
        'totalPages': totalPages,
        'avgKeywordsPerPage': avgKeywordsPerPage,
        'fragileCount': fragileCount,
        'authorityCount': authorityCount
      }) FROM stats) AS stats_json
  `
  return {
    sql,
    params: [startDate, endDate],
    current: { table: 'page_keywords', partitions: enumeratePartitions(startDate, endDate) },
    shape: (rows) => {
      const row = rows[0] ?? {}
      const distribution = parseJsonList(row.distribution_json)
        .sort((a, b) => num(a.sortKey) - num(b.sortKey))
        .map(r => ({ bucket: str(r.bucket), pageCount: num(r.pageCount) }))
      const fragile = parseJsonList(row.fragile_json).map(r => ({
        url: str(r.url),
        keywordCount: num(r.keywordCount),
        clicks: num(r.clicks),
        impressions: num(r.impressions),
      }))
      const authority = parseJsonList(row.authority_json).map(r => ({
        url: str(r.url),
        keywordCount: num(r.keywordCount),
        clicks: num(r.clicks),
        impressions: num(r.impressions),
      }))
      const stats = typeof row.stats_json === 'string'
        ? JSON.parse(row.stats_json)
        : (row.stats_json ?? {})
      return {
        results: distribution,
        meta: {
          fragilePages: fragile,
          authorityPages: authority,
          summary: {
            totalPages: num(stats.totalPages),
            avgKeywordsPerPage: num(stats.avgKeywordsPerPage),
            fragileCount: num(stats.fragileCount),
            authorityCount: num(stats.authorityCount),
          },
          startDate,
          endDate,
        },
      }
    },
  }
}

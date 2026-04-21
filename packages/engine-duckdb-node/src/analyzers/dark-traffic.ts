/**
 * dark-traffic — gap between page-level clicks and sum-of-keyword clicks.
 * Matches `/api/sites/[siteId]/dark-traffic.get.ts`.
 *
 * Reads three tables: pages (primary), keywords (summary aggregate),
 * page_keywords (per-page attribution). Uses `extraFiles` for the latter two.
 */

import type { AnalysisParams, AnalyzerSpec } from '../shared'

import { enumeratePartitions } from '@gscdump/engine/planner'
import { num, parseJsonList, period, str } from '../shared'

export function buildDarkTraffic(params: AnalysisParams): AnalyzerSpec {
  const { startDate, endDate } = period(params)
  const sql = `
    WITH page_totals AS (
      SELECT SUM(clicks) AS total_clicks, SUM(impressions) AS total_impressions
      FROM read_parquet({{FILES}}, union_by_name = true)
      WHERE date >= ? AND date <= ?
    ),
    kw_totals AS (
      SELECT SUM(clicks) AS total_clicks, SUM(impressions) AS total_impressions
      FROM read_parquet({{FILES_KEYWORDS}}, union_by_name = true)
      WHERE date >= ? AND date <= ?
    ),
    per_page AS (
      SELECT url, SUM(clicks) AS page_clicks
      FROM read_parquet({{FILES}}, union_by_name = true)
      WHERE date >= ? AND date <= ?
      GROUP BY url
      HAVING SUM(clicks) > 0
    ),
    per_page_kw AS (
      SELECT url, SUM(clicks) AS attributed_clicks, COUNT(DISTINCT query) AS kw_count
      FROM read_parquet({{FILES_PAGE_KEYWORDS}}, union_by_name = true)
      WHERE date >= ? AND date <= ?
      GROUP BY url
    ),
    page_rows AS (
      SELECT
        p.url AS url,
        CAST(p.page_clicks AS DOUBLE) AS totalClicks,
        CAST(COALESCE(k.attributed_clicks, 0) AS DOUBLE) AS attributedClicks,
        CAST(p.page_clicks - COALESCE(k.attributed_clicks, 0) AS DOUBLE) AS darkClicks,
        CAST(p.page_clicks - COALESCE(k.attributed_clicks, 0) AS DOUBLE)
          / NULLIF(p.page_clicks, 0) AS darkPercent,
        CAST(COALESCE(k.kw_count, 0) AS DOUBLE) AS keywordCount
      FROM per_page p
      LEFT JOIN per_page_kw k ON p.url = k.url
      WHERE p.page_clicks - COALESCE(k.attributed_clicks, 0) > 0
      ORDER BY darkClicks DESC
      LIMIT 50
    )
    SELECT
      (SELECT to_json({
        'totalClicks': CAST(total_clicks AS DOUBLE),
        'totalImpressions': CAST(total_impressions AS DOUBLE)
      }) FROM page_totals) AS page_totals_json,
      (SELECT to_json({
        'attributedClicks': CAST(total_clicks AS DOUBLE),
        'attributedImpressions': CAST(total_impressions AS DOUBLE)
      }) FROM kw_totals) AS kw_totals_json,
      (SELECT to_json(list({
        'url': url,
        'totalClicks': totalClicks,
        'attributedClicks': attributedClicks,
        'darkClicks': darkClicks,
        'darkPercent': darkPercent,
        'keywordCount': keywordCount
      })) FROM page_rows) AS pages_json
  `
  return {
    sql,
    params: [startDate, endDate, startDate, endDate, startDate, endDate, startDate, endDate],
    current: { table: 'pages', partitions: enumeratePartitions(startDate, endDate) },
    extraFiles: {
      KEYWORDS: { table: 'keywords', partitions: enumeratePartitions(startDate, endDate) },
      PAGE_KEYWORDS: { table: 'page_keywords', partitions: enumeratePartitions(startDate, endDate) },
    },
    shape: (rows) => {
      const row = rows[0] ?? {}
      const pageTotals = typeof row.page_totals_json === 'string'
        ? JSON.parse(row.page_totals_json)
        : (row.page_totals_json ?? {})
      const kwTotals = typeof row.kw_totals_json === 'string'
        ? JSON.parse(row.kw_totals_json)
        : (row.kw_totals_json ?? {})
      const totalClicks = num(pageTotals.totalClicks)
      const totalImpressions = num(pageTotals.totalImpressions)
      const attributedClicks = num(kwTotals.attributedClicks)
      const attributedImpressions = num(kwTotals.attributedImpressions)
      const darkClicks = Math.max(0, totalClicks - attributedClicks)
      const darkPercent = totalClicks > 0 ? darkClicks / totalClicks : 0
      const pages = parseJsonList(row.pages_json).map(r => ({
        url: str(r.url),
        totalClicks: num(r.totalClicks),
        attributedClicks: num(r.attributedClicks),
        darkClicks: num(r.darkClicks),
        darkPercent: num(r.darkPercent),
        keywordCount: num(r.keywordCount),
      }))
      return {
        results: pages,
        meta: {
          summary: {
            totalClicks,
            attributedClicks,
            darkClicks,
            darkPercent,
            totalImpressions,
            attributedImpressions,
          },
          startDate,
          endDate,
        },
      }
    },
  }
}

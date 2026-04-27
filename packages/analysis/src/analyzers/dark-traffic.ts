/**
 * dark-traffic — gap between page-level clicks and sum-of-keyword clicks.
 *
 * Reads three tables: pages (primary), keywords (summary aggregate),
 * page_keywords (per-page attribution). Uses `extraFiles` for the latter two.
 */

import type { Row } from '@gscdump/engine/contracts'
import type { AnalysisParams } from '../types'
import { enumeratePartitions } from '@gscdump/engine/planner'
import { defineAnalyzer } from '../analyzer/define'
import { periodOf } from '../period'
import { num } from '../types'

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

export interface DarkTrafficResult {
  url: string
  totalClicks: number
  attributedClicks: number
  darkClicks: number
  darkPercent: number
  keywordCount: number
}

export const darkTrafficAnalyzer = defineAnalyzer<AnalysisParams, Row, DarkTrafficResult[]>({
  id: 'dark-traffic',

  buildSql(params) {
    const { startDate, endDate } = periodOf(params)
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
    }
  },

  reduceSql(rows, params) {
    const arr = Array.isArray(rows) ? rows : []
    const { startDate, endDate } = periodOf(params)
    const row = arr[0] ?? {}
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
})

/**
 * `concentration` — measures traffic distribution (Gini / HHI / topN) across
 * either pages or keywords. The `params.dimension` ('pages' | 'keywords')
 * switches the keyed grouping on both paths: SQL builds against the
 * matching table/column; the row reducer requests one of two keyed query
 * shapes and reduces over the corresponding row set.
 */

import type { Row, TableName } from '@gscdump/engine/contracts'
import type { BuilderState } from 'gscdump/query'
import type { AnalysisParams, KeywordRow, PageRow } from '../types'
import { enumeratePartitions } from '@gscdump/engine/planner'
import { METRIC_EXPR } from '@gscdump/engine/sql-fragments'
import { keywordsQueryState, pagesQueryState } from '../analyzer/adapt-rows'
import { defineAnalyzer } from '../analyzer/define'
import { periodOf } from '../period'
import { num } from '../types'

export type ConcentrationRiskLevel = 'low' | 'medium' | 'high'

export interface ConcentrationOptions {
  /** Number of top items to report. Default: 10 */
  topN?: number
}

export interface ConcentrationItem {
  key: string
  clicks: number
  share: number
}

export interface ConcentrationInput {
  key: string
  clicks: number
}

export interface ConcentrationResult {
  /** Gini coefficient: 0 = equal distribution, 1 = fully concentrated */
  giniCoefficient: number
  /** Herfindahl-Hirschman Index: 0-10000, >2500 = highly concentrated */
  hhi: number
  /** Percentage of total clicks from top N items */
  topNConcentration: number
  topNItems: ConcentrationItem[]
  totalItems: number
  totalClicks: number
  /** Risk level derived from HHI: <1500 low, 1500-2500 medium, >2500 high */
  riskLevel: ConcentrationRiskLevel
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

function calculateGini(values: number[]): number {
  if (values.length === 0)
    return 0
  const sorted = [...values].sort((a, b) => a - b)
  const n = sorted.length
  const sum = sorted.reduce((a, b) => a + b, 0)
  if (sum === 0)
    return 0

  let weightedSum = 0
  for (let i = 0; i < n; i++) {
    weightedSum += (2 * (i + 1) - n - 1) * sorted[i]!
  }
  return weightedSum / (n * sum)
}

function calculateHHI(shares: number[]): number {
  return shares.reduce((sum, share) => sum + (share * 100) ** 2, 0)
}

/**
 * Pure helper: analyze traffic concentration across items (pages or keywords).
 * Re-exported from `@gscdump/analysis` for portable callers.
 */
export function analyzeConcentration(
  items: ConcentrationInput[],
  options: ConcentrationOptions = {},
): ConcentrationResult {
  const { topN = 10 } = options

  if (items.length === 0) {
    return {
      giniCoefficient: 0,
      hhi: 0,
      topNConcentration: 0,
      topNItems: [],
      totalItems: 0,
      totalClicks: 0,
      riskLevel: 'low',
    }
  }

  const sorted = [...items].sort((a, b) => b.clicks - a.clicks)
  const totalClicks = sorted.reduce((sum, item) => sum + item.clicks, 0)
  const clickValues = sorted.map(i => i.clicks)
  const shares = totalClicks > 0 ? sorted.map(i => i.clicks / totalClicks) : []

  const giniCoefficient = calculateGini(clickValues)
  const hhi = calculateHHI(shares)

  const topNItems: ConcentrationItem[] = sorted.slice(0, topN).map(item => ({
    key: item.key,
    clicks: item.clicks,
    share: totalClicks > 0 ? item.clicks / totalClicks : 0,
  }))

  const topNClicks = topNItems.reduce((sum, item) => sum + item.clicks, 0)
  const topNConcentration = totalClicks > 0 ? topNClicks / totalClicks : 0

  let riskLevel: ConcentrationRiskLevel = 'low'
  if (hhi > 2500)
    riskLevel = 'high'
  else if (hhi > 1500)
    riskLevel = 'medium'

  return {
    giniCoefficient,
    hhi,
    topNConcentration,
    topNItems,
    totalItems: items.length,
    totalClicks,
    riskLevel,
  }
}

/**
 * Page concentration analysis.
 */
export function analyzePageConcentration(
  pages: PageRow[],
  options?: ConcentrationOptions,
): ConcentrationResult {
  return analyzeConcentration(
    pages.map(p => ({ key: p.page, clicks: num(p.clicks) })),
    options,
  )
}

/**
 * Keyword concentration analysis.
 */
export function analyzeKeywordConcentration(
  keywords: KeywordRow[],
  options?: ConcentrationOptions,
): ConcentrationResult {
  return analyzeConcentration(
    keywords.map(k => ({ key: k.query, clicks: num(k.clicks) })),
    options,
  )
}

export const concentrationAnalyzer = defineAnalyzer<AnalysisParams, Row, ConcentrationResult[]>({
  id: 'concentration',

  buildSql(params) {
    const { startDate, endDate } = periodOf(params)
    const dim = params.dimension || 'pages'
    const topN = params.topN ?? 10
    const table: TableName = dim === 'keywords' ? 'keywords' : 'pages'
    const keyCol = dim === 'keywords' ? 'query' : 'url'

    const sql = `
    WITH items AS (
      SELECT
        ${keyCol} AS key,
        ${METRIC_EXPR.clicks} AS clicks
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
    }
  },

  reduceSql(rows, params) {
    const arr = Array.isArray(rows) ? rows : []
    const r = arr[0] ?? {}
    const topRaw: Row[] = parseJsonList(r.topNItems)
    const summary: ConcentrationResult = {
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
      riskLevel: str(r.riskLevel) as ConcentrationRiskLevel,
    }
    return {
      results: [summary],
      meta: { total: 1, dimension: params.dimension || 'pages' },
    }
  },

  buildRows(params) {
    const dim = params.dimension || 'pages'
    const period = periodOf(params)
    const out: Record<string, BuilderState> = {}
    if (dim === 'pages')
      out.pages = pagesQueryState(period, params.limit)
    else
      out.keywords = keywordsQueryState(period, params.limit)
    return out
  },

  reduceRows(rows, params) {
    const dim = params.dimension || 'pages'
    // `defineAnalyzer` collapses single-key row maps to the inner array via
    // `pickSingle`, so for both 'pages' and 'keywords' we receive a flat array.
    const arr = (Array.isArray(rows)
      ? rows
      : (rows as Record<string, Row[]>)[dim] ?? []) as Row[]
    const result = dim === 'pages'
      ? analyzePageConcentration(arr as unknown as PageRow[], { topN: params.topN })
      : analyzeKeywordConcentration(arr as unknown as KeywordRow[], { topN: params.topN })
    return { results: [result], meta: { dimension: dim } }
  },
})

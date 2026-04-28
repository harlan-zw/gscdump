/**
 * query-migration
 *
 * Two-period query absorption analysis. For each (page, query) pair lost in
 * the previous period and (page, query) gained in the current period across
 * different* pages, match via either exact string or `levenshtein()` ≤ 2
 * edits. The matched edge represents impressions that *probably* migrated
 * from page-A to page-B as Google reassigned the ranking URL.
 *
 * Output: a sankey-ready edge list grouped by (sourcePage → targetPage),
 * weighted by absorbed impressions, with example query pairs attached.
 */

import type { AnalysisParams } from '@gscdump/engine/analysis-types'
import type { Row } from '@gscdump/engine/contracts'
import { num } from '@gscdump/engine/analysis-types'
import { defineAnalyzer } from '@gscdump/engine/analyzer'
import { periodOf } from '@gscdump/engine/period'
import { enumeratePartitions } from '@gscdump/engine/planner'
import { METRIC_EXPR } from '@gscdump/engine/sql-fragments'
import { MS_PER_DAY, toIsoDate } from 'gscdump'

export interface QueryMigrationExample {
  sourceQuery: string
  targetQuery: string
  absorbed: number
  matchType: 'exact' | 'fuzzy'
}

export interface QueryMigrationResult {
  sourcePage: string
  targetPage: string
  weight: number
  queryCount: number
  exactCount: number
  fuzzyCount: number
  examples: QueryMigrationExample[]
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

export const queryMigrationAnalyzer = defineAnalyzer<AnalysisParams, Row, QueryMigrationResult[]>({
  id: 'query-migration',

  buildSql(params) {
    const cur = periodOf(params)
    let prevStart = params.prevStartDate
    let prevEnd = params.prevEndDate
    if (prevStart == null || prevEnd == null) {
      const curStartMs = new Date(cur.startDate).getTime()
      const curEndMs = new Date(cur.endDate).getTime()
      const span = curEndMs - curStartMs
      prevEnd = toIsoDate(new Date(curStartMs - MS_PER_DAY))
      prevStart = toIsoDate(new Date(curStartMs - MS_PER_DAY - span))
    }
    const minImpressions = params.minImpressions ?? 20
    const limit = params.limit ?? 200
    const maxLevenshtein = 2

    const sql = `
    WITH cur AS (
      SELECT query, url AS page,
        ${METRIC_EXPR.impressions} AS impressions,
        ${METRIC_EXPR.clicks} AS clicks,
        ${METRIC_EXPR.position} AS position
      FROM read_parquet({{FILES}}, union_by_name = true)
      WHERE date >= ? AND date <= ?
        AND query IS NOT NULL AND query <> ''
        AND url IS NOT NULL AND url <> ''
      GROUP BY query, url
      HAVING SUM(impressions) >= ?
    ),
    prev AS (
      SELECT query, url AS page,
        ${METRIC_EXPR.impressions} AS impressions,
        ${METRIC_EXPR.clicks} AS clicks,
        ${METRIC_EXPR.position} AS position
      FROM read_parquet({{FILES_PREV}}, union_by_name = true)
      WHERE date >= ? AND date <= ?
        AND query IS NOT NULL AND query <> ''
        AND url IS NOT NULL AND url <> ''
      GROUP BY query, url
      HAVING SUM(impressions) >= ?
    ),
    lost AS (
      SELECT p.page AS source_page, p.query AS source_query, p.impressions AS source_impressions
      FROM prev p
      LEFT JOIN cur c ON p.page = c.page AND p.query = c.query
      WHERE c.query IS NULL
    ),
    gained AS (
      SELECT c.page AS target_page, c.query AS target_query, c.impressions AS target_impressions
      FROM cur c
      LEFT JOIN prev p ON p.page = c.page AND p.query = c.query
      WHERE p.query IS NULL
    ),
    matched AS (
      SELECT
        l.source_page, l.source_query, l.source_impressions,
        g.target_page, g.target_query, g.target_impressions,
        CASE
          WHEN l.source_query = g.target_query THEN 'exact'
          ELSE 'fuzzy'
        END AS match_type,
        LEAST(l.source_impressions, g.target_impressions) AS absorbed_impressions
      FROM lost l
      JOIN gained g
        ON l.source_page <> g.target_page
        AND ABS(LENGTH(l.source_query) - LENGTH(g.target_query)) <= ${maxLevenshtein}
        AND (
          l.source_query = g.target_query
          OR levenshtein(l.source_query, g.target_query) <= ${maxLevenshtein}
        )
    ),
    edges AS (
      SELECT
        source_page, target_page,
        SUM(absorbed_impressions) AS weight,
        COUNT(*) AS query_count,
        SUM(CASE WHEN match_type = 'exact' THEN 1 ELSE 0 END) AS exact_count,
        to_json(list({
          'sourceQuery': source_query,
          'targetQuery': target_query,
          'absorbed': absorbed_impressions,
          'matchType': match_type
        } ORDER BY absorbed_impressions DESC)) AS examplesJson
      FROM matched
      GROUP BY source_page, target_page
    )
    SELECT *
    FROM edges
    ORDER BY weight DESC
    LIMIT ${Number(limit)}
  `

    return {
      sql,
      params: [
        cur.startDate,
        cur.endDate,
        minImpressions,
        prevStart,
        prevEnd,
        minImpressions,
      ],
      current: { table: 'page_keywords', partitions: enumeratePartitions(cur.startDate, cur.endDate) },
      previous: { table: 'page_keywords', partitions: enumeratePartitions(prevStart, prevEnd) },
    }
  },

  reduceSql(rows, params) {
    const arr = Array.isArray(rows) ? rows : []
    const cur = periodOf(params)
    let prevStart = params.prevStartDate
    let prevEnd = params.prevEndDate
    if (prevStart == null || prevEnd == null) {
      const curStartMs = new Date(cur.startDate).getTime()
      const curEndMs = new Date(cur.endDate).getTime()
      const span = curEndMs - curStartMs
      prevEnd = toIsoDate(new Date(curStartMs - MS_PER_DAY))
      prevStart = toIsoDate(new Date(curStartMs - MS_PER_DAY - span))
    }

    const edges: QueryMigrationResult[] = arr.map(r => ({
      sourcePage: str(r.source_page),
      targetPage: str(r.target_page),
      weight: num(r.weight),
      queryCount: num(r.query_count),
      exactCount: num(r.exact_count),
      fuzzyCount: num(r.query_count) - num(r.exact_count),
      examples: parseJsonList(r.examplesJson).slice(0, 8).map(e => ({
        sourceQuery: str(e.sourceQuery),
        targetQuery: str(e.targetQuery),
        absorbed: num(e.absorbed),
        matchType: str(e.matchType) as 'exact' | 'fuzzy',
      })),
    }))

    const nodeAgg = new Map<string, { url: string, outgoing: number, incoming: number }>()
    for (const e of edges) {
      const src = nodeAgg.get(e.sourcePage) ?? { url: e.sourcePage, outgoing: 0, incoming: 0 }
      src.outgoing += e.weight
      nodeAgg.set(e.sourcePage, src)
      const tgt = nodeAgg.get(e.targetPage) ?? { url: e.targetPage, outgoing: 0, incoming: 0 }
      tgt.incoming += e.weight
      nodeAgg.set(e.targetPage, tgt)
    }
    const nodes = [...nodeAgg.values()]
    const totalAbsorbed = edges.reduce((s, e) => s + e.weight, 0)

    return {
      results: edges,
      meta: {
        total: edges.length,
        totalAbsorbed,
        period: { current: cur, previous: { startDate: prevStart, endDate: prevEnd } },
        nodes,
      },
    }
  },
})

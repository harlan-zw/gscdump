/**
 * `cannibalization` — surfaces queries where multiple URLs compete for the
 * same SERP. SQL path computes Herfindahl-Hirschman index (HHI) on impressions
 * across URLs, fragmentation, stolen-clicks, and a 0..100 severity score, plus
 * a competitor graph (nodes/edges). Row path is the legacy reducer that flags
 * queries with a small position spread across many pages — different
 * semantics, kept for parity with the existing live-GSC behavior.
 */

import type { Row } from '@gscdump/engine/contracts'
import type { QueryPageRow, SortOrder } from '../types'
import type { AnalysisParams } from '@gscdump/engine/analysis-types'
import { enumeratePartitions } from '@gscdump/engine/planner'
import { METRIC_EXPR } from '@gscdump/engine/sql-fragments'
import { keywordsQueryState } from '../analyzer/adapt-rows'
import { defineAnalyzer } from '@gscdump/engine/analyzer'
import { periodOf } from '@gscdump/engine/period'
import { createSorter } from '../types'
import { num } from '@gscdump/engine/analysis-types'

export type CannibalizationSortMetric = 'clicks' | 'impressions' | 'positionSpread' | 'pageCount'

export interface CannibalizationOptions {
  /** Minimum impressions for a query to be considered. Default: 10 */
  minImpressions?: number
  /** Maximum position spread to flag as cannibalization. Default: 10 */
  maxPositionSpread?: number
  /** Minimum number of pages ranking for same query. Default: 2 */
  minPages?: number
  /** Sort metric. Default: clicks */
  sortBy?: CannibalizationSortMetric
  /** Sort order. Default: desc */
  sortOrder?: SortOrder
}

export interface CannibalizationPage {
  page: string
  clicks: number
  impressions: number
  ctr: number
  position: number
}

export interface CannibalizationResult {
  query: string
  pages: CannibalizationPage[]
  totalClicks: number
  totalImpressions: number
  positionSpread: number
}

export interface CannibalizationCompetitor {
  url: string
  clicks: number
  impressions: number
  ctr: number
  position: number
  share: number
  rank: number
}

export interface CannibalizationEvent {
  keyword: string
  totalImpressions: number
  totalClicks: number
  competitorCount: number
  leaderUrl: string
  leaderCtr: number
  leaderPosition: number
  hhi: number
  fragmentation: number
  stolenClicks: number
  severity: number
  competitors: CannibalizationCompetitor[]
}

const sortRowResults = createSorter<CannibalizationResult, CannibalizationSortMetric>(
  (item, metric) => {
    switch (metric) {
      case 'clicks': return item.totalClicks
      case 'impressions': return item.totalImpressions
      case 'positionSpread': return item.positionSpread
      case 'pageCount': return item.pages.length
    }
  },
  'clicks',
)

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

/**
 * Pure helper: detects keyword cannibalization from row data — queries
 * ranking for multiple pages within a small position spread. Re-exported
 * from `@gscdump/analysis` for portable callers.
 */
export function analyzeCannibalization(
  rows: QueryPageRow[],
  options: CannibalizationOptions = {},
): CannibalizationResult[] {
  const {
    minImpressions = 10,
    maxPositionSpread = 10,
    minPages = 2,
    sortBy = 'clicks',
    sortOrder = 'desc',
  } = options

  const queryMap = new Map<string, CannibalizationPage[]>()

  for (const row of rows) {
    if (row.impressions < minImpressions)
      continue

    const pages = queryMap.get(row.query) || []
    pages.push({
      page: row.page,
      clicks: row.clicks,
      impressions: row.impressions,
      ctr: row.ctr,
      position: row.position,
    })
    queryMap.set(row.query, pages)
  }

  const results: CannibalizationResult[] = []

  for (const [query, pages] of queryMap) {
    if (pages.length < minPages)
      continue

    pages.sort((a, b) => b.clicks - a.clicks)

    const positions = pages.map(p => p.position)
    const positionSpread = Math.max(...positions) - Math.min(...positions)

    if (positionSpread > maxPositionSpread)
      continue

    results.push({
      query,
      pages,
      totalClicks: pages.reduce((sum, p) => sum + p.clicks, 0),
      totalImpressions: pages.reduce((sum, p) => sum + p.impressions, 0),
      positionSpread,
    })
  }

  return sortRowResults(results, sortBy, sortOrder)
}

export const cannibalizationAnalyzer = defineAnalyzer<AnalysisParams, Row, CannibalizationEvent[] | CannibalizationResult[]>({
  id: 'cannibalization',

  buildSql(params) {
    const { startDate, endDate } = periodOf(params)
    const minImpressions = params.minImpressions ?? 50
    const minCompetitors = 2
    const minQueryImpressions = (params.minImpressions ?? 50) * 2
    const limit = params.limit ?? 200

    const sql = `
      WITH agg AS (
        SELECT
          query,
          url,
          ${METRIC_EXPR.clicks} AS clicks,
          ${METRIC_EXPR.impressions} AS impressions,
          ${METRIC_EXPR.ctr} AS ctr,
          ${METRIC_EXPR.position} AS position
        FROM read_parquet({{FILES}}, union_by_name = true)
        WHERE date >= ? AND date <= ?
          AND query IS NOT NULL AND query <> ''
          AND url IS NOT NULL AND url <> ''
        GROUP BY query, url
        HAVING SUM(impressions) >= ?
      ),
      query_totals AS (
        SELECT
          query,
          SUM(impressions) AS total_impressions,
          SUM(clicks) AS total_clicks,
          COUNT(*) AS competitor_count
        FROM agg
        GROUP BY query
        HAVING COUNT(*) >= ? AND SUM(impressions) >= ?
      ),
      ranked AS (
        SELECT
          a.query,
          a.url,
          a.clicks,
          a.impressions,
          a.ctr,
          a.position,
          a.impressions / NULLIF(t.total_impressions, 0) AS share,
          ROW_NUMBER() OVER (
            PARTITION BY a.query
            ORDER BY a.impressions DESC, a.clicks DESC, a.url ASC
          ) AS rnk
        FROM agg a
        JOIN query_totals t USING (query)
      ),
      leader AS (
        SELECT query, url AS leader_url, ctr AS leader_ctr, position AS leader_position
        FROM ranked WHERE rnk = 1
      ),
      events AS (
        SELECT
          r.query,
          any_value(l.leader_url) AS leader_url,
          any_value(l.leader_ctr) AS leader_ctr,
          any_value(l.leader_position) AS leader_position,
          SUM(POWER(r.share * 100.0, 2)) AS hhi,
          SUM(CASE
            WHEN r.rnk > 1 AND l.leader_ctr > r.ctr
              THEN (l.leader_ctr - r.ctr) * r.impressions
            ELSE 0.0
          END) AS stolen_clicks,
          to_json(list({
            'url': r.url,
            'clicks': r.clicks,
            'impressions': r.impressions,
            'ctr': r.ctr,
            'position': r.position,
            'share': r.share,
            'rank': r.rnk
          } ORDER BY r.rnk)) AS competitors
        FROM ranked r
        JOIN leader l USING (query)
        GROUP BY r.query
      )
      SELECT
        e.query AS keyword,
        t.total_impressions AS totalImpressions,
        t.total_clicks AS totalClicks,
        t.competitor_count AS competitorCount,
        e.leader_url AS leaderUrl,
        e.leader_ctr AS leaderCtr,
        e.leader_position AS leaderPosition,
        e.hhi AS hhi,
        GREATEST(0.0, 1.0 - e.hhi / 10000.0) AS fragmentation,
        e.stolen_clicks AS stolenClicks,
        e.competitors AS competitors,
        CAST(ROUND(LEAST(100.0,
          100.0 * POWER(
            GREATEST(1.0 - e.hhi / 10000.0, 0.0)
              * LEAST(e.stolen_clicks / GREATEST(t.total_clicks + e.stolen_clicks, 1.0), 1.0)
              * LEAST(LOG10(GREATEST(t.total_impressions, 10.0)) / 5.0, 1.0),
            1.0 / 3.0
          )
        )) AS DOUBLE) AS severity
      FROM events e
      JOIN query_totals t USING (query)
      ORDER BY severity DESC, stolenClicks DESC
      LIMIT ${Number(limit)}
    `

    return {
      sql,
      params: [startDate, endDate, minImpressions, minCompetitors, minQueryImpressions],
      current: { table: 'page_keywords', partitions: enumeratePartitions(startDate, endDate) },
    }
  },

  reduceSql(rows) {
    const arr = Array.isArray(rows) ? rows : []
    const events: CannibalizationEvent[] = arr.map(r => ({
      keyword: str(r.keyword),
      totalImpressions: num(r.totalImpressions),
      totalClicks: num(r.totalClicks),
      competitorCount: num(r.competitorCount),
      leaderUrl: str(r.leaderUrl),
      leaderCtr: num(r.leaderCtr),
      leaderPosition: num(r.leaderPosition),
      hhi: num(r.hhi),
      fragmentation: num(r.fragmentation),
      stolenClicks: num(r.stolenClicks),
      severity: num(r.severity),
      competitors: parseJsonList(r.competitors).map(c => ({
        url: str(c.url),
        clicks: num(c.clicks),
        impressions: num(c.impressions),
        ctr: num(c.ctr),
        position: num(c.position),
        share: num(c.share),
        rank: num(c.rank),
      })),
    }))

    const nodeAgg = new Map<string, { impressions: number, clicks: number, queries: Set<string> }>()
    const edgeAgg = new Map<string, { source: string, target: string, weight: number, queries: number }>()

    for (const ev of events) {
      for (const c of ev.competitors) {
        const n = nodeAgg.get(c.url) ?? { impressions: 0, clicks: 0, queries: new Set<string>() }
        n.impressions += c.impressions
        n.clicks += c.clicks
        n.queries.add(ev.keyword)
        nodeAgg.set(c.url, n)
      }
      for (let i = 0; i < ev.competitors.length; i++) {
        for (let j = i + 1; j < ev.competitors.length; j++) {
          const a = ev.competitors[i]!
          const b = ev.competitors[j]!
          const [src, tgt] = a.url < b.url ? [a.url, b.url] : [b.url, a.url]
          const key = `${src}${tgt}`
          const weight = Math.min(a.impressions, b.impressions)
          const edge = edgeAgg.get(key) ?? { source: src, target: tgt, weight: 0, queries: 0 }
          edge.weight += weight
          edge.queries += 1
          edgeAgg.set(key, edge)
        }
      }
    }

    const nodes = [...nodeAgg.entries()].map(([url, n]) => ({
      url,
      impressions: n.impressions,
      clicks: n.clicks,
      queryCount: n.queries.size,
    }))
    const edges = [...edgeAgg.values()]

    const avgFragmentation = events.length > 0
      ? events.reduce((s, e) => s + e.fragmentation, 0) / events.length
      : 0
    const totalStolenClicks = events.reduce((s, e) => s + e.stolenClicks, 0)

    return {
      results: events,
      meta: {
        total: events.length,
        totalStolenClicks,
        avgFragmentation,
        graph: { nodes, edges },
      },
    }
  },

  buildRows(params) {
    return {
      rows: keywordsQueryState(periodOf(params), params.limit),
    }
  },

  reduceRows(rows, params) {
    const arr = (Array.isArray(rows) ? rows : []) as unknown as QueryPageRow[]
    const results = analyzeCannibalization(arr, {
      minImpressions: params.minImpressions,
      maxPositionSpread: params.maxPositionSpread,
      minPages: params.minPages,
    })
    return { results, meta: { total: results.length } }
  },
})

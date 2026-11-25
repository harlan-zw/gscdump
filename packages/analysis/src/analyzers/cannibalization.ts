/**
 * `cannibalization` — surfaces queries where multiple URLs compete for the
 * same SERP. SQL path computes Herfindahl-Hirschman index (HHI) on impressions
 * across URLs, fragmentation, stolen-clicks, and a 0..100 severity score, plus
 * a competitor graph (nodes/edges). Row path is the legacy reducer that flags
 * queries with a small position spread across many pages — different
 * semantics, kept for parity with the existing live-GSC behavior.
 */

import type { AnalysisParams } from '@gscdump/engine/analysis-types'
import type { Row } from '@gscdump/engine/contracts'
import type { QueryPageRow, SortOrder } from '../types'
import { fetchBudgetOf, num } from '@gscdump/engine/analysis-types'
import { defineAnalyzer } from '@gscdump/engine/analyzer'
import { periodOf } from '@gscdump/engine/period'
import { enumeratePartitions } from '@gscdump/engine/planner'
import { METRIC_EXPR } from '@gscdump/engine/sql-fragments'
import { queriesQueryState } from '../analyzer/adapt-rows'
import { paginateInMemory, TOTAL_COUNT_SELECT, totalCountOf } from '../analyzer/paginate'
import { parseJsonRows as parseJsonList, rowString as str } from '../analyzer/row-values'
import { normalizeQuery } from '../query/normalize'
import { createSorter } from '../types'

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
  /** Fold near-duplicate query variants via `normalizeQuery()` before detecting overlap. Default: false */
  canonical?: boolean
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
  canonicalKey?: string
  variants?: string[]
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
  canonicalKey?: string
  variants?: string[]
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
    canonical = false,
  } = options

  if (canonical) {
    const groups = new Map<string, {
      pages: Map<string, { clicks: number, impressions: number, weightedPos: number, posSum: number, count: number }>
      variants: Map<string, number>
    }>()

    for (const row of rows) {
      const ck = normalizeQuery(row.query) || row.query
      let g = groups.get(ck)
      if (!g) {
        g = { pages: new Map(), variants: new Map() }
        groups.set(ck, g)
      }
      g.variants.set(row.query, (g.variants.get(row.query) ?? 0) + row.impressions)
      const p = g.pages.get(row.page) ?? { clicks: 0, impressions: 0, weightedPos: 0, posSum: 0, count: 0 }
      p.clicks += row.clicks
      p.impressions += row.impressions
      p.weightedPos += (row.position - 1) * row.impressions
      p.posSum += row.position
      p.count += 1
      g.pages.set(row.page, p)
    }

    const results: CannibalizationResult[] = []
    for (const [canonicalKey, g] of groups) {
      const pages: CannibalizationPage[] = []
      for (const [page, p] of g.pages) {
        if (p.impressions < minImpressions)
          continue
        pages.push({
          page,
          clicks: p.clicks,
          impressions: p.impressions,
          ctr: p.impressions > 0 ? p.clicks / p.impressions : 0,
          position: p.impressions > 0 ? p.weightedPos / p.impressions + 1 : p.posSum / p.count,
        })
      }
      if (pages.length < minPages)
        continue

      let minPosition = Number.POSITIVE_INFINITY
      let maxPosition = Number.NEGATIVE_INFINITY
      let totalClicks = 0
      let totalImpressions = 0
      for (const page of pages) {
        minPosition = Math.min(minPosition, page.position)
        maxPosition = Math.max(maxPosition, page.position)
        totalClicks += page.clicks
        totalImpressions += page.impressions
      }
      const positionSpread = maxPosition - minPosition
      if (positionSpread > maxPositionSpread)
        continue

      pages.sort((a, b) => b.clicks - a.clicks || b.impressions - a.impressions || a.page.localeCompare(b.page))
      const variants = [...g.variants.entries()]
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .map(([q]) => q)
      results.push({
        query: variants[0] ?? canonicalKey,
        canonicalKey,
        variants,
        pages,
        totalClicks,
        totalImpressions,
        positionSpread,
      })
    }

    return sortRowResults(results, sortBy, sortOrder)
  }

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

    let minPosition = Number.POSITIVE_INFINITY
    let maxPosition = Number.NEGATIVE_INFINITY
    let totalClicks = 0
    let totalImpressions = 0
    for (const page of pages) {
      minPosition = Math.min(minPosition, page.position)
      maxPosition = Math.max(maxPosition, page.position)
      totalClicks += page.clicks
      totalImpressions += page.impressions
    }
    const positionSpread = maxPosition - minPosition

    if (positionSpread > maxPositionSpread)
      continue

    pages.sort((a, b) => b.clicks - a.clicks)
    results.push({
      query,
      pages,
      totalClicks,
      totalImpressions,
      positionSpread,
    })
  }

  return sortRowResults(results, sortBy, sortOrder)
}

interface CompetitorGraph {
  nodes: Array<{ url: string, impressions: number, clicks: number, queryCount: number }>
  edges: Array<{ source: string, target: string, weight: number, queries: number }>
}

function buildCompetitorGraph(events: CannibalizationEvent[]): CompetitorGraph {
  const nodeAgg = new Map<string, { impressions: number, clicks: number, queries: Set<string> }>()
  const edgeAgg = new Map<string, { source: string, target: string, weight: number, queries: number }>()

  for (const ev of events) {
    for (const c of ev.competitors) {
      const n = nodeAgg.get(c.url) ?? { impressions: 0, clicks: 0, queries: new Set<string>() }
      n.impressions += c.impressions
      n.clicks += c.clicks
      n.queries.add(ev.canonicalKey ?? ev.keyword)
      nodeAgg.set(c.url, n)
    }
    for (let i = 0; i < ev.competitors.length; i++) {
      for (let j = i + 1; j < ev.competitors.length; j++) {
        const a = ev.competitors[i]!
        const b = ev.competitors[j]!
        const [src, tgt] = a.url < b.url ? [a.url, b.url] : [b.url, a.url]
        const key = `${src}\x01${tgt}`
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
  return { nodes, edges }
}

function reduceCanonicalCannibalization(
  rows: Row[],
  options: { minImpressions: number, minQueryImpressions: number, limit: number },
): { results: CannibalizationEvent[], meta: Record<string, unknown> } {
  const { minImpressions, minQueryImpressions, limit } = options
  const groups = new Map<string, {
    urls: Map<string, { clicks: number, impressions: number, weightedPos: number, posSum: number, count: number }>
    variants: Map<string, number>
  }>()

  for (const r of rows) {
    const query = str(r.query)
    const url = str(r.url)
    if (!query || !url)
      continue
    const impressions = num(r.impressions)
    const clicks = num(r.clicks)
    const position = num(r.position)
    const ck = normalizeQuery(query) || query
    let g = groups.get(ck)
    if (!g) {
      g = { urls: new Map(), variants: new Map() }
      groups.set(ck, g)
    }
    g.variants.set(query, (g.variants.get(query) ?? 0) + impressions)
    const u = g.urls.get(url) ?? { clicks: 0, impressions: 0, weightedPos: 0, posSum: 0, count: 0 }
    u.clicks += clicks
    u.impressions += impressions
    u.weightedPos += (position - 1) * impressions
    u.posSum += position
    u.count += 1
    g.urls.set(url, u)
  }

  const allEvents: CannibalizationEvent[] = []
  for (const [canonicalKey, g] of groups) {
    const qualifying: Array<{ url: string, clicks: number, impressions: number, ctr: number, position: number }> = []
    let totalImpressions = 0
    let totalClicks = 0
    for (const [url, u] of g.urls) {
      if (u.impressions < minImpressions)
        continue
      totalImpressions += u.impressions
      totalClicks += u.clicks
      qualifying.push({
        url,
        clicks: u.clicks,
        impressions: u.impressions,
        ctr: u.impressions > 0 ? u.clicks / u.impressions : 0,
        position: u.impressions > 0 ? u.weightedPos / u.impressions + 1 : u.posSum / u.count,
      })
    }
    if (qualifying.length < 2 || totalImpressions < minQueryImpressions)
      continue

    qualifying.sort((a, b) => b.impressions - a.impressions || b.clicks - a.clicks || (a.url < b.url ? -1 : a.url > b.url ? 1 : 0))
    const leader = qualifying[0]!
    let hhi = 0
    let stolenClicks = 0
    const competitors: CannibalizationCompetitor[] = qualifying.map((u, idx) => {
      const share = totalImpressions > 0 ? u.impressions / totalImpressions : 0
      hhi += (share * 100) ** 2
      if (idx > 0 && leader.ctr > u.ctr)
        stolenClicks += (leader.ctr - u.ctr) * u.impressions
      return { ...u, share, rank: idx + 1 }
    })

    const fragmentation = Math.max(0, 1 - hhi / 10_000)
    const severity = Math.round(Math.min(
      100,
      100 * (
        fragmentation
        * Math.min(stolenClicks / Math.max(totalClicks + stolenClicks, 1), 1)
        * Math.min(Math.log10(Math.max(totalImpressions, 10)) / 5, 1)
      ) ** (1 / 3),
    ))
    const variants = [...g.variants.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([q]) => q)

    allEvents.push({
      keyword: variants[0] ?? canonicalKey,
      canonicalKey,
      variants,
      totalImpressions,
      totalClicks,
      competitorCount: competitors.length,
      leaderUrl: leader.url,
      leaderCtr: leader.ctr,
      leaderPosition: leader.position,
      hhi,
      fragmentation,
      stolenClicks,
      severity,
      competitors,
    })
  }

  allEvents.sort((a, b) => b.severity - a.severity || b.stolenClicks - a.stolenClicks || b.totalImpressions - a.totalImpressions)
  const totalStolenClicks = allEvents.reduce((s, e) => s + e.stolenClicks, 0)
  const avgFragmentation = allEvents.length > 0
    ? allEvents.reduce((s, e) => s + e.fragmentation, 0) / allEvents.length
    : 0
  const events = allEvents.slice(0, limit)
  return {
    results: events,
    meta: {
      total: allEvents.length,
      returned: events.length,
      totalStolenClicks,
      avgFragmentation,
      graph: buildCompetitorGraph(events),
    },
  }
}

export const cannibalizationAnalyzer = defineAnalyzer<AnalysisParams, Row, CannibalizationEvent[] | CannibalizationResult[]>({
  id: 'cannibalization',

  buildSql(params) {
    const { startDate, endDate } = periodOf(params)
    const minImpressions = params.minImpressions ?? 10
    const minCompetitors = 2
    const minQueryImpressions = minImpressions * 2
    const limit = params.limit ?? 200

    if (params.canonical) {
      const sql = `
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
        HAVING SUM(impressions) >= 1
      `
      return {
        sql,
        params: [startDate, endDate],
        current: { table: 'page_queries', partitions: enumeratePartitions(startDate, endDate) },
      }
    }

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
        )) AS DOUBLE) AS severity,
        SUM(e.stolen_clicks) OVER () AS allStolenClicks,
        AVG(GREATEST(0.0, 1.0 - e.hhi / 10000.0)) OVER () AS allFragmentation,
        ${TOTAL_COUNT_SELECT}
      FROM events e
      JOIN query_totals t USING (query)
      ORDER BY severity DESC, stolenClicks DESC
      LIMIT ${Number(limit)}
    `

    return {
      sql,
      params: [startDate, endDate, minImpressions, minCompetitors, minQueryImpressions],
      current: { table: 'page_queries', partitions: enumeratePartitions(startDate, endDate) },
    }
  },

  reduceSql(rows, params) {
    const arr = Array.isArray(rows) ? rows : []
    if (params.canonical) {
      const minImpressions = params.minImpressions ?? 10
      return reduceCanonicalCannibalization(arr, {
        minImpressions,
        minQueryImpressions: minImpressions * 2,
        limit: params.limit ?? 200,
      })
    }
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

    // Window aggregates run before LIMIT, so these cover every event, not the page.
    const avgFragmentation = arr[0] ? num(arr[0].allFragmentation) : 0
    const totalStolenClicks = arr[0] ? num(arr[0].allStolenClicks) : 0

    return {
      results: events,
      meta: {
        total: totalCountOf(arr),
        returned: events.length,
        totalStolenClicks,
        avgFragmentation,
        graph: { nodes, edges },
      },
    }
  },

  buildRows(params) {
    return {
      rows: queriesQueryState(periodOf(params), fetchBudgetOf(params)),
    }
  },

  reduceRows(rows, params) {
    const arr = (Array.isArray(rows) ? rows : []) as unknown as QueryPageRow[]
    const results = analyzeCannibalization(arr, {
      minImpressions: params.minImpressions,
      maxPositionSpread: params.maxPositionSpread,
      minPages: params.minPages,
      canonical: params.canonical,
    })
    const paged = paginateInMemory(results, { limit: params.limit, offset: params.offset })
    return { results: paged, meta: { total: results.length, returned: paged.length } }
  },
})

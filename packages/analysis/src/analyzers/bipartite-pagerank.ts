/**
 * bipartite-pagerank
 *
 * Personalized PageRank on the (query <-> url) graph, weighted by impressions.
 * SQL aggregates and caps the graph. The reducer computes its 25 iterations.
 *
 * "Hub queries" bridge many URLs with roughly-even mass distribution;
 * "hub URLs" anchor many queries the same way. Rank is eigenvector
 * centrality: a node is important if it links to other important nodes.
 */

import type { AnalysisParams } from '@gscdump/engine/analysis-types'
import type { Row } from '@gscdump/engine/contracts'
import { num } from '@gscdump/engine/analysis-types'
import { defineAnalyzer } from '@gscdump/engine/analyzer'
import { periodOf } from '@gscdump/engine/period'
import { enumeratePartitions } from '@gscdump/engine/planner'
import { rowString as str } from '../analyzer/row-values'

const BIPARTITE_PAGERANK_ITERATIONS = 25
const BIPARTITE_PAGERANK_DAMPING = 0.85

export interface BipartitePagerankNode {
  kind: 'query' | 'url'
  id: string
  rank: number
  bridging: number
  anchoring: number
  degree: number
  impressions: number
}

export type BipartitePagerankResult = BipartitePagerankNode

export const bipartitePagerankAnalyzer = defineAnalyzer<AnalysisParams, Row, BipartitePagerankResult[]>({
  id: 'bipartite-pagerank',

  buildSql(params) {
    const { startDate, endDate } = periodOf(params)
    const minImpressions = params.minImpressions ?? 50
    const topQueries = 1000
    const topUrls = 500
    const limit = params.limit ?? 50
    const sql = `
    WITH edges0 AS (
      SELECT
        query AS qid,
        url   AS uid,
        CAST(SUM(impressions) AS DOUBLE) AS impressions
      FROM read_parquet({{FILES}}, union_by_name = true)
      WHERE date >= ? AND date <= ?
        AND query IS NOT NULL AND query <> ''
        AND url   IS NOT NULL AND url   <> ''
      GROUP BY query, url
      HAVING SUM(impressions) >= ?
    ),
    -- Top-N caps per side keep the iteration tractable.
    query_totals AS (
      SELECT qid, SUM(impressions) AS tot
      FROM edges0 GROUP BY qid
    ),
    url_totals AS (
      SELECT uid, SUM(impressions) AS tot
      FROM edges0 GROUP BY uid
    ),
    top_queries AS (
      SELECT qid FROM query_totals
      ORDER BY tot DESC, qid ASC LIMIT ${Number(topQueries)}
    ),
    top_urls AS (
      SELECT uid FROM url_totals
      ORDER BY tot DESC, uid ASC LIMIT ${Number(topUrls)}
    ),
    edges AS (
      SELECT e.qid, e.uid, e.impressions
      FROM edges0 e
      JOIN top_queries tq USING (qid)
      JOIN top_urls    tu USING (uid)
    ),
    query_nodes AS (
      SELECT qid, ROW_NUMBER() OVER (ORDER BY qid) - 1 AS idx
      FROM (SELECT DISTINCT qid FROM edges)
    ),
    url_nodes AS (
      SELECT uid, ROW_NUMBER() OVER (ORDER BY uid) - 1 AS idx
      FROM (SELECT DISTINCT uid FROM edges)
    )
    SELECT
      (SELECT to_json(list(qid ORDER BY idx)) FROM query_nodes) AS queriesJson,
      (SELECT to_json(list(uid ORDER BY idx)) FROM url_nodes) AS urlsJson,
      (SELECT to_json(list([q.idx, u.idx, e.impressions]))
       FROM edges e
       JOIN query_nodes q USING (qid)
       JOIN url_nodes u USING (uid)) AS edgesJson,
      CAST(${Number(limit)} AS BIGINT) AS resultLimit
    LIMIT ${Number(limit)}
  `

    return {
      sql,
      params: [startDate, endDate, minImpressions],
      current: { table: 'page_queries', partitions: enumeratePartitions(startDate, endDate) },
    }
  },

  reduceSql(rows) {
    const first = (Array.isArray(rows) ? rows[0] : undefined) ?? {}
    const queries = JSON.parse(str(first.queriesJson) || '[]') as string[] | null
    const urls = JSON.parse(str(first.urlsJson) || '[]') as string[] | null
    const edges = JSON.parse(str(first.edgesJson) || '[]') as [number, number, number][] | null
    const iterations = BIPARTITE_PAGERANK_ITERATIONS
    const damping = BIPARTITE_PAGERANK_DAMPING
    if (!queries?.length || !urls?.length || !edges?.length) {
      return {
        results: [],
        meta: { total: 0, convergenceDelta: 0, iterations, damping, queryCount: 0, urlCount: 0, deltas: [] },
      }
    }

    const queryCount = queries.length
    const urlCount = urls.length
    const queryTotals = new Float64Array(queryCount)
    const urlTotals = new Float64Array(urlCount)
    const queryDegrees = new Uint32Array(queryCount)
    const urlDegrees = new Uint32Array(urlCount)
    for (const [q, u, impressions] of edges) {
      queryTotals[q]! += impressions
      urlTotals[u]! += impressions
      queryDegrees[q]!++
      urlDegrees[u]!++
    }

    const qToU = new Float64Array(edges.length)
    const uToQ = new Float64Array(edges.length)
    const bridging = new Uint32Array(queryCount)
    const anchoring = new Uint32Array(urlCount)
    for (let i = 0; i < edges.length; i++) {
      const [q, u, impressions] = edges[i]!
      // NaN represents SQL NULL when an outgoing total is zero.
      qToU[i] = queryTotals[q] === 0 ? Number.NaN : impressions / queryTotals[q]!
      uToQ[i] = urlTotals[u] === 0 ? Number.NaN : impressions / urlTotals[u]!
      if (qToU[i]! >= 0.05)
        bridging[q]!++
      if (uToQ[i]! >= 0.05)
        anchoring[u]!++
    }

    let queryRanks = new Float64Array(queryCount).fill(1 / queryCount)
    let urlRanks = new Float64Array(urlCount).fill(1 / urlCount)
    let nextQueries = new Float64Array(queryCount)
    let nextUrls = new Float64Array(urlCount)
    const deltas: { step: number, l1: number }[] = []
    for (let step = 1; step <= iterations; step++) {
      nextQueries.fill(Number.NaN)
      nextUrls.fill(Number.NaN)
      for (let i = 0; i < edges.length; i++) {
        const [q, u] = edges[i]!
        const toQuery = uToQ[i]! * urlRanks[u]!
        const toUrl = qToU[i]! * queryRanks[q]!
        // SQL SUM ignores NULL terms and returns NULL if every term is NULL.
        if (!Number.isNaN(toQuery))
          nextQueries[q] = (Number.isNaN(nextQueries[q]) ? 0 : nextQueries[q]!) + toQuery
        if (!Number.isNaN(toUrl))
          nextUrls[u] = (Number.isNaN(nextUrls[u]) ? 0 : nextUrls[u]!) + toUrl
      }
      let l1 = 0
      for (let q = 0; q < queryCount; q++) {
        nextQueries[q] = (1 - damping) / queryCount + damping * nextQueries[q]!
        const delta = Math.abs(nextQueries[q]! - queryRanks[q]!)
        if (!Number.isNaN(delta))
          l1 += delta
      }
      for (let u = 0; u < urlCount; u++) {
        nextUrls[u] = (1 - damping) / urlCount + damping * nextUrls[u]!
        const delta = Math.abs(nextUrls[u]! - urlRanks[u]!)
        if (!Number.isNaN(delta))
          l1 += delta
      }
      deltas.push({ step, l1 })
      ;[queryRanks, nextQueries] = [nextQueries, queryRanks]
      ;[urlRanks, nextUrls] = [nextUrls, urlRanks]
    }

    const limit = num(first.resultLimit)
    const byRank = (a: BipartitePagerankNode, b: BipartitePagerankNode): number =>
      Number.isNaN(a.rank) ? (Number.isNaN(b.rank) ? 0 : 1) : Number.isNaN(b.rank) ? -1 : b.rank - a.rank
    const queryNodes = queries.map((id, i): BipartitePagerankNode => ({
      kind: 'query',
      id,
      rank: queryRanks[i]!,
      bridging: bridging[i]!,
      anchoring: 0,
      degree: queryDegrees[i]!,
      impressions: queryTotals[i]!,
    })).sort(byRank).slice(0, limit)
    const urlNodes = urls.map((id, i): BipartitePagerankNode => ({
      kind: 'url',
      id,
      rank: urlRanks[i]!,
      bridging: 0,
      anchoring: anchoring[i]!,
      degree: urlDegrees[i]!,
      impressions: urlTotals[i]!,
    })).sort(byRank).slice(0, limit)
    const results = [...queryNodes, ...urlNodes].map(node => ({ ...node, rank: Number.isNaN(node.rank) ? 0 : node.rank }))
    return {
      results,
      meta: {
        total: results.length,
        convergenceDelta: deltas[iterations - 1]!.l1,
        iterations,
        damping,
        queryCount,
        urlCount,
        deltas,
      },
    }
  },
})

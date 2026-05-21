/**
 * bipartite-pagerank
 *
 * Personalized PageRank on the (query <-> url) bipartite graph, edge-weighted
 * by impressions. Each power-iteration "step" is two half-steps: queries
 * receive mass from URLs, then URLs receive mass from queries. We express
 * the fixed-N iteration as a chain of CTEs built programmatically (bounded
 * unroll). This sidesteps DuckDB's recursive-CTE restriction on aggregate
 * functions over the recursive reference; the natural formulation needs
 * SUM(prev.rank * weight) GROUP BY node_id, which recursive CTEs reject.
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

const BIPARTITE_PAGERANK_ITERATIONS = 25
const BIPARTITE_PAGERANK_DAMPING = 0.85

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
    const bridgingEdgeThreshold = 0.05
    const anchoringEdgeThreshold = 0.05
    const iterations = BIPARTITE_PAGERANK_ITERATIONS
    const d = BIPARTITE_PAGERANK_DAMPING

    // Build the iterated-rank CTE chain. Each step reads `ranks_{i-1}` and
    // writes `ranks_{i}` via joins against the normalized edge tables. We
    // keep every iteration so we can emit L1 delta per step for the
    // convergence sparkline, then select the final step for the payload.
    const iterCtes: string[] = []
    for (let i = 1; i <= iterations; i++) {
      iterCtes.push(`
    ranks_${i} AS (
      SELECT
        'q' AS kind,
        e.qid AS id,
        (1.0 - ${d}) / (SELECT n FROM query_count)
          + ${d} * SUM(e.w_u_to_q * r.rank) AS rank
      FROM u_to_q_weights e
      JOIN ranks_${i - 1} r ON r.kind = 'u' AND r.id = e.uid
      GROUP BY e.qid
      UNION ALL
      SELECT
        'u' AS kind,
        e.uid AS id,
        (1.0 - ${d}) / (SELECT n FROM url_count)
          + ${d} * SUM(e.w_q_to_u * r.rank) AS rank
      FROM q_to_u_weights e
      JOIN ranks_${i - 1} r ON r.kind = 'q' AND r.id = e.qid
      GROUP BY e.uid
    )`)
    }

    // L1 delta across successive iterations — exposed as convergence meta.
    const deltaParts: string[] = []
    for (let i = 1; i <= iterations; i++) {
      deltaParts.push(`
      SELECT ${i} AS step,
        (SELECT COALESCE(SUM(ABS(a.rank - b.rank)), 0.0)
         FROM ranks_${i} a
         JOIN ranks_${i - 1} b USING (kind, id)) AS l1`)
    }

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
    query_nodes AS (SELECT DISTINCT qid FROM edges),
    url_nodes   AS (SELECT DISTINCT uid FROM edges),
    query_count AS (SELECT GREATEST(COUNT(*), 1) AS n FROM query_nodes),
    url_count   AS (SELECT GREATEST(COUNT(*), 1) AS n FROM url_nodes),
    -- Row-stochastic transition weights in each direction. For q->u the
    -- weights out of a query sum to 1; symmetric for u->q.
    q_out AS (SELECT qid, SUM(impressions) AS s FROM edges GROUP BY qid),
    u_out AS (SELECT uid, SUM(impressions) AS s FROM edges GROUP BY uid),
    q_to_u_weights AS (
      SELECT e.qid, e.uid,
        e.impressions / NULLIF(q.s, 0) AS w_q_to_u
      FROM edges e JOIN q_out q USING (qid)
    ),
    u_to_q_weights AS (
      SELECT e.qid, e.uid,
        e.impressions / NULLIF(u.s, 0) AS w_u_to_q
      FROM edges e JOIN u_out u USING (uid)
    ),
    -- Seed: uniform distribution per side. Total mass = 2 (one unit per side).
    ranks_0 AS (
      SELECT 'q' AS kind, q.qid AS id, 1.0 / (SELECT n FROM query_count) AS rank
      FROM query_nodes q
      UNION ALL
      SELECT 'u' AS kind, u.uid AS id, 1.0 / (SELECT n FROM url_count) AS rank
      FROM url_nodes u
    ),
    ${iterCtes.join(',\n')},
    final_ranks AS (SELECT * FROM ranks_${iterations}),
    -- Hub/anchor diagnostics computed from raw edge mass (not rank). A
    -- query "bridges" URLs it sends >= ${bridgingEdgeThreshold} of its mass
    -- to; a URL "anchors" queries that contribute >= ${anchoringEdgeThreshold}
    -- of its incoming mass.
    q_bridging AS (
      SELECT qid, COUNT(*) AS bridging
      FROM q_to_u_weights
      WHERE w_q_to_u >= ${bridgingEdgeThreshold}
      GROUP BY qid
    ),
    u_anchoring AS (
      SELECT uid, COUNT(*) AS anchoring
      FROM u_to_q_weights
      WHERE w_u_to_q >= ${anchoringEdgeThreshold}
      GROUP BY uid
    ),
    q_degree AS (
      SELECT qid, COUNT(*) AS degree, SUM(impressions) AS impressions
      FROM edges GROUP BY qid
    ),
    u_degree AS (
      SELECT uid, COUNT(*) AS degree, SUM(impressions) AS impressions
      FROM edges GROUP BY uid
    ),
    deltas AS (
      ${deltaParts.join('\n      UNION ALL\n')}
    ),
    query_rows AS (
      SELECT
        'query' AS kind, f.id, f.rank,
        COALESCE(b.bridging, 0)      AS bridging,
        0                             AS anchoring,
        COALESCE(qd.degree, 0)       AS degree,
        COALESCE(qd.impressions, 0)  AS impressions
      FROM final_ranks f
      LEFT JOIN q_bridging b ON b.qid = f.id
      LEFT JOIN q_degree   qd ON qd.qid = f.id
      WHERE f.kind = 'q'
      ORDER BY f.rank DESC
      LIMIT ${Number(limit)}
    ),
    url_rows AS (
      SELECT
        'url' AS kind, f.id, f.rank,
        0                             AS bridging,
        COALESCE(a.anchoring, 0)     AS anchoring,
        COALESCE(ud.degree, 0)       AS degree,
        COALESCE(ud.impressions, 0)  AS impressions
      FROM final_ranks f
      LEFT JOIN u_anchoring a ON a.uid = f.id
      LEFT JOIN u_degree   ud ON ud.uid = f.id
      WHERE f.kind = 'u'
      ORDER BY f.rank DESC
      LIMIT ${Number(limit)}
    ),
    nodes AS (
      SELECT * FROM query_rows
      UNION ALL
      SELECT * FROM url_rows
    ),
    counts AS (
      SELECT
        (SELECT n FROM query_count) AS q_count,
        (SELECT n FROM url_count)   AS u_count
    ),
    deltas_json AS (
      SELECT to_json(list({ 'step': step, 'l1': l1 } ORDER BY step)) AS dj
      FROM deltas
    )
    SELECT
      n.kind,
      n.id,
      n.rank,
      n.bridging,
      n.anchoring,
      n.degree,
      n.impressions,
      c.q_count AS queryCount,
      c.u_count AS urlCount,
      dj.dj     AS deltasJson
    FROM nodes n
    CROSS JOIN counts c
    CROSS JOIN deltas_json dj
    ORDER BY n.kind, n.rank DESC
  `

    return {
      sql,
      params: [startDate, endDate, minImpressions],
      current: { table: 'page_queries', partitions: enumeratePartitions(startDate, endDate) },
    }
  },

  reduceSql(rows) {
    const arr = Array.isArray(rows) ? rows : []
    const iterations = BIPARTITE_PAGERANK_ITERATIONS
    const d = BIPARTITE_PAGERANK_DAMPING
    const results: BipartitePagerankResult[] = arr.map(r => ({
      kind: str(r.kind) as 'query' | 'url',
      id: str(r.id),
      rank: num(r.rank),
      bridging: num(r.bridging),
      anchoring: num(r.anchoring),
      degree: num(r.degree),
      impressions: num(r.impressions),
    }))
    const first = (arr[0] ?? {}) as Record<string, unknown>
    const queryCount = num(first.queryCount)
    const urlCount = num(first.urlCount)
    const deltas = parseJsonList(first.deltasJson).map(e => ({
      step: num(e.step),
      l1: num(e.l1),
    }))
    const convergenceDelta = deltas.length > 0 ? deltas[deltas.length - 1]!.l1 : 0
    return {
      results,
      meta: {
        total: results.length,
        convergenceDelta,
        iterations,
        damping: d,
        queryCount,
        urlCount,
        deltas,
      },
    }
  },
})

/**
 * cannibalization
 *
 * Self-join on `page_keywords` grouped by `query` to surface queries where
 * multiple URLs compete for the same SERP. Computes:
 *   - Herfindahl-Hirschman index (HHI) on impressions across URLs
 *     (10000 = monopoly, low = fragmented → cannibalized)
 *   - fragmentation = 1 - HHI/10000
 *   - stolen_clicks = Σ (leaderCtr - urlCtr) * urlImpressions for non-leaders
 *     (clicks the leader "should have" captured if it had absorbed the
 *     impressions diluted across siblings, clamped at 0)
 *   - severity: geometric mean of (fragmentation, stolen-click-share,
 *     impression-volume) scaled to 0..100 — optimized for demo ranking.
 *
 * The competitors array is emitted as JSON so the frontend can render a
 * force-directed graph / sankey without a second query.
 */

import type { AnalysisParams, AnalyzerSpec } from '../shared'

import { enumeratePartitions } from '@gscdump/engine/planner'
import { num, parseJsonList, period, str } from '../shared'

export function buildCannibalization(params: AnalysisParams): AnalyzerSpec {
  const { startDate, endDate } = period(params)
  const minImpressions = params.minImpressions ?? 50
  const minCompetitors = 2
  const minQueryImpressions = (params.minImpressions ?? 50) * 2
  const limit = params.limit ?? 200

  const sql = `
    WITH agg AS (
      SELECT
        query,
        url,
        CAST(SUM(clicks) AS DOUBLE) AS clicks,
        CAST(SUM(impressions) AS DOUBLE) AS impressions,
        CAST(SUM(clicks) AS DOUBLE) / NULLIF(SUM(impressions), 0) AS ctr,
        SUM(sum_position) / NULLIF(SUM(impressions), 0) + 1 AS position
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
    shape: (rows) => {
      const events = rows.map(r => ({
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
            const key = `${src}\u0001${tgt}`
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
  }
}

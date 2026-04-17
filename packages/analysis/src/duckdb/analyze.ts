// DuckDB-native analyzers. Collocated with the DuckDB adapter so each tool can
// exploit DuckDB-specific features (regexp_extract, list_slice, STDDEV_POP,
// struct_pack, ...) without forcing other backends to match. All aggregation,
// scoring, and ranking pushed into SQL; the shape functions only re-pack the
// result rows into the driver's AnalysisResult envelope.

import type { Row, StorageEngine, TableName, TenantCtx } from 'gscdump/analytics/contracts'
import type { AnalysisParams, AnalysisResult } from '../types'
import { enumeratePartitions } from 'gscdump/analytics/planner'
import { extractDateRange } from 'gscdump/query'
import { browserResolverAdapter } from '../browser/resolver-adapter'
import { padTimeseries } from '../pad-timeseries'
import {
  buildExtrasQueries as buildExtrasQueriesUpstream,
  buildTotalsSql as buildTotalsSqlUpstream,
  mergeExtras,
  resolveComparisonSQL as resolveComparisonSQLUpstream,
  resolveToSQLOptimized as resolveToSQLOptimizedUpstream,
  resolveToSQL as resolveToSQLUpstream,
} from '../query'

export class AnalyzerUnsupportedError extends Error {
  constructor(tool: string) {
    super(`analyzer "${tool}" is not supported by the DuckDB backend`)
    this.name = 'AnalyzerUnsupportedError'
  }
}

export interface DuckDBAnalyzeDeps {
  engine: StorageEngine
}

export interface FileSet {
  table: TableName
  partitions: string[]
}

export interface ExtraQuerySpec {
  /** Key that the shape function uses to look up the result rows. */
  name: string
  sql: string
  params: unknown[]
}

export interface AnalyzerSpec {
  sql: string
  params: unknown[]
  current: FileSet
  previous?: FileSet
  /**
   * Additional named fileSets for analyzers that read from multiple tables in
   * a single SQL statement (e.g. dark-traffic joins `pages`, `keywords`, and
   * `page_keywords`). Keys become placeholders: `FILES_<KEY>` in SQL.
   * Browser rewrite resolves them to `<schema>.<table>`.
   */
  extraFiles?: Record<string, FileSet>
  /**
   * Additional SQL statements run after the primary. Result rows are keyed by
   * `name` and passed to `shape` via the `extras` argument. Used for
   * data-query / data-detail where count + totals + canonical-extras come
   * from separate queries.
   */
  extraQueries?: ExtraQuerySpec[]
  /**
   * `browserOnly` analyzers skip `analyzeWithDuckDB` (server/manifest path).
   * They emit SQL with direct table references instead of `{{FILES}}` tokens;
   * only the browser runner has the tables attached as views.
   */
  browserOnly?: boolean
  shape: (
    rows: Row[],
    params: AnalysisParams,
    extras?: Record<string, Row[]>,
  ) => { results: Row[], meta: Record<string, unknown> }
}

export function buildAnalyzerSpec(params: AnalysisParams): AnalyzerSpec {
  return buildSpec(params)
}

export async function analyzeWithDuckDB(
  deps: DuckDBAnalyzeDeps,
  ctx: TenantCtx,
  params: AnalysisParams,
): Promise<AnalysisResult> {
  const spec = buildSpec(params)
  if (spec.browserOnly)
    throw new AnalyzerUnsupportedError(params.type)

  const fileSets: Record<string, FileSet> = { FILES: spec.current }
  if (spec.previous)
    fileSets.FILES_PREV = spec.previous
  if (spec.extraFiles) {
    for (const [key, fs] of Object.entries(spec.extraFiles))
      fileSets[`FILES_${key}`] = fs
  }

  const { rows } = await deps.engine.runSQL({
    ctx,
    table: spec.current.table,
    fileSets,
    sql: spec.sql,
    params: spec.params,
  })

  const extrasRows: Record<string, Row[]> = {}
  if (spec.extraQueries) {
    for (const q of spec.extraQueries) {
      const { rows: extraRows } = await deps.engine.runSQL({
        ctx,
        table: spec.current.table,
        fileSets,
        sql: q.sql,
        params: q.params,
      })
      extrasRows[q.name] = extraRows
    }
  }

  const { results, meta } = spec.shape(rows, params, extrasRows)
  return {
    results: results as unknown as Record<string, unknown>[],
    meta: { tool: params.type, source: 'local', ...meta },
  }
}

function buildSpec(params: AnalysisParams): AnalyzerSpec {
  switch (params.type) {
    case 'striking-distance':
      return buildStrikingDistance(params)
    case 'opportunity':
      return buildOpportunity(params)
    case 'brand':
      return buildBrand(params)
    case 'cannibalization':
      return buildCannibalization(params)
    case 'ctr-anomaly':
      return buildCtrAnomaly(params)
    case 'bayesian-ctr':
      return buildBayesianCtr(params)
    case 'position-volatility':
      return buildPositionVolatility(params)
    case 'long-tail':
      return buildLongTail(params)
    case 'intent-atlas':
      return buildIntentAtlas(params)
    case 'query-migration':
      return buildQueryMigration(params)
    case 'clustering':
      return buildClustering(params)
    case 'concentration':
      return buildConcentration(params)
    case 'seasonality':
      return buildSeasonality(params)
    case 'movers':
      return buildMovers(params)
    case 'decay':
      return buildDecay(params)
    case 'trends':
      return buildTrends(params)
    case 'zero-click':
      return buildZeroClick(params)
    case 'position-distribution':
      return buildPositionDistribution(params)
    case 'ctr-curve':
      return buildCtrCurve(params)
    case 'dark-traffic':
      return buildDarkTraffic(params)
    case 'content-velocity':
      return buildContentVelocity(params)
    case 'keyword-breadth':
      return buildKeywordBreadth(params)
    case 'device-gap':
      return buildDeviceGap(params)
    case 'data-query':
      return buildDataQuery(params)
    case 'data-detail':
      return buildDataDetail(params)
    case 'stl-decompose':
      return buildStlDecompose(params)
    case 'change-point':
      return buildChangePoint(params)
    case 'bipartite-pagerank':
      return buildBipartitePageRank(params)
    case 'survival':
      return buildSurvival(params)
    default:
      throw new AnalyzerUnsupportedError(params.type)
  }
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function DEFAULT_END(): string {
  return new Date(Date.now() - 3 * 86400000).toISOString().split('T')[0]
}

function DEFAULT_START(): string {
  return new Date(Date.now() - 31 * 86400000).toISOString().split('T')[0]
}

function period(params: AnalysisParams): { startDate: string, endDate: string } {
  return {
    startDate: params.startDate || DEFAULT_START(),
    endDate: params.endDate || DEFAULT_END(),
  }
}

function previous(params: AnalysisParams): { startDate: string, endDate: string } {
  if (!params.prevStartDate || !params.prevEndDate)
    throw new Error(`${params.type} analysis requires prevStartDate and prevEndDate`)
  return { startDate: params.prevStartDate, endDate: params.prevEndDate }
}

function num(v: unknown): number {
  if (typeof v === 'number')
    return v
  if (typeof v === 'bigint')
    return Number(v)
  if (v == null)
    return 0
  return Number(v)
}

function str(v: unknown): string {
  return v == null ? '' : String(v)
}

function bool(v: unknown): boolean {
  return v === true || v === 1 || v === 'true'
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

function escapeRegexAlt(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

// ---------------------------------------------------------------------------
// striking-distance
// ---------------------------------------------------------------------------

function buildStrikingDistance(params: AnalysisParams): AnalyzerSpec {
  const { startDate, endDate } = period(params)
  const minPosition = params.minPosition ?? 4
  const maxPosition = params.maxPosition ?? 20
  const minImpressions = params.minImpressions ?? 100
  const maxCtr = params.maxCtr ?? 0.05
  const limit = params.limit ?? 1000

  const sql = `
    WITH agg AS (
      SELECT
        query AS keyword,
        url AS page,
        CAST(SUM(clicks) AS DOUBLE) AS clicks,
        CAST(SUM(impressions) AS DOUBLE) AS impressions,
        CAST(SUM(clicks) AS DOUBLE) / NULLIF(SUM(impressions), 0) AS ctr,
        SUM(sum_position) / NULLIF(SUM(impressions), 0) + 1 AS position
      FROM read_parquet({{FILES}}, union_by_name = true)
      WHERE date >= ? AND date <= ?
      GROUP BY query, url
    )
    SELECT
      keyword, page, clicks, impressions, ctr, position,
      CAST(ROUND(impressions * 0.15) AS DOUBLE) AS potentialClicks
    FROM agg
    WHERE position BETWEEN ? AND ?
      AND impressions >= ?
      AND ctr <= ?
    ORDER BY potentialClicks DESC
    LIMIT ${Number(limit)}
  `

  return {
    sql,
    params: [startDate, endDate, minPosition, maxPosition, minImpressions, maxCtr],
    current: { table: 'page_keywords', partitions: enumeratePartitions(startDate, endDate) },
    shape: rows => ({
      results: rows.map(r => ({
        keyword: str(r.keyword),
        page: r.page == null ? null : str(r.page),
        clicks: num(r.clicks),
        impressions: num(r.impressions),
        ctr: num(r.ctr),
        position: num(r.position),
        potentialClicks: num(r.potentialClicks),
      })),
      meta: { total: rows.length },
    }),
  }
}

// ---------------------------------------------------------------------------
// opportunity
// ---------------------------------------------------------------------------

function buildOpportunity(params: AnalysisParams): AnalyzerSpec {
  const { startDate, endDate } = period(params)
  const minImpressions = params.minImpressions ?? 100
  const w1 = 1
  const w2 = 1
  const w3 = 1
  const totalW = w1 + w2 + w3
  const limit = params.limit ?? 1000

  const sql = `
    WITH agg AS (
      SELECT
        query AS keyword,
        url AS page,
        CAST(SUM(clicks) AS DOUBLE) AS clicks,
        CAST(SUM(impressions) AS DOUBLE) AS impressions,
        CAST(SUM(clicks) AS DOUBLE) / NULLIF(SUM(impressions), 0) AS ctr,
        SUM(sum_position) / NULLIF(SUM(impressions), 0) + 1 AS position
      FROM read_parquet({{FILES}}, union_by_name = true)
      WHERE date >= ? AND date <= ?
      GROUP BY query, url
      HAVING SUM(impressions) >= ?
    ),
    scored AS (
      SELECT
        keyword, page, clicks, impressions, ctr, position,
        CASE
          WHEN position <= 3 THEN 0.2
          WHEN position > 50 THEN 0.1
          ELSE GREATEST(0.0, 1.0 - ABS(position - 11.0) / 15.0)
        END AS positionScore,
        CASE WHEN impressions <= 0 THEN 0.0 ELSE LEAST(LOG10(impressions) / 5.0, 1.0) END AS impressionScore,
        CASE CAST(ROUND(GREATEST(LEAST(position, 10.0), 1.0)) AS INTEGER)
          WHEN 1 THEN 0.30
          WHEN 2 THEN 0.15
          WHEN 3 THEN 0.10
          WHEN 4 THEN 0.07
          WHEN 5 THEN 0.05
          WHEN 6 THEN 0.04
          WHEN 7 THEN 0.03
          WHEN 8 THEN 0.025
          WHEN 9 THEN 0.02
          WHEN 10 THEN 0.015
          ELSE 0.01
        END AS expectedCtr
      FROM agg
    ),
    gapped AS (
      SELECT
        *,
        CASE WHEN ctr >= expectedCtr THEN 0.0 ELSE LEAST((expectedCtr - ctr) / expectedCtr, 1.0) END AS ctrGapScore
      FROM scored
    )
    SELECT
      keyword, page, clicks, impressions, ctr, position,
      CAST(ROUND(POWER(
        POWER(positionScore, ${w1}) * POWER(impressionScore, ${w2}) * POWER(ctrGapScore, ${w3}),
        1.0 / ${totalW}
      ) * 100) AS DOUBLE) AS opportunityScore,
      CAST(ROUND(impressions * (
        CASE CAST(ROUND(GREATEST(LEAST(position, 3.0), 1.0)) AS INTEGER)
          WHEN 1 THEN 0.30
          WHEN 2 THEN 0.15
          WHEN 3 THEN 0.10
          ELSE 0.10
        END
      )) AS DOUBLE) AS potentialClicks,
      positionScore, impressionScore, ctrGapScore
    FROM gapped
    ORDER BY opportunityScore DESC
    LIMIT ${Number(limit)}
  `

  return {
    sql,
    params: [startDate, endDate, minImpressions],
    current: { table: 'page_keywords', partitions: enumeratePartitions(startDate, endDate) },
    shape: rows => ({
      results: rows.map(r => ({
        keyword: str(r.keyword),
        page: r.page == null ? null : str(r.page),
        clicks: num(r.clicks),
        impressions: num(r.impressions),
        ctr: num(r.ctr),
        position: num(r.position),
        opportunityScore: num(r.opportunityScore),
        potentialClicks: num(r.potentialClicks),
        factors: {
          positionScore: num(r.positionScore),
          impressionScore: num(r.impressionScore),
          ctrGapScore: num(r.ctrGapScore),
        },
      })),
      meta: { total: rows.length },
    }),
  }
}

// ---------------------------------------------------------------------------
// brand
// ---------------------------------------------------------------------------

function buildBrand(params: AnalysisParams): AnalyzerSpec {
  if (!params.brandTerms?.length)
    throw new Error('Brand analysis requires brandTerms')
  const { startDate, endDate } = period(params)
  const minImpressions = params.minImpressions ?? 10
  const limit = params.limit ?? 10000

  const regex = `(${params.brandTerms.map(t => escapeRegexAlt(t.toLowerCase())).join('|')})`

  const sql = `
    WITH agg AS (
      SELECT
        query,
        url AS page,
        CAST(SUM(clicks) AS DOUBLE) AS clicks,
        CAST(SUM(impressions) AS DOUBLE) AS impressions,
        CAST(SUM(clicks) AS DOUBLE) / NULLIF(SUM(impressions), 0) AS ctr,
        SUM(sum_position) / NULLIF(SUM(impressions), 0) + 1 AS position
      FROM read_parquet({{FILES}}, union_by_name = true)
      WHERE date >= ? AND date <= ?
      GROUP BY query, url
      HAVING SUM(impressions) >= ?
    )
    SELECT
      query, page, clicks, impressions, ctr, position,
      CASE WHEN regexp_matches(LOWER(query), ?) THEN 'brand' ELSE 'non-brand' END AS segment
    FROM agg
    ORDER BY clicks DESC
    LIMIT ${Number(limit)}
  `

  return {
    sql,
    params: [startDate, endDate, minImpressions, regex],
    current: { table: 'page_keywords', partitions: enumeratePartitions(startDate, endDate) },
    shape: (rows) => {
      const normalized = rows.map(r => ({
        query: str(r.query),
        page: r.page == null ? undefined : str(r.page),
        clicks: num(r.clicks),
        impressions: num(r.impressions),
        ctr: num(r.ctr),
        position: num(r.position),
        segment: str(r.segment) as 'brand' | 'non-brand',
      }))
      let brandClicks = 0
      let nonBrandClicks = 0
      let brandImpressions = 0
      let nonBrandImpressions = 0
      for (const r of normalized) {
        if (r.segment === 'brand') {
          brandClicks += r.clicks
          brandImpressions += r.impressions
        }
        else {
          nonBrandClicks += r.clicks
          nonBrandImpressions += r.impressions
        }
      }
      const totalClicks = brandClicks + nonBrandClicks
      return {
        results: normalized,
        meta: {
          total: normalized.length,
          summary: {
            brandClicks,
            nonBrandClicks,
            brandShare: totalClicks > 0 ? brandClicks / totalClicks : 0,
            brandImpressions,
            nonBrandImpressions,
          },
        },
      }
    },
  }
}

// ---------------------------------------------------------------------------
// cannibalization
//
// Self-join on `page_keywords` grouped by `query` to surface queries where
// multiple URLs compete for the same SERP. Computes:
//   - Herfindahl-Hirschman index (HHI) on impressions across URLs
//     (10000 = monopoly, low = fragmented → cannibalized)
//   - fragmentation = 1 - HHI/10000
//   - stolen_clicks = Σ (leaderCtr - urlCtr) * urlImpressions for non-leaders
//     (clicks the leader "should have" captured if it had absorbed the
//     impressions diluted across siblings, clamped at 0)
//   - severity: geometric mean of (fragmentation, stolen-click-share,
//     impression-volume) scaled to 0..100 — optimized for demo ranking.
//
// The competitors array is emitted as JSON so the frontend can render a
// force-directed graph / sankey without a second query.
// ---------------------------------------------------------------------------

function buildCannibalization(params: AnalysisParams): AnalyzerSpec {
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

      // Derive a force-graph-ready nodes/edges projection from the events.
      // Each URL is a node weighted by total contested impressions; each
      // pair of URLs competing on the same query is an edge weighted by
      // min(urlA.impr, urlB.impr) summed across shared queries.
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

// ---------------------------------------------------------------------------
// ctr-anomaly
//
// Rolling CTR envelope per (query, page): 28-day preceding AVG + STDDEV_POP
// via window functions. A "breach" is a day where the observed CTR falls
// outside ±z·σ while position stays flat — i.e. the page didn't drop, but
// clicks did. That's the signature of SERP feature theft (AI Overview,
// People-Also-Ask, featured-snippet reclaim), detected without ever calling
// a SERP-rendering API.
//
// clicksLost = Σ (rollingCtr − dayCtr) · impressions for downward breaches.
// Entities are ranked by clicksLost DESC; the daily series is returned as
// JSON so the frontend can draw a sparkline with breach markers.
// ---------------------------------------------------------------------------

function buildCtrAnomaly(params: AnalysisParams): AnalyzerSpec {
  // Default to 90 days so the rolling window has ≥14 warm-up days and still
  // leaves ~60 days for breach detection. The shared 28-day default is too
  // tight for a rolling-STDDEV analyzer.
  const endDate = params.endDate ?? DEFAULT_END()
  const startDate = params.startDate ?? new Date(Date.now() - 93 * 86400000).toISOString().split('T')[0]
  const minDailyImpressions = params.minImpressions ?? 5
  const minRollingN = 14
  const zThreshold = params.threshold ?? 2.0
  const maxPositionDelta = 1.5
  const minBreachDays = 2
  const limit = params.limit ?? 200

  const sql = `
    WITH daily AS (
      SELECT
        query,
        url AS page,
        date,
        CAST(SUM(clicks) AS DOUBLE) AS day_clicks,
        CAST(SUM(impressions) AS DOUBLE) AS day_impressions,
        CAST(SUM(clicks) AS DOUBLE) / NULLIF(SUM(impressions), 0) AS day_ctr,
        SUM(sum_position) / NULLIF(SUM(impressions), 0) + 1 AS day_position
      FROM read_parquet({{FILES}}, union_by_name = true)
      WHERE date >= ? AND date <= ?
        AND query IS NOT NULL AND query <> ''
        AND url IS NOT NULL AND url <> ''
      GROUP BY query, url, date
      HAVING SUM(impressions) >= ?
    ),
    rolled AS (
      SELECT *,
        AVG(day_ctr)           OVER w AS rolling_ctr,
        STDDEV_POP(day_ctr)    OVER w AS rolling_stddev,
        AVG(day_position)      OVER w AS rolling_position,
        COUNT(*)               OVER w AS rolling_n
      FROM daily
      WINDOW w AS (
        PARTITION BY query, page
        ORDER BY date
        ROWS BETWEEN 28 PRECEDING AND 1 PRECEDING
      )
    ),
    flagged AS (
      SELECT *,
        CASE
          WHEN rolling_n >= ${Number(minRollingN)} AND rolling_stddev > 0
            THEN (day_ctr - rolling_ctr) / rolling_stddev
          ELSE 0.0
        END AS z_score,
        CASE
          WHEN rolling_position IS NULL THEN 0.0
          ELSE ABS(day_position - rolling_position)
        END AS position_delta
      FROM rolled
    ),
    breaches AS (
      SELECT *,
        CASE
          WHEN ABS(z_score) >= ${zThreshold}
            AND position_delta <= ${maxPositionDelta}
            AND rolling_n >= ${Number(minRollingN)}
          THEN true ELSE false
        END AS is_breach
      FROM flagged
    ),
    per_entity AS (
      SELECT
        query, page,
        COUNT(*) FILTER (WHERE is_breach AND z_score < 0) AS breach_days_down,
        COUNT(*) FILTER (WHERE is_breach AND z_score > 0) AS breach_days_up,
        SUM(CASE
          WHEN is_breach AND z_score < 0
            THEN (rolling_ctr - day_ctr) * day_impressions
          ELSE 0.0
        END) AS clicks_lost,
        SUM(CASE
          WHEN is_breach AND z_score < 0
            THEN ABS(z_score) * day_impressions
          ELSE 0.0
        END) AS severity_raw,
        MAX(CASE WHEN is_breach THEN ABS(z_score) ELSE 0.0 END) AS max_z,
        AVG(rolling_ctr) FILTER (WHERE rolling_n >= ${Number(minRollingN)}) AS baseline_ctr,
        AVG(rolling_position) FILTER (WHERE rolling_n >= ${Number(minRollingN)}) AS baseline_position,
        SUM(day_impressions) AS total_impressions,
        SUM(day_clicks) AS total_clicks
      FROM breaches
      GROUP BY query, page
      HAVING COUNT(*) FILTER (WHERE is_breach AND z_score < 0) >= ${Number(minBreachDays)}
    ),
    series AS (
      SELECT query, page,
        to_json(list({
          'date': strftime(date, '%Y-%m-%d'),
          'ctr': day_ctr,
          'position': day_position,
          'impressions': day_impressions,
          'rollingCtr': rolling_ctr,
          'rollingStddev': rolling_stddev,
          'z': z_score,
          'breach': is_breach AND z_score < 0
        } ORDER BY date)) AS seriesJson
      FROM breaches
      GROUP BY query, page
    )
    SELECT
      e.query AS keyword,
      e.page,
      CAST(e.breach_days_down AS DOUBLE) AS breachDaysDown,
      CAST(e.breach_days_up AS DOUBLE) AS breachDaysUp,
      CAST(ROUND(e.clicks_lost) AS DOUBLE) AS clicksLost,
      e.severity_raw AS severityRaw,
      e.max_z AS maxZ,
      e.baseline_ctr AS baselineCtr,
      e.baseline_position AS baselinePosition,
      e.total_impressions AS totalImpressions,
      e.total_clicks AS totalClicks,
      s.seriesJson
    FROM per_entity e
    LEFT JOIN series s USING (query, page)
    ORDER BY clicksLost DESC
    LIMIT ${Number(limit)}
  `

  return {
    sql,
    params: [startDate, endDate, minDailyImpressions],
    current: { table: 'page_keywords', partitions: enumeratePartitions(startDate, endDate) },
    shape: (rows) => {
      const anomalies = rows.map(r => ({
        keyword: str(r.keyword),
        page: str(r.page),
        breachDaysDown: num(r.breachDaysDown),
        breachDaysUp: num(r.breachDaysUp),
        clicksLost: num(r.clicksLost),
        severity: num(r.severityRaw),
        maxZ: num(r.maxZ),
        baselineCtr: num(r.baselineCtr),
        baselinePosition: num(r.baselinePosition),
        totalImpressions: num(r.totalImpressions),
        totalClicks: num(r.totalClicks),
        series: parseJsonList(r.seriesJson).map(s => ({
          date: str(s.date),
          ctr: num(s.ctr),
          position: num(s.position),
          impressions: num(s.impressions),
          rollingCtr: s.rollingCtr == null ? null : num(s.rollingCtr),
          rollingStddev: s.rollingStddev == null ? null : num(s.rollingStddev),
          z: num(s.z),
          breach: bool(s.breach),
        })),
      }))
      const totalClicksLost = anomalies.reduce((s, a) => s + a.clicksLost, 0)
      const totalBreachDays = anomalies.reduce((s, a) => s + a.breachDaysDown, 0)
      return {
        results: anomalies,
        meta: {
          total: anomalies.length,
          totalClicksLost,
          totalBreachDays,
          zThreshold,
          minRollingN,
        },
      }
    },
  }
}

// ---------------------------------------------------------------------------
// bayesian-ctr
//
// Empirical-Bayes CTR shrinkage. For each position bucket (1..30) we fit a
// Beta(α, β) prior from the impression-weighted mean/variance of per-entity
// CTR via method-of-moments, then combine with each entity's observed clicks
// and impressions to produce a posterior mean + 95% normal-approx CI. Entities
// whose observed CTR lies outside their CI are flagged overperforming or
// underperforming; the rest are "expected". Ranked by posterior-SD-normalized
// significance so small samples don't dominate.
// ---------------------------------------------------------------------------

function buildBayesianCtr(params: AnalysisParams): AnalyzerSpec {
  const { startDate, endDate } = period(params)
  const minImpressions = params.minImpressions ?? 50
  const limit = params.limit ?? 300
  const priorMinEntities = 5

  const sql = `
    WITH entity AS (
      SELECT
        query,
        url,
        CAST(SUM(clicks) AS DOUBLE) AS clicks,
        CAST(SUM(impressions) AS DOUBLE) AS impressions,
        CAST(SUM(clicks) AS DOUBLE) / NULLIF(SUM(impressions), 0) AS observed_ctr,
        SUM(sum_position) / NULLIF(SUM(impressions), 0) + 1 AS position,
        CAST(ROUND(LEAST(SUM(sum_position) / NULLIF(SUM(impressions), 0) + 1, 30)) AS INTEGER) AS bucket
      FROM read_parquet({{FILES}}, union_by_name = true)
      WHERE date >= ? AND date <= ?
        AND query IS NOT NULL AND query <> ''
        AND url IS NOT NULL AND url <> ''
      GROUP BY query, url
      HAVING SUM(impressions) >= ?
        AND SUM(sum_position) / NULLIF(SUM(impressions), 0) + 1 <= 30
    ),
    bucket_mu AS (
      SELECT
        bucket,
        COUNT(*) AS n_entities,
        SUM(observed_ctr * impressions) / NULLIF(SUM(impressions), 0) AS mu,
        SUM(impressions) AS total_impressions
      FROM entity
      GROUP BY bucket
    ),
    bucket_var AS (
      SELECT
        e.bucket,
        GREATEST(
          SUM(e.impressions * POWER(e.observed_ctr - b.mu, 2))
            / NULLIF(SUM(e.impressions), 0),
          1e-9
        ) AS v
      FROM entity e
      JOIN bucket_mu b USING (bucket)
      GROUP BY e.bucket
    ),
    priors AS (
      SELECT
        m.bucket,
        m.n_entities,
        m.mu,
        v.v,
        CASE
          WHEN m.n_entities >= ${Number(priorMinEntities)}
            AND v.v > 0
            AND m.mu > 0 AND m.mu < 1
            AND (m.mu * (1.0 - m.mu) / v.v - 1.0) > 0
          THEN GREATEST(0.5, m.mu * (m.mu * (1.0 - m.mu) / v.v - 1.0))
          ELSE 2.0
        END AS alpha,
        CASE
          WHEN m.n_entities >= ${Number(priorMinEntities)}
            AND v.v > 0
            AND m.mu > 0 AND m.mu < 1
            AND (m.mu * (1.0 - m.mu) / v.v - 1.0) > 0
          THEN GREATEST(0.5, (1.0 - m.mu) * (m.mu * (1.0 - m.mu) / v.v - 1.0))
          ELSE 48.0
        END AS beta
      FROM bucket_mu m
      JOIN bucket_var v USING (bucket)
    ),
    posterior AS (
      SELECT
        e.query,
        e.url,
        e.clicks,
        e.impressions,
        e.observed_ctr,
        e.position,
        e.bucket,
        p.alpha AS prior_alpha,
        p.beta AS prior_beta,
        p.mu AS bucket_prior_mean,
        p.alpha + e.clicks AS alpha_post,
        p.beta + (e.impressions - e.clicks) AS beta_post
      FROM entity e
      JOIN priors p USING (bucket)
    ),
    scored AS (
      SELECT *,
        alpha_post / (alpha_post + beta_post) AS posterior_mean,
        SQRT((alpha_post * beta_post)
          / (POWER(alpha_post + beta_post, 2) * (alpha_post + beta_post + 1))) AS posterior_sd
      FROM posterior
    )
    SELECT
      query AS keyword,
      url AS page,
      clicks,
      impressions,
      observed_ctr AS observedCtr,
      position,
      bucket,
      prior_alpha AS priorAlpha,
      prior_beta AS priorBeta,
      bucket_prior_mean AS bucketPriorMean,
      posterior_mean AS posteriorMean,
      posterior_sd AS posteriorSd,
      GREATEST(0.0, posterior_mean - 1.96 * posterior_sd) AS ciLow,
      LEAST(1.0, posterior_mean + 1.96 * posterior_sd) AS ciHigh,
      posterior_mean - observed_ctr AS shrinkageDelta,
      (posterior_mean - observed_ctr) * impressions AS expectedClicksDelta,
      ABS(observed_ctr - posterior_mean) / NULLIF(posterior_sd, 0) AS significance,
      CASE
        WHEN observed_ctr > LEAST(1.0, posterior_mean + 1.96 * posterior_sd) THEN 'overperforming'
        WHEN observed_ctr < GREATEST(0.0, posterior_mean - 1.96 * posterior_sd) THEN 'underperforming'
        ELSE 'expected'
      END AS classification
    FROM scored
    ORDER BY significance DESC NULLS LAST
    LIMIT ${Number(limit)}
  `

  return {
    sql,
    params: [startDate, endDate, minImpressions],
    current: { table: 'page_keywords', partitions: enumeratePartitions(startDate, endDate) },
    shape: (rows) => {
      const results = rows.map(r => ({
        keyword: str(r.keyword),
        page: str(r.page),
        clicks: num(r.clicks),
        impressions: num(r.impressions),
        observedCtr: num(r.observedCtr),
        position: num(r.position),
        bucket: num(r.bucket),
        priorAlpha: num(r.priorAlpha),
        priorBeta: num(r.priorBeta),
        bucketPriorMean: num(r.bucketPriorMean),
        posteriorMean: num(r.posteriorMean),
        posteriorSd: num(r.posteriorSd),
        ciLow: num(r.ciLow),
        ciHigh: num(r.ciHigh),
        shrinkageDelta: num(r.shrinkageDelta),
        expectedClicksDelta: num(r.expectedClicksDelta),
        significance: num(r.significance),
        classification: str(r.classification) as 'overperforming' | 'underperforming' | 'expected',
      }))
      const under = results.filter(r => r.classification === 'underperforming').length
      const over = results.filter(r => r.classification === 'overperforming').length
      return {
        results,
        meta: {
          total: results.length,
          underperforming: under,
          overperforming: over,
          expected: results.length - under - over,
          minImpressions,
        },
      }
    },
  }
}

// ---------------------------------------------------------------------------
// position-volatility
//
// Per (page, day) compute query-level position STDDEV_POP plus day-over-day
// shift in weighted avg position via LAG. The resulting "volatility score"
// (σ + |Δpos|) surfaces pages whose SERP positioning is genuinely noisy,
// not just pages that rank well. Output is a pages × dates matrix for a
// calendar-style heatmap.
// ---------------------------------------------------------------------------

function buildPositionVolatility(params: AnalysisParams): AnalyzerSpec {
  const { startDate, endDate } = period(params)
  const topN = params.topN ?? 30
  const minDayImpressions = params.minImpressions ?? 10
  const minDays = params.minWeeksWithData ?? 7

  const sql = `
    WITH query_day AS (
      SELECT
        url AS page,
        query,
        date,
        CAST(SUM(impressions) AS DOUBLE) AS q_impressions,
        SUM(sum_position) / NULLIF(SUM(impressions), 0) + 1 AS q_position
      FROM read_parquet({{FILES}}, union_by_name = true)
      WHERE date >= ? AND date <= ?
        AND query IS NOT NULL AND query <> ''
        AND url IS NOT NULL AND url <> ''
      GROUP BY url, query, date
      HAVING SUM(impressions) >= 1
    ),
    daily AS (
      SELECT
        page, date,
        COUNT(*) AS query_count,
        SUM(q_impressions) AS day_impressions,
        SUM(q_position * q_impressions) / NULLIF(SUM(q_impressions), 0) AS avg_position,
        COALESCE(STDDEV_POP(q_position), 0.0) AS pos_stddev,
        MIN(q_position) AS best_position,
        MAX(q_position) AS worst_position
      FROM query_day
      GROUP BY page, date
      HAVING SUM(q_impressions) >= ?
    ),
    with_shift AS (
      SELECT *,
        LAG(avg_position) OVER (PARTITION BY page ORDER BY date) AS prev_position,
        COALESCE(
          ABS(avg_position - LAG(avg_position) OVER (PARTITION BY page ORDER BY date)),
          0.0
        ) AS dod_shift
      FROM daily
    ),
    scored AS (
      SELECT *,
        pos_stddev + dod_shift AS volatility
      FROM with_shift
    ),
    top_pages AS (
      SELECT page,
        SUM(day_impressions) AS total_impressions,
        AVG(volatility) AS avg_volatility,
        MAX(volatility) AS peak_volatility,
        COUNT(*) AS days_with_data
      FROM scored
      GROUP BY page
      HAVING COUNT(*) >= ?
      ORDER BY avg_volatility DESC
      LIMIT ${Number(topN)}
    )
    SELECT
      s.page,
      strftime(s.date, '%Y-%m-%d') AS date,
      s.query_count AS queryCount,
      s.day_impressions AS dayImpressions,
      s.avg_position AS avgPosition,
      s.pos_stddev AS posStddev,
      s.best_position AS bestPosition,
      s.worst_position AS worstPosition,
      s.dod_shift AS dodShift,
      s.volatility AS volatility,
      t.avg_volatility AS pageAvgVolatility,
      t.peak_volatility AS pagePeakVolatility,
      t.total_impressions AS pageTotalImpressions
    FROM scored s
    JOIN top_pages t USING (page)
    ORDER BY t.avg_volatility DESC, s.date ASC
  `

  return {
    sql,
    params: [startDate, endDate, minDayImpressions, minDays],
    current: { table: 'page_keywords', partitions: enumeratePartitions(startDate, endDate) },
    shape: (rows) => {
      // Group rows into one entity per page with a dense per-day series.
      const byPage = new Map<string, {
        page: string
        avgVolatility: number
        peakVolatility: number
        totalImpressions: number
        days: Array<{
          date: string
          queryCount: number
          dayImpressions: number
          avgPosition: number
          posStddev: number
          bestPosition: number
          worstPosition: number
          dodShift: number
          volatility: number
        }>
      }>()

      const allDates = new Set<string>()
      for (const r of rows) {
        const page = str(r.page)
        const date = str(r.date)
        allDates.add(date)
        const entry = byPage.get(page) ?? {
          page,
          avgVolatility: num(r.pageAvgVolatility),
          peakVolatility: num(r.pagePeakVolatility),
          totalImpressions: num(r.pageTotalImpressions),
          days: [],
        }
        entry.days.push({
          date,
          queryCount: num(r.queryCount),
          dayImpressions: num(r.dayImpressions),
          avgPosition: num(r.avgPosition),
          posStddev: num(r.posStddev),
          bestPosition: num(r.bestPosition),
          worstPosition: num(r.worstPosition),
          dodShift: num(r.dodShift),
          volatility: num(r.volatility),
        })
        byPage.set(page, entry)
      }

      const pages = [...byPage.values()].sort((a, b) => b.avgVolatility - a.avgVolatility)
      const dates = [...allDates].sort()
      const maxVolatility = pages.reduce((m, p) => Math.max(m, p.peakVolatility), 0)

      return {
        results: pages,
        meta: {
          total: pages.length,
          dates,
          maxVolatility,
        },
      }
    },
  }
}

// ---------------------------------------------------------------------------
// long-tail
//
// Per-page power-law fit on log(rank) vs log(impressions) via DuckDB's
// REGR_SLOPE / REGR_INTERCEPT / REGR_R2 regression aggregates. A flat slope
// (close to 0, e.g. > -0.6) means impressions are spread across many queries
// — that's topic authority. A steep slope (< -1.2) means one or two head
// terms and a thin body — single-keyword dependency risk.
//
// The shape function returns both the per-page fit and a down-sampled log-
// log scatter per page so the frontend can render the distribution.
// ---------------------------------------------------------------------------

function buildLongTail(params: AnalysisParams): AnalyzerSpec {
  const { startDate, endDate } = period(params)
  const minQueries = 10
  const minQueryImpressions = params.minImpressions ?? 5
  const limit = params.limit ?? 100

  const sql = `
    WITH page_queries AS (
      SELECT
        url AS page,
        query,
        CAST(SUM(impressions) AS DOUBLE) AS impressions,
        CAST(SUM(clicks) AS DOUBLE) AS clicks
      FROM read_parquet({{FILES}}, union_by_name = true)
      WHERE date >= ? AND date <= ?
        AND query IS NOT NULL AND query <> ''
        AND url IS NOT NULL AND url <> ''
      GROUP BY url, query
      HAVING SUM(impressions) >= ?
    ),
    ranked AS (
      SELECT
        page, query, impressions, clicks,
        ROW_NUMBER() OVER (PARTITION BY page ORDER BY impressions DESC, query ASC) AS rnk
      FROM page_queries
    ),
    log_space AS (
      SELECT *,
        LN(rnk) AS log_rank,
        LN(impressions) AS log_impr
      FROM ranked
    ),
    fit AS (
      SELECT
        page,
        COUNT(*) AS query_count,
        SUM(impressions) AS total_impressions,
        SUM(clicks) AS total_clicks,
        REGR_SLOPE(log_impr, log_rank) AS slope,
        REGR_INTERCEPT(log_impr, log_rank) AS intercept,
        REGR_R2(log_impr, log_rank) AS r2,
        MAX(impressions) AS head_impressions,
        -- Impressions captured by the top query (head concentration).
        MAX(CASE WHEN rnk = 1 THEN impressions END) / NULLIF(SUM(impressions), 0) AS head_share
      FROM log_space
      GROUP BY page
      HAVING COUNT(*) >= ${Number(minQueries)}
    ),
    scatter AS (
      SELECT
        l.page,
        to_json(list({
          'rank': l.rnk,
          'impressions': l.impressions,
          'clicks': l.clicks,
          'query': l.query
        } ORDER BY l.rnk)) AS pointsJson
      FROM log_space l
      JOIN fit f USING (page)
      GROUP BY l.page
    )
    SELECT
      f.page,
      f.query_count AS queryCount,
      f.total_impressions AS totalImpressions,
      f.total_clicks AS totalClicks,
      f.slope AS slope,
      f.intercept AS intercept,
      f.r2 AS r2,
      f.head_impressions AS headImpressions,
      f.head_share AS headShare,
      s.pointsJson AS pointsJson,
      CASE
        WHEN f.slope > -0.6 THEN 'flat-tail'
        WHEN f.slope > -1.2 THEN 'balanced'
        ELSE 'head-heavy'
      END AS fingerprint
    FROM fit f
    LEFT JOIN scatter s USING (page)
    ORDER BY f.total_impressions DESC
    LIMIT ${Number(limit)}
  `

  return {
    sql,
    params: [startDate, endDate, minQueryImpressions],
    current: { table: 'page_keywords', partitions: enumeratePartitions(startDate, endDate) },
    shape: (rows) => {
      const results = rows.map(r => ({
        page: str(r.page),
        queryCount: num(r.queryCount),
        totalImpressions: num(r.totalImpressions),
        totalClicks: num(r.totalClicks),
        slope: num(r.slope),
        intercept: num(r.intercept),
        r2: num(r.r2),
        headImpressions: num(r.headImpressions),
        headShare: num(r.headShare),
        fingerprint: str(r.fingerprint) as 'flat-tail' | 'balanced' | 'head-heavy',
        // Down-sample the scatter to <=80 points (log-spaced) to keep payload
        // tight; the fingerprint is visible at this resolution.
        points: downsampleLogRank(parseJsonList(r.pointsJson)),
      }))
      const counts = { 'flat-tail': 0, 'balanced': 0, 'head-heavy': 0 }
      for (const r of results) counts[r.fingerprint]++
      return {
        results,
        meta: {
          total: results.length,
          fingerprints: counts,
          avgSlope: results.length > 0 ? results.reduce((s, r) => s + r.slope, 0) / results.length : 0,
        },
      }
    },
  }
}

function downsampleLogRank(points: Row[]): Array<{ rank: number, impressions: number, clicks: number, query: string }> {
  const all = points.map(p => ({
    rank: num(p.rank),
    impressions: num(p.impressions),
    clicks: num(p.clicks),
    query: str(p.query),
  }))
  if (all.length <= 80)
    return all
  // Keep every point where rank crosses a log-step boundary, plus top 10 by impressions.
  const top = all.slice(0, 10)
  const rest = all.slice(10)
  const stepped: typeof all = []
  let nextThreshold = 1.15
  for (const p of rest) {
    if (p.rank >= nextThreshold) {
      stepped.push(p)
      nextThreshold *= 1.15
    }
  }
  return [...top, ...stepped]
}

// ---------------------------------------------------------------------------
// intent-atlas
//
// Token-cooccurrence clustering. Tokenizes queries via regexp_split_to_array
// + unnest, drops stop-words and short tokens, weights tokens by impressions,
// then clusters each query by its top-2 highest-impression tokens (sorted +
// joined as the cluster key). Two queries with no shared prefix end up in
// the same cluster as long as they share their two most meaningful tokens —
// "best vue components" + "components for vue beginners" both cluster on
// "components + vue".
// ---------------------------------------------------------------------------

const INTENT_ATLAS_STOP_WORDS = [
  'the',
  'a',
  'an',
  'is',
  'are',
  'was',
  'were',
  'be',
  'been',
  'of',
  'to',
  'in',
  'for',
  'on',
  'and',
  'or',
  'with',
  'at',
  'by',
  'from',
  'into',
  'about',
  'as',
  'so',
  'than',
  'then',
  'that',
  'this',
  'my',
  'your',
  'our',
  'their',
  'his',
  'her',
  'its',
  'me',
  'you',
  'what',
  'how',
  'why',
  'when',
  'where',
  'who',
  'which',
  'do',
  'does',
]

function buildIntentAtlas(params: AnalysisParams): AnalyzerSpec {
  const endDate = params.endDate ?? DEFAULT_END()
  const startDate = params.startDate ?? new Date(Date.now() - 90 * 86400000).toISOString().split('T')[0]
  const minQueryImpressions = params.minImpressions ?? 20
  const minClusterSize = params.minClusterSize ?? 3
  const minTokenImpressions = 50
  const limit = params.limit ?? 200

  const stopList = INTENT_ATLAS_STOP_WORDS.map(w => `'${w}'`).join(', ')

  const sql = `
    WITH queries AS (
      SELECT
        query,
        CAST(SUM(impressions) AS DOUBLE) AS impressions,
        CAST(SUM(clicks) AS DOUBLE) AS clicks,
        SUM(sum_position) / NULLIF(SUM(impressions), 0) + 1 AS position
      FROM read_parquet({{FILES}}, union_by_name = true)
      WHERE date >= ? AND date <= ?
        AND query IS NOT NULL AND query <> ''
      GROUP BY query
      HAVING SUM(impressions) >= ?
    ),
    tokens AS (
      SELECT q.query, q.impressions, q.clicks, q.position,
        LOWER(t.token) AS token
      FROM queries q,
        unnest(regexp_split_to_array(LOWER(q.query), '\\s+')) AS t(token)
      WHERE LENGTH(t.token) >= 3
        AND LOWER(t.token) NOT IN (${stopList})
    ),
    token_weights AS (
      SELECT token,
        SUM(impressions) AS token_impressions,
        COUNT(DISTINCT query) AS query_count
      FROM tokens
      GROUP BY token
      HAVING SUM(impressions) >= ${Number(minTokenImpressions)}
    ),
    ranked_tokens AS (
      SELECT t.query, t.token, tw.token_impressions,
        ROW_NUMBER() OVER (
          PARTITION BY t.query
          ORDER BY tw.token_impressions DESC, t.token ASC
        ) AS rnk
      FROM tokens t
      JOIN token_weights tw USING (token)
    ),
    cluster_keys AS (
      SELECT query,
        array_to_string(list(token ORDER BY token), ' + ') AS cluster_key
      FROM ranked_tokens
      WHERE rnk <= 2
      GROUP BY query
      HAVING COUNT(*) >= 2
    ),
    clustered AS (
      SELECT q.query, q.impressions, q.clicks, q.position, ck.cluster_key
      FROM queries q
      JOIN cluster_keys ck USING (query)
    )
    SELECT
      cluster_key AS clusterKey,
      COUNT(*) AS keywordCount,
      SUM(impressions) AS totalImpressions,
      SUM(clicks) AS totalClicks,
      SUM(clicks) / NULLIF(SUM(impressions), 0) AS ctr,
      AVG(position) AS avgPosition,
      to_json(list({
        'query': query,
        'impressions': impressions,
        'clicks': clicks,
        'position': position
      } ORDER BY impressions DESC)) AS keywords
    FROM clustered
    GROUP BY cluster_key
    HAVING COUNT(*) >= ${Number(minClusterSize)}
    ORDER BY totalImpressions DESC
    LIMIT ${Number(limit)}
  `

  return {
    sql,
    params: [startDate, endDate, minQueryImpressions],
    current: { table: 'keywords', partitions: enumeratePartitions(startDate, endDate) },
    shape: (rows) => {
      const clusters = rows.map(r => ({
        clusterKey: str(r.clusterKey),
        keywordCount: num(r.keywordCount),
        totalImpressions: num(r.totalImpressions),
        totalClicks: num(r.totalClicks),
        ctr: num(r.ctr),
        avgPosition: num(r.avgPosition),
        keywords: parseJsonList(r.keywords).slice(0, 25).map(k => ({
          query: str(k.query),
          impressions: num(k.impressions),
          clicks: num(k.clicks),
          position: num(k.position),
        })),
      }))
      const totalImpressions = clusters.reduce((s, c) => s + c.totalImpressions, 0)
      const totalKeywords = clusters.reduce((s, c) => s + c.keywordCount, 0)
      return {
        results: clusters,
        meta: { total: clusters.length, totalImpressions, totalKeywords },
      }
    },
  }
}

// ---------------------------------------------------------------------------
// query-migration
//
// Two-period query absorption analysis. For each (page, query) pair lost in
// the previous period and (page, query) gained in the current period across
// *different* pages, match via either exact string or `levenshtein()` ≤ 2
// edits. The matched edge represents impressions that *probably* migrated
// from page-A to page-B as Google reassigned the ranking URL.
//
// Output: a sankey-ready edge list grouped by (sourcePage → targetPage),
// weighted by absorbed impressions, with example query pairs attached.
// ---------------------------------------------------------------------------

function buildQueryMigration(params: AnalysisParams): AnalyzerSpec {
  const cur = period(params)
  // Default the previous period to a same-length window immediately preceding
  // the current period if not explicitly set.
  let prevStart = params.prevStartDate
  let prevEnd = params.prevEndDate
  if (prevStart == null || prevEnd == null) {
    const curStartMs = new Date(cur.startDate).getTime()
    const curEndMs = new Date(cur.endDate).getTime()
    const span = curEndMs - curStartMs
    prevEnd = new Date(curStartMs - 86400000).toISOString().split('T')[0]
    prevStart = new Date(curStartMs - 86400000 - span).toISOString().split('T')[0]
  }
  const minImpressions = params.minImpressions ?? 20
  const limit = params.limit ?? 200
  const maxLevenshtein = 2

  const sql = `
    WITH cur AS (
      SELECT query, url AS page,
        CAST(SUM(impressions) AS DOUBLE) AS impressions,
        CAST(SUM(clicks) AS DOUBLE) AS clicks,
        SUM(sum_position) / NULLIF(SUM(impressions), 0) + 1 AS position
      FROM read_parquet({{FILES}}, union_by_name = true)
      WHERE date >= ? AND date <= ?
        AND query IS NOT NULL AND query <> ''
        AND url IS NOT NULL AND url <> ''
      GROUP BY query, url
      HAVING SUM(impressions) >= ?
    ),
    prev AS (
      SELECT query, url AS page,
        CAST(SUM(impressions) AS DOUBLE) AS impressions,
        CAST(SUM(clicks) AS DOUBLE) AS clicks,
        SUM(sum_position) / NULLIF(SUM(impressions), 0) + 1 AS position
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
    shape: (rows) => {
      const edges = rows.map(r => ({
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

      // Build node set with cumulative outgoing/incoming weight for sankey layout.
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
  }
}

// ---------------------------------------------------------------------------
// clustering
// ---------------------------------------------------------------------------

const INTENT_PREFIXES_REGEX
  = '^(how to|what is|what are|why is|why do|where to|when to|best|top|vs|versus|compare|review|buy|cheap|free|near me)(\\s|$)'

function buildClustering(params: AnalysisParams): AnalyzerSpec {
  const { startDate, endDate } = period(params)
  const minImpressions = params.minImpressions ?? 10
  const minClusterSize = params.minClusterSize ?? 2
  const clusterBy = params.clusterBy ?? 'both'
  const doIntent = clusterBy === 'intent' || clusterBy === 'both'
  const doPrefix = clusterBy === 'prefix' || clusterBy === 'both'

  // NULL fallbacks must be typed; a bare NULL is inferred as INTEGER and breaks
  // the downstream COALESCE(intent_prefix, word_prefix) when one mode is off.
  const intentExpr = doIntent
    ? `NULLIF(regexp_extract(LOWER(query), '${INTENT_PREFIXES_REGEX}', 1), '')`
    : `CAST(NULL AS VARCHAR)`

  const prefixExpr = doPrefix
    ? `CASE WHEN len(regexp_split_to_array(LOWER(query), '\\s+')) >= 3
        THEN array_to_string(list_slice(regexp_split_to_array(LOWER(query), '\\s+'), 1, 2), ' ')
        ELSE CAST(NULL AS VARCHAR) END`
    : `CAST(NULL AS VARCHAR)`

  const sql = `
    WITH agg AS (
      SELECT
        query,
        CAST(SUM(clicks) AS DOUBLE) AS clicks,
        CAST(SUM(impressions) AS DOUBLE) AS impressions,
        CAST(SUM(clicks) AS DOUBLE) / NULLIF(SUM(impressions), 0) AS ctr,
        SUM(sum_position) / NULLIF(SUM(impressions), 0) + 1 AS position
      FROM read_parquet({{FILES}}, union_by_name = true)
      WHERE date >= ? AND date <= ?
      GROUP BY query
      HAVING SUM(impressions) >= ?
    ),
    classified AS (
      SELECT
        query, clicks, impressions, ctr, position,
        ${intentExpr} AS intent_prefix,
        ${prefixExpr} AS word_prefix
      FROM agg
    ),
    keyed AS (
      SELECT
        query, clicks, impressions, ctr, position,
        COALESCE(intent_prefix, word_prefix) AS cluster_name,
        CASE WHEN intent_prefix IS NOT NULL THEN 'intent' ELSE 'prefix' END AS cluster_type
      FROM classified
      WHERE COALESCE(intent_prefix, word_prefix) IS NOT NULL
    )
    SELECT
      cluster_name AS clusterName,
      any_value(cluster_type) AS clusterType,
      CAST(COUNT(*) AS DOUBLE) AS keywordCount,
      CAST(SUM(clicks) AS DOUBLE) AS totalClicks,
      CAST(SUM(impressions) AS DOUBLE) AS totalImpressions,
      AVG(position) AS avgPosition,
      to_json(list({ 'query': query, 'clicks': clicks, 'impressions': impressions, 'ctr': ctr, 'position': position })) AS keywords
    FROM keyed
    GROUP BY cluster_name
    HAVING COUNT(*) >= ?
    ORDER BY totalClicks DESC
  `

  return {
    sql,
    params: [startDate, endDate, minImpressions, minClusterSize],
    current: { table: 'keywords', partitions: enumeratePartitions(startDate, endDate) },
    shape: (rows) => {
      const clusters = rows.map(r => ({
        clusterName: str(r.clusterName),
        clusterType: str(r.clusterType) as 'intent' | 'prefix',
        keywordCount: num(r.keywordCount),
        totalClicks: num(r.totalClicks),
        totalImpressions: num(r.totalImpressions),
        avgPosition: num(r.avgPosition),
        keywords: parseJsonList(r.keywords).map(k => ({
          query: str(k.query),
          clicks: num(k.clicks),
          impressions: num(k.impressions),
          ctr: num(k.ctr),
          position: num(k.position),
        })),
      }))
      return {
        results: clusters,
        meta: { total: clusters.length, totalClusters: clusters.length },
      }
    },
  }
}

// ---------------------------------------------------------------------------
// concentration
// ---------------------------------------------------------------------------

function buildConcentration(params: AnalysisParams): AnalyzerSpec {
  const { startDate, endDate } = period(params)
  const dim = params.dimension || 'pages'
  const topN = params.topN ?? 10
  const table: TableName = dim === 'keywords' ? 'keywords' : 'pages'
  const keyCol = dim === 'keywords' ? 'query' : 'url'

  const sql = `
    WITH items AS (
      SELECT
        ${keyCol} AS key,
        CAST(SUM(clicks) AS DOUBLE) AS clicks
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
    shape: (rows) => {
      const r = rows[0] ?? {}
      const topRaw: Row[] = parseJsonList(r.topNItems)
      const summary = {
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
        riskLevel: str(r.riskLevel) as 'low' | 'medium' | 'high',
      }
      return {
        results: [summary],
        meta: { total: 1, dimension: dim },
      }
    },
  }
}

// ---------------------------------------------------------------------------
// seasonality
// ---------------------------------------------------------------------------

function buildSeasonality(params: AnalysisParams): AnalyzerSpec {
  const { startDate, endDate } = period(params)
  const metric = params.metric === 'impressions' ? 'impressions' : 'clicks'

  const sql = `
    WITH monthly AS (
      SELECT
        strftime(date, '%Y-%m') AS month,
        CAST(SUM(${metric}) AS DOUBLE) AS value
      FROM read_parquet({{FILES}}, union_by_name = true)
      WHERE date >= ? AND date <= ?
      GROUP BY month
    ),
    stats AS (
      SELECT
        AVG(value) AS avg_val,
        COALESCE(STDDEV_POP(value), 0.0) AS std_val,
        CAST(COUNT(*) AS DOUBLE) AS month_count
      FROM monthly
    )
    SELECT
      m.month AS month,
      m.value AS value,
      CASE WHEN s.avg_val > 0 THEN m.value / s.avg_val ELSE 0.0 END AS vsAverage,
      (s.avg_val > 0 AND m.value / s.avg_val > 1.5) AS isPeak,
      (s.avg_val > 0 AND m.value / s.avg_val < 0.5) AS isTrough,
      CASE WHEN s.avg_val > 0 THEN LEAST(s.std_val / s.avg_val, 1.0) ELSE 0.0 END AS strength,
      s.month_count AS monthCount
    FROM monthly m, stats s
    ORDER BY m.month
  `

  return {
    sql,
    params: [startDate, endDate],
    current: { table: 'pages', partitions: enumeratePartitions(startDate, endDate) },
    shape: (rows) => {
      const breakdown = rows.map(r => ({
        month: str(r.month),
        value: num(r.value),
        vsAverage: num(r.vsAverage),
        isPeak: bool(r.isPeak),
        isTrough: bool(r.isTrough),
      }))
      const first = rows[0]
      const strength = first ? num(first.strength) : 0
      const monthCount = first ? num(first.monthCount) : 0
      const peakMonths = [...new Set(
        breakdown.filter(m => m.isPeak).map(m => m.month.substring(5, 7)),
      )]
      const troughMonths = [...new Set(
        breakdown.filter(m => m.isTrough).map(m => m.month.substring(5, 7)),
      )]
      const hasSeasonality = peakMonths.length > 0 || troughMonths.length > 0 || strength > 0.3
      const insufficientData = monthCount < 12
      return {
        results: breakdown,
        meta: {
          total: breakdown.length,
          hasSeasonality,
          strength,
          peakMonths,
          troughMonths,
          insufficientData,
        },
      }
    },
  }
}

// ---------------------------------------------------------------------------
// movers (comparison)
// ---------------------------------------------------------------------------

function buildMovers(params: AnalysisParams): AnalyzerSpec {
  const cur = period(params)
  const prev = previous(params)
  const minImpressions = params.minImpressions ?? 50
  const changeThreshold = params.changeThreshold ?? 0.2
  const limit = params.limit ?? 2000

  // `weekly` unions both file sets so every entity gets a weekly sparkline
  // spanning prev_start → cur_end (with a gap for any dates between periods).
  const sql = `
    WITH cur AS (
      SELECT
        query, url,
        CAST(SUM(clicks) AS DOUBLE) AS clicks,
        CAST(SUM(impressions) AS DOUBLE) AS impressions,
        SUM(sum_position) / NULLIF(SUM(impressions), 0) + 1 AS position
      FROM read_parquet({{FILES}}, union_by_name = true)
      WHERE date >= ? AND date <= ?
      GROUP BY query, url
    ),
    prev AS (
      SELECT
        query, url,
        CAST(SUM(clicks) AS DOUBLE) AS clicks,
        CAST(SUM(impressions) AS DOUBLE) AS impressions,
        SUM(sum_position) / NULLIF(SUM(impressions), 0) + 1 AS position
      FROM read_parquet({{FILES_PREV}}, union_by_name = true)
      WHERE date >= ? AND date <= ?
      GROUP BY query, url
    ),
    weekly AS (
      SELECT query, url, date_trunc('week', date) AS week,
        CAST(SUM(clicks) AS DOUBLE) AS clicks,
        CAST(SUM(impressions) AS DOUBLE) AS impressions
      FROM (
        SELECT query, url, date, clicks, impressions
        FROM read_parquet({{FILES}}, union_by_name = true)
        WHERE date >= ? AND date <= ?
        UNION ALL
        SELECT query, url, date, clicks, impressions
        FROM read_parquet({{FILES_PREV}}, union_by_name = true)
        WHERE date >= ? AND date <= ?
      )
      GROUP BY query, url, week
    ),
    series_by_entity AS (
      SELECT query, url, to_json(list({
        'week': strftime(week, '%Y-%m-%d'),
        'clicks': clicks,
        'impressions': impressions
      } ORDER BY week)) AS seriesJson
      FROM weekly GROUP BY query, url
    ),
    joined AS (
      SELECT
        c.query AS keyword,
        c.url AS page,
        c.clicks AS recentClicks,
        c.impressions AS recentImpressions,
        c.position AS recentPosition,
        COALESCE(p.clicks, 0.0) AS baselineClicks,
        COALESCE(p.impressions, 0.0) AS baselineImpressions,
        COALESCE(p.position, 0.0) AS baselinePosition,
        (c.clicks - COALESCE(p.clicks, 0.0)) AS clicksChange,
        CASE
          WHEN COALESCE(p.clicks, 0.0) = 0 THEN CASE WHEN c.clicks > 0 THEN 100.0 ELSE 0.0 END
          ELSE (c.clicks - p.clicks) * 100.0 / p.clicks
        END AS clicksChangePercent,
        CASE
          WHEN COALESCE(p.impressions, 0.0) = 0 THEN CASE WHEN c.impressions > 0 THEN 100.0 ELSE 0.0 END
          ELSE (c.impressions - p.impressions) * 100.0 / p.impressions
        END AS impressionsChangePercent,
        (c.position - COALESCE(p.position, 0.0)) AS positionChange,
        s.seriesJson
      FROM cur c
      LEFT JOIN prev p ON c.query = p.query AND c.url = p.url
      LEFT JOIN series_by_entity s ON c.query = s.query AND c.url = s.url
      WHERE c.impressions >= ?
    )
    SELECT *,
      CASE
        WHEN clicksChangePercent > 0 AND ABS(clicksChangePercent) / 100.0 >= ? THEN 'rising'
        WHEN clicksChangePercent < 0 AND ABS(clicksChangePercent) / 100.0 >= ? THEN 'declining'
        ELSE 'stable'
      END AS direction
    FROM joined
    ORDER BY ABS(clicksChangePercent) DESC
    LIMIT ${Number(limit)}
  `

  return {
    sql,
    params: [
      cur.startDate,
      cur.endDate,
      prev.startDate,
      prev.endDate,
      cur.startDate,
      cur.endDate,
      prev.startDate,
      prev.endDate,
      minImpressions,
      changeThreshold,
      changeThreshold,
    ],
    current: { table: 'page_keywords', partitions: enumeratePartitions(cur.startDate, cur.endDate) },
    previous: { table: 'page_keywords', partitions: enumeratePartitions(prev.startDate, prev.endDate) },
    shape: (rows) => {
      const normalized = rows.map(r => ({
        keyword: str(r.keyword),
        page: r.page == null ? null : str(r.page),
        recentClicks: num(r.recentClicks),
        recentImpressions: num(r.recentImpressions),
        recentPosition: num(r.recentPosition),
        baselineClicks: Math.round(num(r.baselineClicks)),
        baselineImpressions: Math.round(num(r.baselineImpressions)),
        baselinePosition: num(r.baselinePosition),
        clicksChange: num(r.clicksChange),
        clicksChangePercent: num(r.clicksChangePercent),
        impressionsChangePercent: num(r.impressionsChangePercent),
        positionChange: num(r.positionChange),
        direction: str(r.direction) as 'rising' | 'declining' | 'stable',
        series: parseJsonList(r.seriesJson).map(s => ({
          week: str(s.week),
          clicks: num(s.clicks),
          impressions: num(s.impressions),
        })),
      }))
      const rising = normalized.filter(r => r.direction === 'rising')
      const declining = normalized.filter(r => r.direction === 'declining')
      const stable = normalized.filter(r => r.direction === 'stable')
      const combined = [...rising, ...declining]
      return {
        results: combined,
        meta: {
          total: combined.length,
          rising: rising.length,
          declining: declining.length,
          stable: stable.length,
        },
      }
    },
  }
}

// ---------------------------------------------------------------------------
// decay (comparison)
// ---------------------------------------------------------------------------

function buildDecay(params: AnalysisParams): AnalyzerSpec {
  const cur = period(params)
  const prev = previous(params)
  const minPreviousClicks = params.minPreviousClicks ?? 50
  const threshold = params.threshold ?? 0.2
  const limit = params.limit ?? 2000

  // weekly: union both file sets for a per-page weekly sparkline that spans
  // prev_start → cur_end (with any between-period gap rendered as `·` at UI time).
  const sql = `
    WITH cur AS (
      SELECT
        url,
        CAST(SUM(clicks) AS DOUBLE) AS clicks,
        SUM(sum_position) / NULLIF(SUM(impressions), 0) + 1 AS position
      FROM read_parquet({{FILES}}, union_by_name = true)
      WHERE date >= ? AND date <= ?
      GROUP BY url
    ),
    prev AS (
      SELECT
        url,
        CAST(SUM(clicks) AS DOUBLE) AS clicks,
        SUM(sum_position) / NULLIF(SUM(impressions), 0) + 1 AS position
      FROM read_parquet({{FILES_PREV}}, union_by_name = true)
      WHERE date >= ? AND date <= ?
      GROUP BY url
      HAVING SUM(clicks) >= ?
    ),
    weekly AS (
      SELECT url, date_trunc('week', date) AS week,
        CAST(SUM(clicks) AS DOUBLE) AS clicks,
        CAST(SUM(impressions) AS DOUBLE) AS impressions
      FROM (
        SELECT url, date, clicks, impressions
        FROM read_parquet({{FILES}}, union_by_name = true)
        WHERE date >= ? AND date <= ?
        UNION ALL
        SELECT url, date, clicks, impressions
        FROM read_parquet({{FILES_PREV}}, union_by_name = true)
        WHERE date >= ? AND date <= ?
      )
      GROUP BY url, week
    ),
    series_by_url AS (
      SELECT url, to_json(list({
        'week': strftime(week, '%Y-%m-%d'),
        'clicks': clicks,
        'impressions': impressions
      } ORDER BY week)) AS seriesJson
      FROM weekly GROUP BY url
    ),
    joined AS (
      SELECT
        p.url AS page,
        COALESCE(c.clicks, 0.0) AS currentClicks,
        p.clicks AS previousClicks,
        (p.clicks - COALESCE(c.clicks, 0.0)) AS lostClicks,
        (p.clicks - COALESCE(c.clicks, 0.0)) / NULLIF(p.clicks, 0) AS declinePercent,
        COALESCE(c.position, 0.0) AS currentPosition,
        p.position AS previousPosition,
        (COALESCE(c.position, 0.0) - p.position) AS positionDrop,
        s.seriesJson
      FROM prev p
      LEFT JOIN cur c ON p.url = c.url
      LEFT JOIN series_by_url s ON p.url = s.url
    )
    SELECT *
    FROM joined
    WHERE declinePercent >= ? AND lostClicks > 0
    ORDER BY lostClicks DESC
    LIMIT ${Number(limit)}
  `

  return {
    sql,
    params: [
      cur.startDate,
      cur.endDate,
      prev.startDate,
      prev.endDate,
      minPreviousClicks,
      cur.startDate,
      cur.endDate,
      prev.startDate,
      prev.endDate,
      threshold,
    ],
    current: { table: 'pages', partitions: enumeratePartitions(cur.startDate, cur.endDate) },
    previous: { table: 'pages', partitions: enumeratePartitions(prev.startDate, prev.endDate) },
    shape: rows => ({
      results: rows.map(r => ({
        page: str(r.page),
        currentClicks: num(r.currentClicks),
        previousClicks: num(r.previousClicks),
        lostClicks: num(r.lostClicks),
        declinePercent: num(r.declinePercent),
        currentPosition: num(r.currentPosition),
        previousPosition: num(r.previousPosition),
        positionDrop: num(r.positionDrop),
        series: parseJsonList(r.seriesJson).map(s => ({
          week: str(s.week),
          clicks: num(s.clicks),
          impressions: num(s.impressions),
        })),
      })),
      meta: { total: rows.length },
    }),
  }
}

// ---------------------------------------------------------------------------
// trends — weekly trajectory over a rolling window (default 28 weeks)
// ---------------------------------------------------------------------------

function buildTrends(params: AnalysisParams): AnalyzerSpec {
  const weeks = params.weeks ?? 28
  const endDate = params.endDate || DEFAULT_END()
  const startDate = params.startDate
    || new Date(Date.parse(endDate) - (weeks * 7 - 1) * 86400000).toISOString().split('T')[0]
  const minImpressions = params.minImpressions ?? 100
  const minWeeksWithData = params.minWeeksWithData ?? Math.max(2, Math.floor(weeks / 4))
  const limit = params.limit ?? 500
  const dim = params.dimension === 'keywords' ? 'keywords' : 'pages'
  const table: TableName = dim === 'keywords' ? 'keywords' : 'pages'
  const keyCol = dim === 'keywords' ? 'query' : 'url'

  // DuckDB's `date_trunc('week', d)` buckets to Monday. Series rows store
  // the week start as YYYY-MM-DD. regr_slope(clicks, week_idx) gives the
  // least-squares slope in clicks per week; growthRatio compares sum of
  // second half vs first half of the series (halves split at floor(n/2)).
  const sql = `
    WITH bucketed AS (
      SELECT
        ${keyCol} AS entity,
        date_trunc('week', date) AS week,
        CAST(SUM(clicks) AS DOUBLE) AS clicks,
        CAST(SUM(impressions) AS DOUBLE) AS impressions,
        SUM(sum_position) AS sum_position_sum
      FROM read_parquet({{FILES}}, union_by_name = true)
      WHERE date >= ? AND date <= ?
      GROUP BY entity, week
    ),
    with_meta AS (
      SELECT
        entity, week, clicks, impressions, sum_position_sum,
        ROW_NUMBER() OVER (PARTITION BY entity ORDER BY week) - 1 AS week_idx,
        COUNT(*) OVER (PARTITION BY entity) AS n_weeks,
        (ROW_NUMBER() OVER (PARTITION BY entity ORDER BY week) - 1)
          < (COUNT(*) OVER (PARTITION BY entity) / 2) AS is_first_half
      FROM bucketed
    ),
    agg AS (
      SELECT
        entity,
        SUM(clicks) AS totalClicks,
        SUM(impressions) AS totalImpressions,
        any_value(n_weeks) AS weeksWithData,
        COALESCE(regr_slope(clicks, CAST(week_idx AS DOUBLE)), 0.0) AS slope,
        SUM(CASE WHEN is_first_half THEN clicks ELSE 0 END) AS firstHalfClicks,
        SUM(CASE WHEN NOT is_first_half THEN clicks ELSE 0 END) AS secondHalfClicks,
        SUM(sum_position_sum) / NULLIF(SUM(impressions), 0) + 1 AS avgPosition,
        to_json(list({
          'week': strftime(week, '%Y-%m-%d'),
          'clicks': clicks,
          'impressions': impressions
        } ORDER BY week)) AS seriesJson
      FROM with_meta
      GROUP BY entity
      HAVING SUM(impressions) >= ? AND any_value(n_weeks) >= ?
    ),
    classified AS (
      SELECT
        *,
        CASE
          WHEN firstHalfClicks = 0 AND secondHalfClicks > 0 THEN 10.0
          WHEN firstHalfClicks = 0 THEN 1.0
          ELSE secondHalfClicks / firstHalfClicks
        END AS growthRatio
      FROM agg
    )
    SELECT
      entity,
      totalClicks,
      totalImpressions,
      weeksWithData,
      slope,
      growthRatio,
      avgPosition,
      CASE
        WHEN growthRatio >= 1.5 AND slope > 0 THEN 'accelerating'
        WHEN growthRatio >= 1.1 AND slope >= 0 THEN 'growing'
        WHEN growthRatio < 0.5 THEN 'cratering'
        WHEN growthRatio < 0.9 AND slope < 0 THEN 'declining'
        ELSE 'steady'
      END AS trend,
      seriesJson
    FROM classified
    ORDER BY
      CASE
        WHEN growthRatio >= 1.5 AND slope > 0 THEN 0
        WHEN growthRatio < 0.5 THEN 1
        WHEN growthRatio >= 1.1 AND slope >= 0 THEN 2
        WHEN growthRatio < 0.9 AND slope < 0 THEN 3
        ELSE 4
      END,
      ABS(growthRatio - 1) DESC,
      totalClicks DESC
    LIMIT ${Number(limit)}
  `

  return {
    sql,
    params: [startDate, endDate, minImpressions, minWeeksWithData],
    current: { table, partitions: enumeratePartitions(startDate, endDate) },
    shape: (rows) => {
      const results = rows.map((r) => {
        const series = parseJsonList(r.seriesJson).map(s => ({
          week: str(s.week),
          clicks: num(s.clicks),
          impressions: num(s.impressions),
        }))
        return {
          [dim === 'keywords' ? 'query' : 'page']: str(r.entity),
          totalClicks: num(r.totalClicks),
          totalImpressions: num(r.totalImpressions),
          weeksWithData: num(r.weeksWithData),
          slope: num(r.slope),
          growthRatio: num(r.growthRatio),
          avgPosition: num(r.avgPosition),
          trend: str(r.trend) as 'accelerating' | 'growing' | 'steady' | 'declining' | 'cratering',
          series,
        }
      })
      const counts = {
        accelerating: 0,
        growing: 0,
        steady: 0,
        declining: 0,
        cratering: 0,
      } as Record<string, number>
      for (const r of results) counts[r.trend]++
      return {
        results,
        meta: {
          total: results.length,
          dimension: dim,
          weeks: Number(weeks),
          startDate,
          endDate,
          counts,
        },
      }
    },
  }
}

// ---------------------------------------------------------------------------
// zero-click
// ---------------------------------------------------------------------------

function buildZeroClick(params: AnalysisParams): AnalyzerSpec {
  const { startDate, endDate } = period(params)
  const minImpressions = params.minImpressions ?? 1000
  const maxCtr = params.maxCtr ?? 0.03
  const maxPosition = params.maxPosition ?? 10
  const limit = params.limit ?? 1000

  // Group by query+url, filter on impressions/position/ctr, and compute
  // missedClicks via tiered expected-CTR. Ordering mirrors the server-side
  // analyzer (impressions DESC) so parity tests stay byte-identical.
  const sql = `
    WITH agg AS (
      SELECT
        query,
        url AS page,
        CAST(SUM(clicks) AS DOUBLE) AS clicks,
        CAST(SUM(impressions) AS DOUBLE) AS impressions,
        CAST(SUM(clicks) AS DOUBLE) / NULLIF(SUM(impressions), 0) AS ctr,
        SUM(sum_position) / NULLIF(SUM(impressions), 0) + 1 AS position
      FROM read_parquet({{FILES}}, union_by_name = true)
      WHERE date >= ? AND date <= ?
      GROUP BY query, url
      HAVING SUM(impressions) >= ?
    )
    SELECT
      query, page, clicks, impressions, ctr, position,
      CAST(GREATEST(0, ROUND(impressions * (
        CASE
          WHEN position <= 1 THEN 0.30
          WHEN position <= 3 THEN 0.15
          WHEN position <= 5 THEN 0.08
          ELSE 0.04
        END
      )) - clicks) AS DOUBLE) AS missedClicks
    FROM agg
    WHERE position <= ? AND ctr < ?
    ORDER BY impressions DESC
    LIMIT ${Number(limit)}
  `

  return {
    sql,
    params: [startDate, endDate, minImpressions, maxPosition, maxCtr],
    current: { table: 'page_keywords', partitions: enumeratePartitions(startDate, endDate) },
    shape: rows => ({
      results: rows.map(r => ({
        query: str(r.query),
        page: r.page == null ? null : str(r.page),
        clicks: num(r.clicks),
        impressions: num(r.impressions),
        ctr: num(r.ctr),
        position: num(r.position),
        missedClicks: num(r.missedClicks),
      })),
      meta: {
        total: rows.length,
        minImpressions,
        maxCtr,
        maxPosition,
      },
    }),
  }
}

// ---------------------------------------------------------------------------
// position-distribution — daily count of keywords per position bucket.
// Matches `/api/sites/[siteId]/position-distribution.get.ts`.
// ---------------------------------------------------------------------------

function buildPositionDistribution(params: AnalysisParams): AnalyzerSpec {
  const { startDate, endDate } = period(params)
  const sql = `
    WITH pos AS (
      SELECT
        date,
        (sum_position / NULLIF(impressions, 0) + 1) AS avg_pos
      FROM read_parquet({{FILES}}, union_by_name = true)
      WHERE date >= ? AND date <= ? AND impressions > 0
    )
    SELECT
      date,
      CAST(SUM(CASE WHEN avg_pos <= 3 THEN 1 ELSE 0 END) AS DOUBLE) AS pos_1_3,
      CAST(SUM(CASE WHEN avg_pos > 3 AND avg_pos <= 10 THEN 1 ELSE 0 END) AS DOUBLE) AS pos_4_10,
      CAST(SUM(CASE WHEN avg_pos > 10 AND avg_pos <= 20 THEN 1 ELSE 0 END) AS DOUBLE) AS pos_11_20,
      CAST(SUM(CASE WHEN avg_pos > 20 THEN 1 ELSE 0 END) AS DOUBLE) AS pos_20_plus,
      CAST(COUNT(*) AS DOUBLE) AS total
    FROM pos
    GROUP BY date
    ORDER BY date ASC
  `
  return {
    sql,
    params: [startDate, endDate],
    current: { table: 'keywords', partitions: enumeratePartitions(startDate, endDate) },
    shape: rows => ({
      results: rows.map(r => ({
        date: str(r.date),
        pos_1_3: num(r.pos_1_3),
        pos_4_10: num(r.pos_4_10),
        pos_11_20: num(r.pos_11_20),
        pos_20_plus: num(r.pos_20_plus),
        total: num(r.total),
      })),
      meta: { total: rows.length, startDate, endDate },
    }),
  }
}

// ---------------------------------------------------------------------------
// ctr-curve — CTR by position bucket plus over/under-performing outliers.
// Matches `/api/sites/[siteId]/ctr-curve.get.ts`.
//
// Returns two result sections via to_json(list(...)) so the whole thing fits
// in one SQL pass. Shape splits them into results (curve) and meta
// (overperforming / underperforming).
// ---------------------------------------------------------------------------

function buildCtrCurve(params: AnalysisParams): AnalyzerSpec {
  const { startDate, endDate } = period(params)
  const sql = `
    WITH src AS (
      SELECT
        query,
        clicks,
        impressions,
        sum_position,
        (sum_position / NULLIF(impressions, 0) + 1) AS avg_pos
      FROM read_parquet({{FILES}}, union_by_name = true)
      WHERE date >= ? AND date <= ? AND impressions > 0
    ),
    curve AS (
      SELECT
        CASE
          WHEN avg_pos <= 1.5 THEN '1'
          WHEN avg_pos <= 2.5 THEN '2'
          WHEN avg_pos <= 3.5 THEN '3'
          WHEN avg_pos <= 5.5 THEN '4-5'
          WHEN avg_pos <= 10.5 THEN '6-10'
          WHEN avg_pos <= 20.5 THEN '11-20'
          ELSE '20+'
        END AS bucket,
        AVG(CAST(clicks AS DOUBLE) / NULLIF(impressions, 0)) AS avgCtr,
        AVG(avg_pos) AS medianPosition,
        CAST(COUNT(DISTINCT query) AS DOUBLE) AS keywordCount,
        CAST(SUM(clicks) AS DOUBLE) AS totalClicks,
        CAST(SUM(impressions) AS DOUBLE) AS totalImpressions
      FROM src
      GROUP BY bucket
    ),
    ks AS (
      SELECT
        query,
        CAST(SUM(clicks) AS DOUBLE) AS clicks,
        CAST(SUM(impressions) AS DOUBLE) AS impressions,
        CAST(SUM(clicks) AS DOUBLE) / NULLIF(SUM(impressions), 0) AS ctr,
        SUM(sum_position) / NULLIF(SUM(impressions), 0) + 1 AS position,
        CASE
          WHEN SUM(sum_position) / NULLIF(SUM(impressions), 0) + 1 <= 3.5 THEN 'top3'
          WHEN SUM(sum_position) / NULLIF(SUM(impressions), 0) + 1 <= 10.5 THEN 'page1'
          WHEN SUM(sum_position) / NULLIF(SUM(impressions), 0) + 1 <= 20.5 THEN 'page2'
          ELSE 'deep'
        END AS band
      FROM src
      GROUP BY query
      HAVING SUM(impressions) >= 20
    ),
    band_avg AS (
      SELECT band, AVG(ctr) AS band_avg_ctr FROM ks GROUP BY band
    ),
    outliers AS (
      SELECT
        ks.query, ks.clicks, ks.impressions, ks.ctr, ks.position,
        ba.band_avg_ctr AS expectedCtr,
        ks.ctr - ba.band_avg_ctr AS ctrDiff
      FROM ks JOIN band_avg ba ON ks.band = ba.band
      ORDER BY ABS(ks.ctr - ba.band_avg_ctr) DESC
      LIMIT 50
    )
    SELECT
      (SELECT to_json(list({
        'bucket': bucket,
        'avgCtr': avgCtr,
        'medianPosition': medianPosition,
        'keywordCount': keywordCount,
        'totalClicks': totalClicks,
        'totalImpressions': totalImpressions
      })) FROM curve) AS curve_json,
      (SELECT to_json(list({
        'query': query,
        'clicks': clicks,
        'impressions': impressions,
        'ctr': ctr,
        'position': position,
        'expectedCtr': expectedCtr,
        'ctrDiff': ctrDiff
      })) FROM outliers) AS outliers_json
  `
  return {
    sql,
    params: [startDate, endDate],
    current: { table: 'keywords', partitions: enumeratePartitions(startDate, endDate) },
    shape: (rows) => {
      const row = rows[0] ?? {}
      const curve = parseJsonList(row.curve_json).map(r => ({
        bucket: str(r.bucket),
        avgCtr: num(r.avgCtr),
        medianPosition: num(r.medianPosition),
        keywordCount: num(r.keywordCount),
        totalClicks: num(r.totalClicks),
        totalImpressions: num(r.totalImpressions),
      }))
      const outliers = parseJsonList(row.outliers_json).map(r => ({
        query: str(r.query),
        clicks: num(r.clicks),
        impressions: num(r.impressions),
        ctr: num(r.ctr),
        position: num(r.position),
        expectedCtr: num(r.expectedCtr),
        ctrDiff: num(r.ctrDiff),
      }))
      // Server splits into over/underperforming by sign of ctrDiff and takes 25 of each.
      const over = outliers.filter(o => o.ctrDiff > 0).slice(0, 25)
      const under = outliers.filter(o => o.ctrDiff < 0).slice(0, 25)
      return {
        results: curve,
        meta: { overperforming: over, underperforming: under, startDate, endDate },
      }
    },
  }
}

// ---------------------------------------------------------------------------
// dark-traffic — gap between page-level clicks and sum-of-keyword clicks.
// Matches `/api/sites/[siteId]/dark-traffic.get.ts`.
//
// Reads three tables: pages (primary), keywords (summary aggregate),
// page_keywords (per-page attribution). Uses `extraFiles` for the latter two.
// ---------------------------------------------------------------------------

function buildDarkTraffic(params: AnalysisParams): AnalyzerSpec {
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

// ---------------------------------------------------------------------------
// content-velocity — weekly new-keyword cadence.
// Matches `/api/sites/[siteId]/content-velocity.get.ts`.
//
// Server uses SQLite's `strftime('%Y-W%W', ...)`; we use DuckDB's
// `strftime(date, '%G-W%V')` which produces ISO-week keys. Both are
// lexicographically sortable. Day-of-week edge cases differ by at most a
// week at year boundaries; acceptable for a trend card.
// ---------------------------------------------------------------------------

function buildContentVelocity(params: AnalysisParams): AnalyzerSpec {
  const days = Math.min(Math.max(Number(params.days ?? 90), 7), 365)
  const endDate = DEFAULT_END()
  const start = new Date(endDate)
  start.setUTCDate(start.getUTCDate() - days)
  const startDate = start.toISOString().split('T')[0]

  const sql = `
    WITH src AS (
      SELECT query, date
      FROM read_parquet({{FILES}}, union_by_name = true)
      WHERE date >= ? AND date <= ? AND impressions > 0
    ),
    first_seen AS (
      SELECT query, MIN(date) AS first_date FROM src GROUP BY query
    ),
    per_week AS (
      SELECT
        strftime(date, '%G-W%V') AS week,
        MIN(date) AS week_start,
        CAST(COUNT(DISTINCT query) AS DOUBLE) AS totalKeywords
      FROM src
      GROUP BY week
    ),
    new_per_week AS (
      SELECT
        strftime(first_date, '%G-W%V') AS week,
        CAST(COUNT(*) AS DOUBLE) AS newKeywords
      FROM first_seen
      GROUP BY week
    )
    SELECT
      pw.week AS week,
      COALESCE(npw.newKeywords, 0) AS newKeywords,
      pw.totalKeywords AS totalKeywords
    FROM per_week pw
    LEFT JOIN new_per_week npw ON pw.week = npw.week
    ORDER BY pw.week ASC
  `
  return {
    sql,
    params: [startDate, endDate],
    current: { table: 'keywords', partitions: enumeratePartitions(startDate, endDate) },
    shape: (rows) => {
      const weekly = rows.map(r => ({
        week: str(r.week),
        newKeywords: num(r.newKeywords),
        totalKeywords: num(r.totalKeywords),
      }))
      const total = weekly.reduce((s, w) => s + w.newKeywords, 0)
      const avg = weekly.length > 0 ? total / weekly.length : 0
      // First-half vs second-half average → trend (matches server logic).
      const mid = Math.floor(weekly.length / 2)
      const firstAvg = mid > 0
        ? weekly.slice(0, mid).reduce((s, w) => s + w.newKeywords, 0) / mid
        : 0
      const secondAvg = weekly.length - mid > 0
        ? weekly.slice(mid).reduce((s, w) => s + w.newKeywords, 0) / (weekly.length - mid)
        : 0
      const diff = secondAvg - firstAvg
      const threshold = Math.max(1, avg * 0.15)
      const trend: 'stable' | 'accelerating' | 'decelerating'
        = diff > threshold ? 'accelerating' : diff < -threshold ? 'decelerating' : 'stable'
      return {
        results: weekly,
        meta: {
          summary: {
            totalNewKeywords: total,
            avgPerWeek: avg,
            trend,
          },
          days,
          startDate,
          endDate,
        },
      }
    },
  }
}

// ---------------------------------------------------------------------------
// keyword-breadth — keyword-count histogram across pages + fragile/authority
// classification. Matches `/api/sites/[siteId]/keyword-breadth.get.ts`.
// ---------------------------------------------------------------------------

function buildKeywordBreadth(params: AnalysisParams): AnalyzerSpec {
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

// ---------------------------------------------------------------------------
// device-gap — desktop vs mobile CTR/position delta over time.
// Matches `/api/sites/[siteId]/device-gap.get.ts`.
// ---------------------------------------------------------------------------

interface DeviceDayMetrics { clicks: number, impressions: number, ctr: number, position: number }
interface DeviceDayRow {
  date: string
  device: string
  clicks: number
  impressions: number
  ctr: number
  position: number
}

function buildDeviceGap(params: AnalysisParams): AnalyzerSpec {
  const { startDate, endDate } = period(params)
  const sql = `
    SELECT
      date,
      device,
      CAST(SUM(clicks) AS DOUBLE) AS clicks,
      CAST(SUM(impressions) AS DOUBLE) AS impressions,
      CAST(SUM(clicks) AS DOUBLE) / NULLIF(SUM(impressions), 0) AS ctr,
      SUM(sum_position) / NULLIF(SUM(impressions), 0) + 1 AS position
    FROM read_parquet({{FILES}}, union_by_name = true)
    WHERE date >= ? AND date <= ?
    GROUP BY date, device
    ORDER BY date ASC
  `
  return {
    sql,
    params: [startDate, endDate],
    current: { table: 'devices', partitions: enumeratePartitions(startDate, endDate) },
    shape: (rows) => {
      const typed = rows.map(r => ({
        date: str(r.date),
        device: str(r.device).toUpperCase(),
        clicks: num(r.clicks),
        impressions: num(r.impressions),
        ctr: num(r.ctr),
        position: num(r.position),
      })) as DeviceDayRow[]

      const byDate = new Map<string, { desktop?: DeviceDayMetrics, mobile?: DeviceDayMetrics }>()
      for (const r of typed) {
        const entry = byDate.get(r.date) ?? {}
        const metrics: DeviceDayMetrics = {
          clicks: r.clicks,
          impressions: r.impressions,
          ctr: r.ctr,
          position: r.position,
        }
        if (r.device === 'DESKTOP')
          entry.desktop = metrics
        else if (r.device === 'MOBILE')
          entry.mobile = metrics
        byDate.set(r.date, entry)
      }

      const zero: DeviceDayMetrics = { clicks: 0, impressions: 0, ctr: 0, position: 0 }
      const daily = [...byDate.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([date, sides]) => {
          const d = sides.desktop ?? zero
          const m = sides.mobile ?? zero
          return {
            date,
            desktop: d,
            mobile: m,
            gaps: {
              ctrGap: d.ctr - m.ctr,
              positionGap: m.position - d.position,
            },
          }
        })

      // First-week vs last-week average to classify trend.
      const weekly = (start: number, end: number): { ctr: number, pos: number } => {
        const slice = daily.slice(start, end)
        if (slice.length === 0)
          return { ctr: 0, pos: 0 }
        const sum = slice.reduce(
          (acc, d) => ({
            ctr: acc.ctr + d.gaps.ctrGap,
            pos: acc.pos + d.gaps.positionGap,
          }),
          { ctr: 0, pos: 0 },
        )
        return { ctr: sum.ctr / slice.length, pos: sum.pos / slice.length }
      }
      const first = weekly(0, 7)
      const last = weekly(Math.max(0, daily.length - 7), daily.length)
      const classify = (firstVal: number, lastVal: number): 'stable' | 'improving' | 'worsening' => {
        const diff = Math.abs(lastVal) - Math.abs(firstVal)
        if (Math.abs(diff) < 0.005)
          return 'stable' as const
        return diff < 0 ? ('improving' as const) : ('worsening' as const)
      }
      const avgCtrGap = daily.reduce((s, d) => s + d.gaps.ctrGap, 0) / Math.max(1, daily.length)
      const avgPositionGap = daily.reduce((s, d) => s + d.gaps.positionGap, 0) / Math.max(1, daily.length)

      return {
        results: daily,
        meta: {
          summary: {
            avgCtrGap,
            avgPositionGap,
            ctrGapTrend: classify(first.ctr, last.ctr),
            positionGapTrend: classify(first.pos, last.pos),
          },
          startDate,
          endDate,
        },
      }
    },
  }
}

// ---------------------------------------------------------------------------
// data-query / data-detail — generic BuilderState-driven queries.
// Both delegate to the dialect-neutral composers in @gscdump/analysis/query
// via the browser (pg-core) adapter. SQL emits direct pg table refs
// (`"pages"`, `"keywords"`, ...) which DuckDB resolves against the `main`
// schema where useBrowserAnalyzer has registered the parquet views.
// These analyzers are browser-only — server still hits the D1 resolver path.
// ---------------------------------------------------------------------------

interface BuilderStateLike {
  dimensions: string[]
  filter?: unknown
  metrics?: string[]
  orderBy?: { column: string, dir: 'asc' | 'desc' }
  rowLimit?: number
  startRow?: number
}

function buildDataQuery(params: AnalysisParams): AnalyzerSpec {
  const state = (params.q ?? null) as BuilderStateLike | null
  if (!state || !Array.isArray(state.dimensions))
    throw new Error('data-query: params.q is required (BuilderState)')
  if (state.dimensions.includes('date'))
    throw new Error('data-query: date dimension not supported; use data-detail')

  const options = { adapter: browserResolverAdapter }
  const prev = (params.qc ?? null) as BuilderStateLike | null

  const stateAsBuilderState = state as unknown as Parameters<typeof buildTotalsSqlUpstream>[0]
  const totals = buildTotalsSqlUpstream(stateAsBuilderState, options)
  const extras = buildExtrasQueriesUpstream(stateAsBuilderState, options)

  const extraQueries: ExtraQuerySpec[] = [
    { name: 'totals', sql: totals.sql, params: totals.params },
    ...extras.map(e => ({ name: e.key, sql: e.sql, params: e.params })),
  ]

  const inferredTable = browserResolverAdapter.inferTable(state.dimensions as never)

  if (prev) {
    const cmp = resolveComparisonSQLUpstream(
      stateAsBuilderState,
      prev as unknown as Parameters<typeof resolveComparisonSQLUpstream>[1],
      options,
      params.comparisonFilter,
    )
    extraQueries.push({ name: 'count', sql: cmp.countSql, params: cmp.countParams })
    return {
      sql: cmp.sql,
      params: cmp.params,
      current: { table: inferredTable, partitions: [] },
      browserOnly: true,
      extraQueries,
      shape: (rows, _p, ex) => shapeDataQuery(rows, ex, { hasPrev: true }),
    }
  }

  const optimized = resolveToSQLOptimizedUpstream(stateAsBuilderState, options)
  return {
    sql: optimized.sql,
    params: optimized.params,
    current: { table: inferredTable, partitions: [] },
    browserOnly: true,
    extraQueries,
    shape: (rows, _p, ex) => shapeDataQuery(rows, ex, { hasPrev: false }),
  }
}

// Columns known to be numeric across resolver output shapes. DuckDB returns
// SUM(INTEGER) as HUGEINT which arrives as DecimalBigNum over the Arrow
// bridge — consumers always want plain numbers.
const NUMERIC_METRIC_COLS = [
  'clicks',
  'impressions',
  'ctr',
  'position',
  'prevClicks',
  'prevImpressions',
  'prevCtr',
  'prevPosition',
  'variantCount',
  'totalCount',
] as const

function coerceNumericCols(row: Record<string, unknown>): Record<string, unknown> {
  const out = { ...row }
  for (const col of NUMERIC_METRIC_COLS) {
    if (col in out && out[col] != null)
      out[col] = Number(out[col] as number | bigint)
  }
  return out
}

function shapeDataQuery(
  rows: Row[],
  extras: Record<string, Row[]> | undefined,
  opts: { hasPrev: boolean },
): { results: Row[], meta: Record<string, unknown> } {
  let totalCount: number
  let cleaned: Record<string, unknown>[]
  if (opts.hasPrev) {
    // Comparison: rows already have current metrics + prev* fields.
    cleaned = (rows as Record<string, unknown>[]).map(coerceNumericCols)
    totalCount = Number((extras?.count?.[0] as { total?: number } | undefined)?.total ?? cleaned.length)
  }
  else {
    // Optimized path: window-function totals/count embedded in each row.
    const first = rows[0] as Record<string, unknown> | undefined
    totalCount = Number(first?.totalCount ?? 0)
    cleaned = rows.map((raw) => {
      const { totalCount: _tc, totalClicks: _tclk, totalImpressions: _timp, totalCtr: _tctr, totalPosition: _tpos, sum_position: _sp, ...rest } = raw as Record<string, unknown>
      return coerceNumericCols(rest)
    })
  }

  const totalsRow = (extras?.totals?.[0] ?? {}) as Record<string, unknown>
  const totals = {
    clicks: Number(totalsRow.clicks ?? 0),
    impressions: Number(totalsRow.impressions ?? 0),
    ctr: Number(totalsRow.ctr ?? 0),
    position: Number(totalsRow.position ?? 0),
  }

  const extrasResults: { key: string, results: Record<string, unknown>[] }[] = []
  if (extras?.canonicalExtras)
    extrasResults.push({ key: 'canonicalExtras', results: extras.canonicalExtras as Record<string, unknown>[] })
  const merged = mergeExtras(cleaned, extrasResults)

  return {
    results: merged as unknown as Row[],
    meta: { totalCount, totals },
  }
}

function buildDataDetail(params: AnalysisParams): AnalyzerSpec {
  const state = (params.q ?? null) as BuilderStateLike | null
  if (!state || !Array.isArray(state.dimensions))
    throw new Error('data-detail: params.q is required (BuilderState)')
  if (!state.dimensions.includes('date'))
    throw new Error('data-detail: `date` dimension is required')

  const options = { adapter: browserResolverAdapter }
  const stateAsBuilderState = state as unknown as Parameters<typeof resolveToSQLUpstream>[0]
  const main = resolveToSQLUpstream(stateAsBuilderState, options)
  const totals = buildTotalsSqlUpstream(stateAsBuilderState, options)

  const prev = (params.qc ?? null) as BuilderStateLike | null
  const extraQueries: ExtraQuerySpec[] = [
    { name: 'totals', sql: totals.sql, params: totals.params },
  ]
  if (prev) {
    const prevTotals = buildTotalsSqlUpstream(
      prev as unknown as Parameters<typeof buildTotalsSqlUpstream>[0],
      options,
    )
    extraQueries.push({ name: 'prevTotals', sql: prevTotals.sql, params: prevTotals.params })
  }

  const inferredTable = browserResolverAdapter.inferTable(state.dimensions as never)
  const { startDate: rangeStart, endDate: rangeEnd } = extractDateRange(
    (state as { filter?: unknown }).filter as never,
  )

  return {
    sql: main.sql,
    params: main.params,
    current: { table: inferredTable, partitions: [] },
    browserOnly: true,
    extraQueries,
    shape: (rows, _p, extras) => {
      const coerced = (rows as Array<Record<string, unknown>>).map(coerceNumericCols)
      const daily = rangeStart && rangeEnd
        ? padTimeseries(coerced, { startDate: rangeStart, endDate: rangeEnd })
        : coerced
      const totalsRow = (extras?.totals?.[0] ?? {}) as Record<string, unknown>
      const totals = {
        clicks: Number(totalsRow.clicks ?? 0),
        impressions: Number(totalsRow.impressions ?? 0),
        ctr: Number(totalsRow.ctr ?? 0),
        position: Number(totalsRow.position ?? 0),
      }
      const meta: Record<string, unknown> = { totals }
      if (extras?.prevTotals) {
        const pr = (extras.prevTotals[0] ?? {}) as Record<string, unknown>
        meta.previousTotals = {
          clicks: Number(pr.clicks ?? 0),
          impressions: Number(pr.impressions ?? 0),
          ctr: Number(pr.ctr ?? 0),
          position: Number(pr.position ?? 0),
        }
      }
      return { results: daily as unknown as Row[], meta }
    },
  }
}

// ---------------------------------------------------------------------------
// stl-decompose
//
// Classical additive decomposition: observed = trend + seasonal + residual.
// Trend is a centered 7-day moving average; seasonal is the mean of detrended
// residuals per-dayofweek per-entity; residual is the leftover. Entities with
// a large |residual| relative to STDDEV_POP(residual) are flagged anomalous.
// Not true STL (no iterative LOESS), but faithful where it matters and
// expressible in pure DuckDB window functions.
// ---------------------------------------------------------------------------

function buildStlDecompose(params: AnalysisParams): AnalyzerSpec {
  const endDate = params.endDate ?? DEFAULT_END()
  const startDate = params.startDate ?? new Date(Date.now() - 93 * 86400000).toISOString().split('T')[0]
  const minImpressions = params.minImpressions ?? 100
  const minDays = 21
  const metric = params.metric === 'clicks' ? 'clicks' : 'impressions'
  const limit = params.limit ?? 100

  const sql = `
    WITH daily AS (
      SELECT
        query,
        url AS page,
        date,
        CAST(SUM(clicks) AS DOUBLE) AS clicks,
        CAST(SUM(impressions) AS DOUBLE) AS impressions,
        CAST(SUM(${metric}) AS DOUBLE) AS observed
      FROM read_parquet({{FILES}}, union_by_name = true)
      WHERE date >= ? AND date <= ?
        AND query IS NOT NULL AND query <> ''
        AND url IS NOT NULL AND url <> ''
      GROUP BY query, url, date
    ),
    entity_stats AS (
      SELECT query, page,
        COUNT(*) AS days,
        SUM(impressions) AS total_impressions
      FROM daily
      GROUP BY query, page
      HAVING COUNT(*) >= ${Number(minDays)}
        AND SUM(impressions) >= ?
    ),
    filtered AS (
      SELECT d.*
      FROM daily d
      JOIN entity_stats e USING (query, page)
    ),
    trended AS (
      SELECT *,
        CASE
          WHEN COUNT(*) OVER w = 7
            THEN AVG(observed) OVER w
          ELSE NULL
        END AS trend
      FROM filtered
      WINDOW w AS (
        PARTITION BY query, page
        ORDER BY date
        ROWS BETWEEN 3 PRECEDING AND 3 FOLLOWING
      )
    ),
    detrended AS (
      SELECT *,
        observed - trend AS detrended,
        dayofweek(date) AS dow
      FROM trended
    ),
    seasonal_raw AS (
      SELECT *,
        AVG(detrended) OVER (PARTITION BY query, page, dow) AS seasonal_dow
      FROM detrended
    ),
    seasonal_centered AS (
      SELECT *,
        seasonal_dow - AVG(seasonal_dow) OVER (PARTITION BY query, page) AS seasonal
      FROM seasonal_raw
    ),
    residualed AS (
      SELECT *,
        CASE
          WHEN trend IS NULL OR seasonal IS NULL THEN NULL
          ELSE observed - trend - seasonal
        END AS residual
      FROM seasonal_centered
    ),
    scored AS (
      SELECT *,
        STDDEV_POP(residual) OVER (PARTITION BY query, page) AS resid_std,
        CASE
          WHEN residual IS NOT NULL
            AND STDDEV_POP(residual) OVER (PARTITION BY query, page) > 0
            AND ABS(residual) > 2.0 * STDDEV_POP(residual) OVER (PARTITION BY query, page)
          THEN true ELSE false
        END AS anomaly
      FROM residualed
    ),
    per_entity AS (
      SELECT query, page,
        COUNT(*) AS days,
        SUM(impressions) AS total_impressions,
        VAR_POP(detrended) AS var_detrended,
        VAR_POP(seasonal) AS var_seasonal,
        VAR_POP(residual) AS var_residual,
        COUNT(*) FILTER (WHERE anomaly) AS residual_anomalies,
        REGR_SLOPE(observed, epoch(date) / 86400.0) AS trend_slope
      FROM scored
      GROUP BY query, page
    ),
    series AS (
      SELECT query, page,
        to_json(list({
          'date': strftime(date, '%Y-%m-%d'),
          'observed': observed,
          'trend': trend,
          'seasonal': seasonal,
          'residual': residual,
          'anomaly': anomaly
        } ORDER BY date)) AS seriesJson
      FROM scored
      GROUP BY query, page
    )
    SELECT
      e.query AS keyword,
      e.page,
      CAST(e.total_impressions AS DOUBLE) AS totalImpressions,
      CAST(e.days AS DOUBLE) AS days,
      CASE
        WHEN e.var_detrended IS NULL OR e.var_detrended = 0 THEN 0.0
        ELSE LEAST(e.var_seasonal / NULLIF(e.var_detrended, 0), 1.0)
      END AS seasonalStrength,
      CASE
        WHEN e.var_detrended IS NULL OR e.var_detrended = 0 THEN 0.0
        ELSE GREATEST(0.0, 1.0 - e.var_residual / NULLIF(e.var_detrended, 0))
      END AS trendStrength,
      CAST(e.residual_anomalies AS DOUBLE) AS residualAnomalies,
      COALESCE(e.trend_slope, 0.0) AS trendSlope,
      s.seriesJson
    FROM per_entity e
    LEFT JOIN series s USING (query, page)
    ORDER BY seasonalStrength DESC, ABS(COALESCE(e.trend_slope, 0.0)) DESC
    LIMIT ${Number(limit)}
  `

  return {
    sql,
    params: [startDate, endDate, minImpressions],
    current: { table: 'page_keywords', partitions: enumeratePartitions(startDate, endDate) },
    shape: (rows) => {
      const results = rows.map(r => ({
        keyword: str(r.keyword),
        page: str(r.page),
        totalImpressions: num(r.totalImpressions),
        days: num(r.days),
        seasonalStrength: num(r.seasonalStrength),
        trendStrength: num(r.trendStrength),
        residualAnomalies: num(r.residualAnomalies),
        trendSlope: num(r.trendSlope),
        series: parseJsonList(r.seriesJson).map(s => ({
          date: str(s.date),
          observed: num(s.observed),
          trend: s.trend == null ? null : num(s.trend),
          seasonal: s.seasonal == null ? null : num(s.seasonal),
          residual: s.residual == null ? null : num(s.residual),
          anomaly: bool(s.anomaly),
        })),
      }))
      return {
        results,
        meta: {
          total: results.length,
          metric,
          avgSeasonalStrength: results.length > 0
            ? results.reduce((a, r) => a + r.seasonalStrength, 0) / results.length
            : 0,
        },
      }
    },
  }
}

// ---------------------------------------------------------------------------
// change-point
//
// Per-(query, url) timeseries on a target metric (default: avg position).
// Scans candidate split dates and scores each via a Gaussian log-likelihood
// ratio between "single segment" and "two segments". Picks t* = argmax LLR
// per entity; retains entities whose best split crosses a threshold.
// Cumulative stats are derived from window aggregates; right-side totals
// come from subtracting cumulative-left from grand-total.
// ---------------------------------------------------------------------------

function buildChangePoint(params: AnalysisParams): AnalyzerSpec {
  const endDate = params.endDate ?? DEFAULT_END()
  const startDate = params.startDate ?? new Date(Date.now() - 93 * 86400000).toISOString().split('T')[0]
  const minDays = 21
  const minSide = 7
  const threshold = params.threshold ?? 10
  const minImpressions = params.minImpressions ?? 50
  const metric = params.metric === 'clicks' || params.metric === 'impressions' ? params.metric : 'position'
  const limit = params.limit ?? 100

  const valueExpr = metric === 'position'
    ? `SUM(sum_position) / NULLIF(SUM(impressions), 0) + 1`
    : `CAST(SUM(${metric}) AS DOUBLE)`

  const sql = `
    WITH daily AS (
      SELECT
        query,
        url AS page,
        date,
        CAST(SUM(clicks) AS DOUBLE) AS clicks,
        CAST(SUM(impressions) AS DOUBLE) AS impressions,
        ${valueExpr} AS value
      FROM read_parquet({{FILES}}, union_by_name = true)
      WHERE date >= ? AND date <= ?
        AND query IS NOT NULL AND query <> ''
        AND url IS NOT NULL AND url <> ''
      GROUP BY query, url, date
      HAVING SUM(impressions) >= 1
    ),
    entity_stats AS (
      SELECT query, page,
        COUNT(*) AS n_total,
        SUM(impressions) AS total_impressions,
        SUM(value) AS sum_total,
        SUM(value * value) AS sumsq_total
      FROM daily
      GROUP BY query, page
      HAVING COUNT(*) >= ${Number(minDays)}
        AND SUM(impressions) >= ?
    ),
    filtered AS (
      SELECT d.*,
        e.n_total, e.sum_total, e.sumsq_total, e.total_impressions
      FROM daily d
      JOIN entity_stats e USING (query, page)
    ),
    cumulated AS (
      SELECT *,
        COUNT(*) OVER w AS n_left,
        SUM(value) OVER w AS sum_left,
        SUM(value * value) OVER w AS sumsq_left
      FROM filtered
      WINDOW w AS (
        PARTITION BY query, page
        ORDER BY date
        ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
      )
    ),
    llr_scored AS (
      SELECT *,
        (n_total - n_left) AS n_right,
        (sum_total - sum_left) AS sum_right,
        (sumsq_total - sumsq_left) AS sumsq_right,
        GREATEST(
          (sumsq_left / NULLIF(n_left, 0))
            - (sum_left / NULLIF(n_left, 0)) * (sum_left / NULLIF(n_left, 0)),
          1e-9
        ) AS var_left,
        GREATEST(
          ((sumsq_total - sumsq_left) / NULLIF(n_total - n_left, 0))
            - ((sum_total - sum_left) / NULLIF(n_total - n_left, 0))
              * ((sum_total - sum_left) / NULLIF(n_total - n_left, 0)),
          1e-9
        ) AS var_right,
        GREATEST(
          (sumsq_total / NULLIF(n_total, 0))
            - (sum_total / NULLIF(n_total, 0)) * (sum_total / NULLIF(n_total, 0)),
          1e-9
        ) AS var_single
      FROM cumulated
    ),
    llr AS (
      SELECT *,
        CASE
          WHEN n_left >= ${Number(minSide)} AND (n_total - n_left) >= ${Number(minSide)}
          THEN n_total * LN(var_single)
            - n_left * LN(var_left)
            - (n_total - n_left) * LN(var_right)
          ELSE NULL
        END AS llr
      FROM llr_scored
    ),
    best AS (
      SELECT query, page, n_total, total_impressions,
        arg_max(date, llr) AS change_date,
        MAX(llr) AS best_llr,
        arg_max(sum_left / NULLIF(n_left, 0), llr) AS left_mean,
        arg_max((sum_total - sum_left) / NULLIF(n_total - n_left, 0), llr) AS right_mean,
        arg_max(sqrt(var_left), llr) AS left_std,
        arg_max(sqrt(var_right), llr) AS right_std
      FROM llr
      WHERE llr IS NOT NULL
      GROUP BY query, page, n_total, total_impressions
      HAVING MAX(llr) > ${Number(threshold)}
    ),
    series AS (
      SELECT query, page,
        to_json(list({
          'date': strftime(date, '%Y-%m-%d'),
          'value': value
        } ORDER BY date)) AS seriesJson
      FROM daily
      GROUP BY query, page
    )
    SELECT
      b.query AS keyword,
      b.page,
      CAST(b.n_total AS DOUBLE) AS totalDays,
      CAST(b.total_impressions AS DOUBLE) AS totalImpressions,
      strftime(b.change_date, '%Y-%m-%d') AS changeDate,
      b.best_llr AS llr,
      b.left_mean AS leftMean,
      b.right_mean AS rightMean,
      (b.right_mean - b.left_mean) AS delta,
      b.left_std AS leftStddev,
      b.right_std AS rightStddev,
      s.seriesJson
    FROM best b
    LEFT JOIN series s USING (query, page)
    ORDER BY b.best_llr DESC
    LIMIT ${Number(limit)}
  `

  return {
    sql,
    params: [startDate, endDate, minImpressions],
    current: { table: 'page_keywords', partitions: enumeratePartitions(startDate, endDate) },
    shape: (rows) => {
      const lowerIsBetter = metric === 'position'
      const results = rows.map((r) => {
        const delta = num(r.delta)
        const improved = lowerIsBetter ? delta < 0 : delta > 0
        return {
          keyword: str(r.keyword),
          page: str(r.page),
          totalDays: num(r.totalDays),
          totalImpressions: num(r.totalImpressions),
          changeDate: str(r.changeDate),
          llr: num(r.llr),
          leftMean: num(r.leftMean),
          rightMean: num(r.rightMean),
          delta,
          leftStddev: num(r.leftStddev),
          rightStddev: num(r.rightStddev),
          direction: (improved ? 'improved' : 'worsened') as 'improved' | 'worsened',
          series: parseJsonList(r.seriesJson).map(s => ({
            date: str(s.date),
            value: num(s.value),
          })),
        }
      })
      return {
        results,
        meta: {
          total: results.length,
          metric,
          threshold,
          improved: results.filter(r => r.direction === 'improved').length,
          worsened: results.filter(r => r.direction === 'worsened').length,
        },
      }
    },
  }
}

// ---------------------------------------------------------------------------
// survival (Kaplan-Meier)
//
// Models "keyword survival in top-10". An episode starts the first day a
// (query, url) daily avg position drops to ≤10; it ends the first day
// position rises above 10 (simpler than the 3-day grace rule — a single bad
// day is rare enough at the daily-aggregate level to still give a clean
// tenure signal, and it avoids a windowed state machine in SQL). If the run
// reaches window_end - 2, the episode is censored (still alive).
//
// KM cumulative product is computed via EXP(SUM(LN(...)) OVER ...) — DuckDB
// has no CUMPROD, but running sums of logs with GREATEST(.., 1e-9) give the
// same result without any host-side math.
// ---------------------------------------------------------------------------

function buildSurvival(params: AnalysisParams): AnalyzerSpec {
  const endDate = params.endDate ?? DEFAULT_END()
  const startDate = params.startDate
    ?? new Date(Date.now() - 183 * 86400000).toISOString().split('T')[0]
  const minImpressions = params.minImpressions ?? 5
  const positionThreshold = 10

  const sql = `
    WITH daily AS (
      SELECT
        query,
        url,
        date,
        CAST(SUM(clicks) AS DOUBLE) AS day_clicks,
        CAST(SUM(impressions) AS DOUBLE) AS day_impressions,
        SUM(sum_position) / NULLIF(SUM(impressions), 0) + 1 AS day_position
      FROM read_parquet({{FILES}}, union_by_name = true)
      WHERE date >= ? AND date <= ?
        AND query IS NOT NULL AND query <> ''
        AND url IS NOT NULL AND url <> ''
      GROUP BY query, url, date
      HAVING SUM(impressions) >= ?
    ),
    classified AS (
      SELECT *,
        (day_position <= ${positionThreshold}) AS in_top10
      FROM daily
    ),
    transitions AS (
      SELECT *,
        CASE
          WHEN in_top10 AND (LAG(in_top10) OVER w IS NULL OR NOT LAG(in_top10) OVER w)
            THEN 1 ELSE 0
        END AS is_entry
      FROM classified
      WINDOW w AS (PARTITION BY query, url ORDER BY date)
    ),
    run_ids AS (
      SELECT *,
        SUM(is_entry) OVER (PARTITION BY query, url ORDER BY date) AS run_id
      FROM transitions
      WHERE in_top10
    ),
    window_bounds AS (
      SELECT MIN(date) AS window_start, MAX(date) AS window_end FROM daily
    ),
    episodes_raw AS (
      SELECT
        query, url, run_id,
        MIN(date) AS entry_date,
        MAX(date) AS exit_date,
        DATEDIFF('day', MIN(date), MAX(date)) + 1 AS tenure
      FROM run_ids
      GROUP BY query, url, run_id
    ),
    episodes AS (
      SELECT
        e.query, e.url, e.run_id, e.entry_date, e.exit_date, e.tenure,
        (e.exit_date >= wb.window_end - INTERVAL 2 DAY) AS censored,
        CASE
          WHEN regexp_extract(e.url, '^(?:https?://[^/]+)?(/[^/?#]*)', 1) = '/' OR e.url = '/'
            THEN 'home'
          WHEN regexp_extract(e.url, '^(?:https?://[^/]+)?/([^/?#]+)', 1) = ''
            THEN 'home'
          ELSE regexp_extract(e.url, '^(?:https?://[^/]+)?/([^/?#]+)', 1)
        END AS cohort
      FROM episodes_raw e
      CROSS JOIN window_bounds wb
    ),
    episodes_all AS (
      SELECT query, url, tenure, censored, cohort FROM episodes
      UNION ALL
      SELECT query, url, tenure, censored, '__all__' AS cohort FROM episodes
    ),
    cohort_totals AS (
      SELECT cohort, COUNT(*) AS n_total
      FROM episodes_all
      GROUP BY cohort
    ),
    events AS (
      SELECT
        cohort,
        tenure,
        COUNT(*) FILTER (WHERE NOT censored) AS d_t,
        COUNT(*) AS n_ending_at_t
      FROM episodes_all
      GROUP BY cohort, tenure
    ),
    km AS (
      SELECT
        e.cohort,
        e.tenure,
        e.d_t,
        e.n_ending_at_t,
        SUM(e.n_ending_at_t) OVER (PARTITION BY e.cohort ORDER BY e.tenure DESC
          ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS at_risk
      FROM events e
    ),
    km_surv AS (
      SELECT
        cohort, tenure, d_t, at_risk,
        EXP(SUM(LN(GREATEST(1.0 - CAST(d_t AS DOUBLE) / NULLIF(at_risk, 0), 1e-9)))
          OVER (PARTITION BY cohort ORDER BY tenure
            ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW)) AS survival
      FROM km
    ),
    curve_agg AS (
      SELECT
        cohort,
        to_json(list({
          'tenure': tenure,
          'survival': survival,
          'atRisk': at_risk,
          'events': d_t
        } ORDER BY tenure)) AS curveJson
      FROM km_surv
      GROUP BY cohort
    ),
    cohort_stats AS (
      SELECT
        ea.cohort,
        COUNT(*) AS episode_count,
        AVG(CASE WHEN ea.censored THEN 1.0 ELSE 0.0 END) AS censoring_rate
      FROM episodes_all ea
      GROUP BY ea.cohort
    )
    SELECT
      cs.cohort,
      cs.episode_count AS episodeCount,
      cs.censoring_rate AS censoringRate,
      ca.curveJson
    FROM cohort_stats cs
    LEFT JOIN curve_agg ca USING (cohort)
    ORDER BY cs.cohort
  `

  return {
    sql,
    params: [startDate, endDate, minImpressions],
    current: { table: 'page_keywords', partitions: enumeratePartitions(startDate, endDate) },
    shape: (rows) => {
      const windowDays
        = Math.round((new Date(endDate).getTime() - new Date(startDate).getTime()) / 86400000) + 1

      const results = rows.map((r) => {
        const curve = parseJsonList(r.curveJson).map(p => ({
          tenure: num(p.tenure),
          survival: num(p.survival),
          atRisk: num(p.atRisk),
          events: num(p.events),
        }))

        // Median tenure via linear interpolation at S = 0.5.
        let medianTenure = 0
        for (let i = 0; i < curve.length; i++) {
          if (curve[i].survival <= 0.5) {
            if (i === 0) {
              medianTenure = curve[i].tenure
            }
            else {
              const prev = curve[i - 1]
              const cur = curve[i]
              const span = prev.survival - cur.survival
              const frac = span > 0 ? (prev.survival - 0.5) / span : 0
              medianTenure = prev.tenure + frac * (cur.tenure - prev.tenure)
            }
            break
          }
        }
        // If survival never dips to 0.5, report the max observed tenure as a
        // lower bound (episode population is too censored to resolve median).
        if (medianTenure === 0 && curve.length > 0 && curve[curve.length - 1].survival > 0.5)
          medianTenure = curve[curve.length - 1].tenure

        return {
          cohort: str(r.cohort),
          episodeCount: num(r.episodeCount),
          censoringRate: num(r.censoringRate),
          medianTenure,
          curve,
        }
      })

      const ungrouped = results.find(r => r.cohort === '__all__')
      const totalEpisodes = ungrouped?.episodeCount ?? 0

      return {
        results,
        meta: {
          totalEpisodes,
          cohortCount: results.filter(r => r.cohort !== '__all__').length,
          windowDays,
        },
      }
    },
  }
}

// ---------------------------------------------------------------------------
// bipartite-pagerank
//
// Personalized PageRank on the (query <-> url) bipartite graph, edge-weighted
// by impressions. Each power-iteration "step" is two half-steps: queries
// receive mass from URLs, then URLs receive mass from queries. We express
// the fixed-N iteration as a chain of CTEs built programmatically (bounded
// unroll). This sidesteps DuckDB's recursive-CTE restriction on aggregate
// functions over the recursive reference; the natural formulation needs
// SUM(prev.rank * weight) GROUP BY node_id, which recursive CTEs reject.
//
// "Hub queries" bridge many URLs with roughly-even mass distribution;
// "hub URLs" anchor many queries the same way. Rank is eigenvector
// centrality: a node is important if it links to other important nodes.
// ---------------------------------------------------------------------------

const BIPARTITE_PAGERANK_ITERATIONS = 25
const BIPARTITE_PAGERANK_DAMPING = 0.85

function buildBipartitePageRank(params: AnalysisParams): AnalyzerSpec {
  const { startDate, endDate } = period(params)
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
    current: { table: 'page_keywords', partitions: enumeratePartitions(startDate, endDate) },
    shape: (rows) => {
      const results = rows.map(r => ({
        kind: str(r.kind) as 'query' | 'url',
        id: str(r.id),
        rank: num(r.rank),
        bridging: num(r.bridging),
        anchoring: num(r.anchoring),
        degree: num(r.degree),
        impressions: num(r.impressions),
      }))
      const first = rows[0] ?? {}
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
  }
}

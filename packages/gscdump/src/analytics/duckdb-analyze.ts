// DuckDB-native analyzers. Collocated with the DuckDB adapter so each tool can
// exploit DuckDB-specific features (regexp_extract, list_slice, STDDEV_POP,
// struct_pack, ...) without forcing other backends to match. All aggregation,
// scoring, and ranking pushed into SQL; the shape functions only re-pack the
// result rows into the driver's AnalysisResult envelope.

import type { AnalysisParams, AnalysisResult } from '../driver/types'
import type { DuckDBFactory } from './duckdb'
import type { DataSource, ManifestStore, Row, TableName, TenantCtx } from './storage'
import { enumeratePartitions } from './compaction'
import { substituteNamedFiles } from './resolver'

export class AnalyzerUnsupportedError extends Error {
  constructor(tool: string) {
    super(`analyzer "${tool}" is not supported by the DuckDB backend`)
    this.name = 'AnalyzerUnsupportedError'
  }
}

export interface DuckDBAnalyzeDeps {
  factory: DuckDBFactory
  dataSource: DataSource
  manifestStore: ManifestStore
}

interface FileSet {
  table: TableName
  partitions: string[]
}

interface AnalyzerSpec {
  sql: string
  params: unknown[]
  current: FileSet
  previous?: FileSet
  shape: (rows: Row[], params: AnalysisParams) => { results: Row[], meta: Record<string, unknown> }
}

export async function analyzeWithDuckDB(
  deps: DuckDBAnalyzeDeps,
  ctx: TenantCtx,
  params: AnalysisParams,
): Promise<AnalysisResult> {
  const spec = buildSpec(params)

  const curFiles = await loadFiles(deps, ctx, spec.current)
  const prevFiles = spec.previous ? await loadFiles(deps, ctx, spec.previous) : []

  const placeholders: Record<string, string[]> = {
    FILES: curFiles.map(f => f.key),
  }
  if (spec.previous)
    placeholders.FILES_PREV = prevFiles.map(f => f.key)

  const finalSql = substituteNamedFiles(spec.sql, placeholders)

  const db = await deps.factory.getDuckDB()
  const allFiles = [...curFiles, ...prevFiles]
  const names = allFiles.map(f => f.key)
  try {
    for (const f of allFiles)
      await db.registerFileBuffer(f.key, f.bytes)
    const rows = await db.query(finalSql, spec.params)
    const { results, meta } = spec.shape(rows, params)
    return {
      results: results as unknown as Record<string, unknown>[],
      meta: { tool: params.type, source: 'local', ...meta },
    }
  }
  finally {
    await db.dropFiles(names)
  }
}

async function loadFiles(
  deps: DuckDBAnalyzeDeps,
  ctx: TenantCtx,
  fs: FileSet,
): Promise<Array<{ key: string, bytes: Uint8Array }>> {
  const entries = await deps.manifestStore.listLive({
    userId: ctx.userId,
    siteId: ctx.siteId,
    table: fs.table,
    partitions: fs.partitions,
  })
  return Promise.all(entries.map(async e => ({
    key: e.objectKey,
    bytes: await deps.dataSource.read(e.objectKey),
  })))
}

function buildSpec(params: AnalysisParams): AnalyzerSpec {
  switch (params.type) {
    case 'striking-distance':
      return buildStrikingDistance(params)
    case 'opportunity':
      return buildOpportunity(params)
    case 'brand':
      return buildBrand(params)
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

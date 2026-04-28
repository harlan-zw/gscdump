/**
 * `clustering` — groups keywords by intent prefix or common word prefix. SQL
 * does intent/prefix extraction inline via `regexp_extract` + array slicing
 * and aggregates per cluster name. Row reducer mirrors the same semantics in
 * pure JS, partitioning a keyword stream into intent-first then prefix-fill
 * clusters. Result shapes are kept distinct only at the meta level (SQL adds
 * `total`); both paths emit the same `KeywordCluster[]`.
 */

import type { Row } from '@gscdump/engine/contracts'
import type { KeywordRow } from '../types'
import type { AnalysisParams } from '@gscdump/engine/analysis-types'
import { enumeratePartitions } from '@gscdump/engine/planner'
import { METRIC_EXPR } from '@gscdump/engine/sql-fragments'
import { keywordsQueryState } from '../analyzer/adapt-rows'
import { defineAnalyzer } from '@gscdump/engine/analyzer'
import { periodOf } from '@gscdump/engine/period'
import { num } from '@gscdump/engine/analysis-types'

export type ClusterType = 'prefix' | 'intent' | 'both'

export interface ClusteringOptions {
  /** Minimum keywords for a cluster to be reported. Default: 2 */
  minClusterSize?: number
  /** Minimum impressions for a keyword to be included. Default: 10 */
  minImpressions?: number
  /** Clustering method. Default: 'both' */
  clusterBy?: ClusterType
}

export interface KeywordCluster {
  clusterName: string
  clusterType: 'prefix' | 'intent'
  keywords: KeywordRow[]
  totalClicks: number
  totalImpressions: number
  avgPosition: number
  keywordCount: number
}

export interface ClusteringResult {
  clusters: KeywordCluster[]
  unclustered: KeywordRow[]
}

const INTENT_PREFIXES_REGEX
  = '^(how to|what is|what are|why is|why do|where to|when to|best|top|vs|versus|compare|review|buy|cheap|free|near me)(\\s|$)'

const INTENT_PREFIXES = [
  'how to',
  'what is',
  'what are',
  'why is',
  'why do',
  'where to',
  'when to',
  'best',
  'top',
  'vs',
  'versus',
  'compare',
  'review',
  'buy',
  'cheap',
  'free',
  'near me',
]

const WHITESPACE_RE = /\s+/

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

function extractIntentPrefix(keyword: string): string | null {
  const lower = keyword.toLowerCase()
  for (const prefix of INTENT_PREFIXES) {
    if (lower.startsWith(`${prefix} `) || lower.startsWith(prefix))
      return prefix
  }
  return null
}

function extractWordPrefix(keyword: string, wordCount = 2): string | null {
  const words = keyword.toLowerCase().split(WHITESPACE_RE).filter(Boolean)
  if (words.length < wordCount + 1)
    return null
  return words.slice(0, wordCount).join(' ')
}

/**
 * Pure helper: clusters keywords by intent prefix or common word prefix.
 * Re-exported from `@gscdump/analysis` for portable callers.
 */
export function analyzeClustering(
  keywords: KeywordRow[],
  options: ClusteringOptions = {},
): ClusteringResult {
  const {
    minClusterSize = 2,
    minImpressions = 10,
    clusterBy = 'both',
  } = options

  const filtered = keywords.filter(k => num(k.impressions) >= minImpressions)

  const clusterMap = new Map<string, { type: 'prefix' | 'intent', keywords: KeywordRow[] }>()
  const clusteredKeywords = new Set<string>()

  if (clusterBy === 'intent' || clusterBy === 'both') {
    for (const kw of filtered) {
      const intent = extractIntentPrefix(kw.query)
      if (intent) {
        const existing = clusterMap.get(intent)
        if (existing) {
          existing.keywords.push(kw)
        }
        else {
          clusterMap.set(intent, { type: 'intent', keywords: [kw] })
        }
        clusteredKeywords.add(kw.query)
      }
    }
  }

  if (clusterBy === 'prefix' || clusterBy === 'both') {
    const unclustered = filtered.filter(kw => !clusteredKeywords.has(kw.query))
    const prefixMap = new Map<string, KeywordRow[]>()

    for (const kw of unclustered) {
      const prefix = extractWordPrefix(kw.query)
      if (prefix) {
        const existing = prefixMap.get(prefix)
        if (existing)
          existing.push(kw)
        else
          prefixMap.set(prefix, [kw])
      }
    }

    for (const [prefix, kws] of prefixMap) {
      if (kws.length >= minClusterSize) {
        clusterMap.set(prefix, { type: 'prefix', keywords: kws })
        kws.forEach(kw => clusteredKeywords.add(kw.query))
      }
    }
  }

  const clusters: KeywordCluster[] = []
  for (const [name, data] of clusterMap) {
    if (data.keywords.length < minClusterSize)
      continue

    const totalClicks = data.keywords.reduce((sum, k) => sum + num(k.clicks), 0)
    const totalImpressions = data.keywords.reduce((sum, k) => sum + num(k.impressions), 0)
    const avgPosition = data.keywords.reduce((sum, k) => sum + num(k.position), 0) / data.keywords.length

    clusters.push({
      clusterName: name,
      clusterType: data.type,
      keywords: data.keywords,
      totalClicks,
      totalImpressions,
      avgPosition,
      keywordCount: data.keywords.length,
    })
  }

  clusters.sort((a, b) => b.totalClicks - a.totalClicks)

  const unclustered = filtered.filter(kw => !clusteredKeywords.has(kw.query))

  return { clusters, unclustered }
}

export const clusteringAnalyzer = defineAnalyzer<AnalysisParams, Row, KeywordCluster[]>({
  id: 'clustering',

  buildSql(params) {
    const { startDate, endDate } = periodOf(params)
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
          ${METRIC_EXPR.clicks} AS clicks,
          ${METRIC_EXPR.impressions} AS impressions,
          ${METRIC_EXPR.ctr} AS ctr,
          ${METRIC_EXPR.position} AS position
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
        ${METRIC_EXPR.clicks} AS totalClicks,
        ${METRIC_EXPR.impressions} AS totalImpressions,
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
    }
  },

  reduceSql(rows) {
    const arr = Array.isArray(rows) ? rows : []
    const clusters: KeywordCluster[] = arr.map(r => ({
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
      })) as unknown as KeywordRow[],
    }))
    return {
      results: clusters,
      meta: { total: clusters.length, totalClusters: clusters.length },
    }
  },

  buildRows(params) {
    return {
      keywords: keywordsQueryState(periodOf(params), params.limit),
    }
  },

  reduceRows(rows, params) {
    const keywords = (Array.isArray(rows) ? rows : []) as unknown as KeywordRow[]
    const result = analyzeClustering(keywords, {
      clusterBy: params.clusterBy,
      minClusterSize: params.minClusterSize,
      minImpressions: params.minImpressions,
    })
    return {
      results: result.clusters,
      meta: { totalClusters: result.clusters.length },
    }
  },
})

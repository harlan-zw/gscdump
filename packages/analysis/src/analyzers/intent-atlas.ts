/**
 * intent-atlas
 *
 * Token-cooccurrence clustering. Tokenizes queries via regexp_split_to_array
 * + unnest, deduplicates tokens per query, drops stop-words and short tokens,
 * weights tokens by smooth IDF specificity (`LN(1 + impressions) * (LN((N + 1)
 * / (df + 1)) + 1)`) so site-wide boilerplate terms do not swallow unrelated
 * topics, then clusters each query by its top-2 highest-scoring tokens (sorted
 * + joined as the cluster key).
 */

import type { AnalysisParams } from '@gscdump/engine/analysis-types'
import type { Row } from '@gscdump/engine/contracts'
import { num } from '@gscdump/engine/analysis-types'
import { defineAnalyzer } from '@gscdump/engine/analyzer'
import { defaultEndDate } from '@gscdump/engine/period'
import { enumeratePartitions } from '@gscdump/engine/planner'
import { METRIC_EXPR } from '@gscdump/engine/sql-fragments'
import { daysAgoUtc as daysAgo } from 'gscdump/dates'
import { parseJsonRows as parseJsonList, rowString as str } from '../analyzer/row-values'
import { normalizeQuery } from '../query/normalize'

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

export interface IntentAtlasResult {
  clusterKey: string
  keywordCount: number
  totalImpressions: number
  totalClicks: number
  ctr: number
  avgPosition: number
  keywords: Array<{ query: string, impressions: number, clicks: number, position: number }>
}

const INTENT_ATLAS_STOP_WORD_SET = new Set(INTENT_ATLAS_STOP_WORDS)
const WHITESPACE_RE = /\s+/

function resolveMinTokenImpressions(params: AnalysisParams, minQueryImpressions: number, minClusterSize: number): number {
  return params.minImpressions !== undefined
    ? Math.min(50, minQueryImpressions * minClusterSize)
    : 50
}

function reduceCanonicalIntentAtlas(
  rows: Row[],
  options: { minClusterSize: number, minTokenImpressions: number, limit: number },
): IntentAtlasResult[] {
  const { minClusterSize, minTokenImpressions, limit } = options
  const queries = rows.map(r => ({
    query: str(r.query),
    impressions: num(r.impressions),
    clicks: num(r.clicks),
    position: num(r.position),
  }))
  const totalQueries = queries.length
  if (totalQueries === 0)
    return []

  const queryTokens: string[][] = []
  const tokenStats = new Map<string, { impressions: number, queryCount: number }>()

  for (const q of queries) {
    const normalized = normalizeQuery(q.query) || q.query.toLowerCase()
    const seen = new Set<string>()
    for (const token of normalized.split(WHITESPACE_RE)) {
      if (token.length < 3 || INTENT_ATLAS_STOP_WORD_SET.has(token) || seen.has(token))
        continue
      seen.add(token)
      const stat = tokenStats.get(token) ?? { impressions: 0, queryCount: 0 }
      stat.impressions += q.impressions
      stat.queryCount += 1
      tokenStats.set(token, stat)
    }
    queryTokens.push([...seen])
  }

  const tokenWeights = new Map<string, { score: number, impressions: number }>()
  for (const [token, stat] of tokenStats) {
    if (stat.impressions >= minTokenImpressions && stat.queryCount >= minClusterSize) {
      const score = Math.log(1 + stat.impressions) * (Math.log((totalQueries + 1) / (stat.queryCount + 1)) + 1)
      tokenWeights.set(token, { score, impressions: stat.impressions })
    }
  }

  const grouped = new Map<string, Array<{ query: string, impressions: number, clicks: number, position: number }>>()
  for (let i = 0; i < queries.length; i++) {
    const candidates = queryTokens[i]!.filter(t => tokenWeights.has(t))
    if (candidates.length < 2)
      continue
    candidates.sort((a, b) => {
      const wa = tokenWeights.get(a)!
      const wb = tokenWeights.get(b)!
      return wb.score - wa.score || wb.impressions - wa.impressions || (a < b ? -1 : a > b ? 1 : 0)
    })
    const top2 = candidates.slice(0, 2).sort()
    const key = `${top2[0]} + ${top2[1]}`
    const list = grouped.get(key)
    if (list)
      list.push(queries[i]!)
    else
      grouped.set(key, [queries[i]!])
  }

  const clusters: IntentAtlasResult[] = []
  for (const [clusterKey, members] of grouped) {
    if (members.length < minClusterSize)
      continue
    members.sort((a, b) => b.impressions - a.impressions || b.clicks - a.clicks || a.query.localeCompare(b.query))
    let totalImpressions = 0
    let totalClicks = 0
    let weightedPositionSum = 0
    for (const m of members) {
      totalImpressions += m.impressions
      totalClicks += m.clicks
      weightedPositionSum += (m.position - 1) * m.impressions
    }
    clusters.push({
      clusterKey,
      keywordCount: members.length,
      totalImpressions,
      totalClicks,
      ctr: totalImpressions > 0 ? totalClicks / totalImpressions : 0,
      avgPosition: totalImpressions > 0 ? weightedPositionSum / totalImpressions + 1 : 0,
      keywords: members.slice(0, 25),
    })
  }

  clusters.sort((a, b) => b.totalImpressions - a.totalImpressions || b.keywordCount - a.keywordCount || a.clusterKey.localeCompare(b.clusterKey))
  return clusters.slice(0, limit)
}

export const intentAtlasAnalyzer = defineAnalyzer<AnalysisParams, Row, IntentAtlasResult[]>({
  id: 'intent-atlas',

  buildSql(params) {
    const endDate = params.endDate ?? defaultEndDate()
    const startDate = params.startDate ?? daysAgo(90)
    const minQueryImpressions = params.minImpressions ?? 20
    const minClusterSize = params.minClusterSize ?? 3
    const minTokenImpressions = resolveMinTokenImpressions(params, minQueryImpressions, minClusterSize)
    const limit = params.limit ?? 200

    if (params.canonical) {
      const sql = `
        SELECT
          query,
          ${METRIC_EXPR.impressions} AS impressions,
          ${METRIC_EXPR.clicks} AS clicks,
          ${METRIC_EXPR.position} AS position
        FROM read_parquet({{FILES}}, union_by_name = true)
        WHERE date >= ? AND date <= ?
          AND query IS NOT NULL AND query <> ''
        GROUP BY query
        HAVING SUM(impressions) >= ?
      `
      return {
        sql,
        params: [startDate, endDate, minQueryImpressions],
        current: { table: 'queries', partitions: enumeratePartitions(startDate, endDate) },
      }
    }

    const stopList = INTENT_ATLAS_STOP_WORDS.map(w => `'${w}'`).join(', ')

    const sql = `
    WITH queries AS (
      SELECT
        query,
        ${METRIC_EXPR.impressions} AS impressions,
        ${METRIC_EXPR.clicks} AS clicks,
        ${METRIC_EXPR.position} AS position
      FROM read_parquet({{FILES}}, union_by_name = true)
      WHERE date >= ? AND date <= ?
        AND query IS NOT NULL AND query <> ''
      GROUP BY query
      HAVING SUM(impressions) >= ?
    ),
    query_total AS (
      SELECT CAST(COUNT(*) AS DOUBLE) AS total_queries
      FROM queries
    ),
    tokens AS (
      SELECT DISTINCT q.query, q.impressions,
        t.token AS token
      FROM queries q,
        unnest(regexp_split_to_array(LOWER(q.query), '\\s+')) AS t(token)
      WHERE LENGTH(t.token) >= 3
        AND t.token NOT IN (${stopList})
    ),
    token_weights AS (
      SELECT t.token,
        SUM(t.impressions) AS token_impressions,
        COUNT(*) AS query_count,
        LN(1.0 + SUM(t.impressions)) * (LN((qt.total_queries + 1.0) / (COUNT(*) + 1.0)) + 1.0) AS token_score
      FROM tokens t, query_total qt
      GROUP BY t.token, qt.total_queries
      HAVING SUM(t.impressions) >= ${Number(minTokenImpressions)}
        AND COUNT(*) >= ${Number(minClusterSize)}
    ),
    ranked_tokens AS (
      SELECT t.query, t.token, tw.token_score, tw.token_impressions,
        ROW_NUMBER() OVER (
          PARTITION BY t.query
          ORDER BY tw.token_score DESC, tw.token_impressions DESC, t.token ASC
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
      SUM((position - 1) * impressions) / NULLIF(SUM(impressions), 0) + 1 AS avgPosition,
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
      current: { table: 'queries', partitions: enumeratePartitions(startDate, endDate) },
    }
  },

  reduceSql(rows, params) {
    const arr = Array.isArray(rows) ? rows : []
    if (params.canonical) {
      const minQueryImpressions = params.minImpressions ?? 20
      const minClusterSize = params.minClusterSize ?? 3
      const minTokenImpressions = resolveMinTokenImpressions(params, minQueryImpressions, minClusterSize)
      const limit = params.limit ?? 200
      const clusters = reduceCanonicalIntentAtlas(arr, { minClusterSize, minTokenImpressions, limit })
      const totalImpressions = clusters.reduce((s, c) => s + c.totalImpressions, 0)
      const totalKeywords = clusters.reduce((s, c) => s + c.keywordCount, 0)
      return {
        results: clusters,
        meta: { total: clusters.length, totalImpressions, totalKeywords },
      }
    }
    const clusters = arr.map(r => ({
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
})

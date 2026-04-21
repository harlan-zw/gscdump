/**
 * intent-atlas
 *
 * Token-cooccurrence clustering. Tokenizes queries via regexp_split_to_array
 * + unnest, drops stop-words and short tokens, weights tokens by impressions,
 * then clusters each query by its top-2 highest-impression tokens (sorted +
 * joined as the cluster key). Two queries with no shared prefix end up in
 * the same cluster as long as they share their two most meaningful tokens —
 * "best vue components" + "components for vue beginners" both cluster on
 * "components + vue".
 */

import type { AnalysisParams, AnalyzerSpec } from '../shared'

import { enumeratePartitions } from '@gscdump/engine/planner'
import { DEFAULT_END, num, parseJsonList, str } from '../shared'

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

export function buildIntentAtlas(params: AnalysisParams): AnalyzerSpec {
  const endDate = params.endDate ?? DEFAULT_END()
  const startDate = params.startDate ?? new Date(Date.now() - 90 * 86400000).toISOString().split('T')[0]!
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

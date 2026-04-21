import type { AnalysisParams, AnalyzerSpec } from '../shared'

import { enumeratePartitions } from '@gscdump/engine/planner'
import { num, parseJsonList, period, str } from '../shared'

const INTENT_PREFIXES_REGEX
  = '^(how to|what is|what are|why is|why do|where to|when to|best|top|vs|versus|compare|review|buy|cheap|free|near me)(\\s|$)'

export function buildClustering(params: AnalysisParams): AnalyzerSpec {
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

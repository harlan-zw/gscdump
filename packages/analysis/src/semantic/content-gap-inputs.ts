import type { QueryRow } from '@gscdump/engine/source'

export interface ContentGapQueryCandidate {
  query: string
  impressions: number
  clicks: number
  avgPosition: number
  currentUrl: string
}

interface ContentGapInputOptions {
  maxQueries: number
  maxUrls: number
  minImpressions: number
}

type ExecuteSql = (sql: string, params?: unknown[]) => Promise<QueryRow[]>
type NormalizeUrl = (url: string) => string

export async function fetchContentGapInputs(
  executeSql: ExecuteSql,
  options: ContentGapInputOptions,
  normalizeUrl: NormalizeUrl,
  now: () => number = () => performance.now(),
): Promise<{ queries: ContentGapQueryCandidate[], urls: string[], sqlMs: number }> {
  const t1 = now()
  const queryRows = await executeSql(`
    WITH query_totals AS (
      SELECT query,
        SUM(impressions)::BIGINT AS total_impressions,
        SUM(clicks)::BIGINT AS total_clicks,
        SUM(sum_position) / NULLIF(SUM(impressions), 0) + 1 AS avg_position
      FROM main.page_queries
      WHERE query IS NOT NULL AND query <> ''
      GROUP BY query
      HAVING SUM(impressions) >= ?
      ORDER BY total_impressions DESC
      LIMIT ?
    ),
    per_query_url AS (
      SELECT pk.query, pk.url,
        SUM(pk.impressions)::BIGINT AS url_impressions,
        SUM(pk.sum_position) / NULLIF(SUM(pk.impressions), 0) + 1 AS url_position,
        ROW_NUMBER() OVER (PARTITION BY pk.query ORDER BY SUM(pk.impressions) DESC) AS rnk
      FROM main.page_queries pk
      JOIN query_totals qt USING (query)
      WHERE pk.url IS NOT NULL AND pk.url <> ''
      GROUP BY pk.query, pk.url
    )
    SELECT q.query, q.total_impressions AS impressions, q.total_clicks AS clicks, q.avg_position,
      pu.url AS current_url, pu.url_position AS current_position
    FROM query_totals q
    JOIN per_query_url pu USING (query)
    WHERE pu.rnk = 1
  `, [Number(options.minImpressions), Number(options.maxQueries)])

  const urlRows = await executeSql(`
    SELECT url, SUM(impressions)::BIGINT AS impressions
    FROM main.page_queries
    WHERE url IS NOT NULL AND url <> ''
    GROUP BY url
    ORDER BY impressions DESC
    LIMIT ?
  `, [Number(options.maxUrls)])
  const sqlMs = now() - t1

  const queries = queryRows.map(row => ({
    query: String(row.query),
    impressions: Number(row.impressions),
    clicks: Number(row.clicks),
    avgPosition: Number(row.avg_position),
    currentUrl: normalizeUrl(String(row.current_url)),
  }))

  const urlAgg = new Map<string, number>()
  for (const row of urlRows) {
    const norm = normalizeUrl(String(row.url))
    urlAgg.set(norm, (urlAgg.get(norm) ?? 0) + Number(row.impressions))
  }
  const urls = [...urlAgg.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, Number(options.maxUrls))
    .map(([url]) => url)

  return { queries, urls, sqlMs }
}

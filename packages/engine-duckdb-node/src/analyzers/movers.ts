import type { AnalysisParams, AnalyzerSpec } from '../shared'

import { enumeratePartitions } from '@gscdump/engine/planner'
import { num, parseJsonList, period, previous, str } from '../shared'

export function buildMovers(params: AnalysisParams): AnalyzerSpec {
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

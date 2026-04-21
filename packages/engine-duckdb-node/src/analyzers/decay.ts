import type { AnalysisParams, AnalyzerSpec } from '../shared'

import { enumeratePartitions } from '@gscdump/engine/planner'
import { num, parseJsonList, period, previous, str } from '../shared'

export function buildDecay(params: AnalysisParams): AnalyzerSpec {
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

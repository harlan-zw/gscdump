/**
 * `decay` — flags pages that lost significant clicks vs the previous period.
 * Comparison analyzer: both paths consume `current` / `previous` page rows.
 * SQL adds a per-page weekly sparkline (`series`) by UNION-ing both file sets;
 * the row reducer omits `series` (matches existing live-GSC behavior).
 */

import type { Row } from '@gscdump/engine/contracts'
import type { AnalysisParams, PageRow } from '../types'
import { enumeratePartitions } from '@gscdump/engine/planner'
import { METRIC_EXPR } from '@gscdump/engine/sql-fragments'
import { pagesQueryState } from '../analyzer/adapt-rows'
import { defineAnalyzer } from '../analyzer/define'
import { comparisonOf } from '../period'
import { buildPeriodMap, createMetricSorter, num } from '../types'

export type DecaySortMetric = 'lostClicks' | 'declinePercent' | 'currentClicks'

export interface DecayOptions {
  /** Minimum clicks in previous period to consider. Default: 50 */
  minPreviousClicks?: number
  /** Minimum decline percentage (0-1). Default: 0.2 (20%) */
  threshold?: number
  /** Metric to sort results by. Default: lostClicks */
  sortBy?: DecaySortMetric
}

export interface DecayInput {
  current: PageRow[]
  previous: PageRow[]
}

export interface DecaySeriesPoint {
  week: string
  clicks: number
  impressions: number
}

export interface DecayResult {
  page: string
  currentClicks: number
  previousClicks: number
  lostClicks: number
  declinePercent: number
  currentPosition: number
  previousPosition: number
  positionDrop: number
  series?: DecaySeriesPoint[]
}

const sortResults = createMetricSorter<DecayResult, DecaySortMetric>('lostClicks', {
  lostClicks: 'desc',
  declinePercent: 'desc',
  currentClicks: 'asc',
})

function str(v: unknown): string {
  return v == null ? '' : String(v)
}

function parseJsonList(v: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(v))
    return v as Array<Record<string, unknown>>
  if (typeof v === 'string' && v.length > 0) {
    const parsed = JSON.parse(v)
    return Array.isArray(parsed) ? parsed : []
  }
  return []
}

/**
 * Pure helper: identify "decaying" content — pages that have lost
 * significant traffic between two periods.
 */
export function analyzeDecay(
  input: DecayInput,
  options: DecayOptions = {},
): DecayResult[] {
  const {
    minPreviousClicks = 50,
    threshold = 0.2,
    sortBy = 'lostClicks',
  } = options

  const currentMap = buildPeriodMap(
    input.current,
    r => r.page,
    r => ({ clicks: num(r.clicks), position: num(r.position) }),
  )

  const previousMap = buildPeriodMap(
    input.previous,
    r => r.page,
    r => ({ clicks: num(r.clicks), position: num(r.position) }),
    r => num(r.clicks) >= minPreviousClicks,
  )

  const results: DecayResult[] = []

  for (const [page, prev] of previousMap) {
    const curr = currentMap.get(page) || { clicks: 0, position: 0 }

    const lostClicks = prev.clicks - curr.clicks
    const declinePercent = prev.clicks > 0 ? lostClicks / prev.clicks : 0

    if (declinePercent >= threshold && lostClicks > 0) {
      results.push({
        page,
        currentClicks: curr.clicks,
        previousClicks: prev.clicks,
        lostClicks,
        declinePercent,
        currentPosition: curr.position,
        previousPosition: prev.position,
        positionDrop: curr.position - prev.position,
      })
    }
  }

  return sortResults(results, sortBy)
}

export const decayAnalyzer = defineAnalyzer<AnalysisParams, Row, DecayResult[]>({
  id: 'decay',

  buildSql(params) {
    const { current: cur, previous: prev } = comparisonOf(params)
    const minPreviousClicks = params.minPreviousClicks ?? 50
    const threshold = params.threshold ?? 0.2
    const limit = params.limit ?? 2000

    // weekly: union both file sets for a per-page weekly sparkline that spans
    // prev_start → cur_end (with any between-period gap rendered as `·` at UI time).
    const sql = `
      WITH cur AS (
        SELECT
          url,
          ${METRIC_EXPR.clicks} AS clicks,
          ${METRIC_EXPR.position} AS position
        FROM read_parquet({{FILES}}, union_by_name = true)
        WHERE date >= ? AND date <= ?
        GROUP BY url
      ),
      prev AS (
        SELECT
          url,
          ${METRIC_EXPR.clicks} AS clicks,
          ${METRIC_EXPR.position} AS position
        FROM read_parquet({{FILES_PREV}}, union_by_name = true)
        WHERE date >= ? AND date <= ?
        GROUP BY url
        HAVING SUM(clicks) >= ?
      ),
      weekly AS (
        SELECT url, date_trunc('week', CAST(date AS DATE)) AS week,
          ${METRIC_EXPR.clicks} AS clicks,
          ${METRIC_EXPR.impressions} AS impressions
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
    }
  },

  reduceSql(rows) {
    const arr = Array.isArray(rows) ? rows : []
    return {
      results: arr.map(r => ({
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
      } as DecayResult)),
      meta: { total: arr.length },
    }
  },

  buildRows(params) {
    const { current, previous } = comparisonOf(params)
    return {
      current: pagesQueryState(current, params.limit),
      previous: pagesQueryState(previous, params.limit),
    }
  },

  reduceRows(rows, params) {
    const map = (rows && !Array.isArray(rows)) ? rows as Record<string, Row[]> : { current: [], previous: [] }
    const current = (map.current ?? []) as unknown as PageRow[]
    const previous = (map.previous ?? []) as unknown as PageRow[]
    const results = analyzeDecay({ current, previous }, {
      minPreviousClicks: params.minPreviousClicks,
      threshold: params.threshold,
    })
    return { results, meta: { total: results.length } }
  },
})

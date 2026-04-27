/**
 * `movers` — identifies keywords with significant changes between current
 * and previous periods. Comparison analyzer: both paths consume `current` /
 * `previous` keyword rows. SQL adds a per-(query,url) weekly sparkline
 * (`series`) by UNION-ing both file sets; the row reducer omits `series`
 * (matches existing live-GSC behavior). Result is split into rising +
 * declining arrays with a `direction` tag.
 */

import type { Row } from '@gscdump/engine/contracts'
import type { AnalysisParams, KeywordRow } from '../types'
import { enumeratePartitions } from '@gscdump/engine/planner'
import { METRIC_EXPR } from '@gscdump/engine/sql-fragments'
import { keywordsQueryState } from '../analyzer/adapt-rows'
import { defineAnalyzer } from '../analyzer/define'
import { comparisonOf } from '../period'
import { percentDifference } from '../scoring'
import { buildPeriodMap, num } from '../types'

export type MoversSortMetric = 'clicks' | 'impressions' | 'clicksChange' | 'impressionsChange' | 'positionChange'

export interface MoversOptions {
  /** Minimum change threshold to flag. Default: 0.2 (20%) */
  changeThreshold?: number
  /** Minimum impressions in recent period. Default: 50 */
  minImpressions?: number
  /** Metric to sort results by. Default: clicksChange */
  sortBy?: MoversSortMetric
}

export interface MoversInput {
  current: KeywordRow[]
  previous: KeywordRow[]
  /** If periods have different lengths, provide normalization factor (previous/current) */
  normalizationFactor?: number
}

export interface MoverData {
  keyword: string
  page: string | null
  recentClicks: number
  recentImpressions: number
  recentPosition: number
  baselineClicks: number
  baselineImpressions: number
  baselinePosition: number
  clicksChange: number
  clicksChangePercent: number
  impressionsChangePercent: number
  positionChange: number
}

export interface MoversResult {
  rising: MoverData[]
  declining: MoverData[]
  stable: MoverData[]
}

export interface MoversSeriesPoint {
  week: string
  clicks: number
  impressions: number
}

export interface MoversResultRow extends MoverData {
  direction: 'rising' | 'declining' | 'stable'
  series?: MoversSeriesPoint[]
}

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
 * Pure helper: identify "movers and shakers" — keywords with significant
 * recent changes between two periods.
 */
export function analyzeMovers(
  input: MoversInput,
  options: MoversOptions = {},
): MoversResult {
  const {
    changeThreshold = 0.2,
    minImpressions = 50,
    sortBy = 'clicksChange',
  } = options

  const normFactor = input.normalizationFactor ?? 1

  const baselineMap = buildPeriodMap(
    input.previous,
    r => r.query,
    r => ({
      clicks: num(r.clicks) / normFactor,
      impressions: num(r.impressions) / normFactor,
      position: num(r.position),
      page: r.page ?? null,
    }),
  )

  const pageMap = new Map<string, string>()
  for (const row of input.current) {
    if (!pageMap.has(row.query) && row.page)
      pageMap.set(row.query, row.page)
  }
  for (const row of input.previous) {
    if (!pageMap.has(row.query) && row.page)
      pageMap.set(row.query, row.page)
  }

  const rising: MoverData[] = []
  const declining: MoverData[] = []
  const stable: MoverData[] = []

  for (const row of input.current) {
    const impressions = num(row.impressions)
    const clicks = num(row.clicks)
    const position = num(row.position)

    if (impressions < minImpressions)
      continue

    const baseline = baselineMap.get(row.query) || { clicks: 0, impressions: 0, position: 0, page: null }
    const clicksChangePercent = percentDifference(clicks, baseline.clicks)
    const impressionsChangePercent = percentDifference(impressions, baseline.impressions)

    const data: MoverData = {
      keyword: row.query,
      page: pageMap.get(row.query) ?? null,
      recentClicks: clicks,
      recentImpressions: impressions,
      recentPosition: position,
      baselineClicks: Math.round(baseline.clicks),
      baselineImpressions: Math.round(baseline.impressions),
      baselinePosition: baseline.position,
      clicksChange: clicks - Math.round(baseline.clicks),
      clicksChangePercent,
      impressionsChangePercent,
      positionChange: position - baseline.position,
    }

    const absChange = Math.abs(clicksChangePercent / 100)

    if (clicksChangePercent > 0 && absChange >= changeThreshold)
      rising.push(data)
    else if (clicksChangePercent < 0 && absChange >= changeThreshold)
      declining.push(data)
    else
      stable.push(data)
  }

  const sortFn = (a: MoverData, b: MoverData): number => {
    switch (sortBy) {
      case 'clicks':
        return b.recentClicks - a.recentClicks
      case 'impressions':
        return b.recentImpressions - a.recentImpressions
      case 'clicksChange':
        return Math.abs(b.clicksChangePercent) - Math.abs(a.clicksChangePercent)
      case 'impressionsChange':
        return Math.abs(b.impressionsChangePercent) - Math.abs(a.impressionsChangePercent)
      case 'positionChange':
        return Math.abs(b.positionChange) - Math.abs(a.positionChange)
      default:
        return Math.abs(b.clicksChangePercent) - Math.abs(a.clicksChangePercent)
    }
  }

  rising.sort(sortFn)
  declining.sort(sortFn)
  stable.sort((a, b) => b.recentClicks - a.recentClicks)

  return { rising, declining, stable }
}

export const moversAnalyzer = defineAnalyzer<AnalysisParams, Row, MoversResultRow[]>({
  id: 'movers',

  buildSql(params) {
    const { current: cur, previous: prev } = comparisonOf(params)
    const minImpressions = params.minImpressions ?? 50
    const changeThreshold = params.changeThreshold ?? 0.2
    const limit = params.limit ?? 2000

    // weekly: union both file sets so every entity gets a weekly sparkline
    // spanning prev_start → cur_end (with a gap for any dates between periods).
    const sql = `
      WITH cur AS (
        SELECT
          query, url,
          ${METRIC_EXPR.clicks} AS clicks,
          ${METRIC_EXPR.impressions} AS impressions,
          ${METRIC_EXPR.position} AS position
        FROM read_parquet({{FILES}}, union_by_name = true)
        WHERE date >= ? AND date <= ?
        GROUP BY query, url
      ),
      prev AS (
        SELECT
          query, url,
          ${METRIC_EXPR.clicks} AS clicks,
          ${METRIC_EXPR.impressions} AS impressions,
          ${METRIC_EXPR.position} AS position
        FROM read_parquet({{FILES_PREV}}, union_by_name = true)
        WHERE date >= ? AND date <= ?
        GROUP BY query, url
      ),
      weekly AS (
        SELECT query, url, date_trunc('week', CAST(date AS DATE)) AS week,
          ${METRIC_EXPR.clicks} AS clicks,
          ${METRIC_EXPR.impressions} AS impressions
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
    }
  },

  reduceSql(rows) {
    const arr = Array.isArray(rows) ? rows : []
    const normalized: MoversResultRow[] = arr.map(r => ({
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

  buildRows(params) {
    const { current, previous } = comparisonOf(params)
    return {
      current: keywordsQueryState(current, params.limit),
      previous: keywordsQueryState(previous, params.limit),
    }
  },

  reduceRows(rows, params) {
    const map = (rows && !Array.isArray(rows)) ? rows as Record<string, Row[]> : { current: [], previous: [] }
    const current = (map.current ?? []) as unknown as KeywordRow[]
    const previous = (map.previous ?? []) as unknown as KeywordRow[]
    const result = analyzeMovers({ current, previous }, {
      changeThreshold: params.changeThreshold,
      minImpressions: params.minImpressions,
    })
    return {
      results: [
        ...result.rising.map(r => ({ ...r, direction: 'rising' as const })),
        ...result.declining.map(r => ({ ...r, direction: 'declining' as const })),
      ] as MoversResultRow[],
      meta: { rising: result.rising.length, declining: result.declining.length },
    }
  },
})

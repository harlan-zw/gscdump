/**
 * `movers` — identifies keywords with significant changes between current
 * and previous periods. Comparison analyzer: both paths consume `current` /
 * `previous` keyword rows. SQL adds a per-(query,url) weekly sparkline
 * (`series`) by UNION-ing both file sets; the row reducer omits `series`
 * (matches existing live-GSC behavior). Result is split into rising +
 * declining arrays with a `direction` tag.
 */

import type { AnalysisParams } from '@gscdump/engine/analysis-types'
import type { Row } from '@gscdump/engine/contracts'
import type { QueriesRow } from '../types'
import { num } from '@gscdump/engine/analysis-types'
import { defineAnalyzer } from '@gscdump/engine/analyzer'
import { comparisonOf } from '@gscdump/engine/period'
import { enumeratePartitions } from '@gscdump/engine/planner'
import { METRIC_EXPR } from '@gscdump/engine/sql-fragments'
import { queriesQueryState } from '../analyzer/adapt-rows'
import { parseJsonRows as parseJsonList, rowString as str } from '../analyzer/row-values'
import { percentDifference } from '../scoring'
import { buildPeriodMap } from '../types'

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
  current: QueriesRow[]
  previous: QueriesRow[]
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
  /** `null` when the keyword has no previous-period data (a genuinely new query), not "position 0". */
  baselinePosition: number | null
  clicksChange: number
  clicksChangePercent: number
  impressionsChangePercent: number
  /** `null` unless both recentPosition and baselinePosition exist. */
  positionChange: number | null
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
  // Canonical frontend-facing aliases (recent* / baseline* duplicated under the
  // names dashboard + opportunities tables read). See `reduceSql`.
  clicks: number
  impressions: number
  ctr: number
  position: number
  prevClicks: number
  prevImpressions: number
  prevPosition: number | null
  series?: MoversSeriesPoint[]
}

/**
 * Add the canonical frontend-facing field aliases (`clicks`/`impressions`/
 * `ctr`/`position`/`prev*`) the dashboard + opportunities tables read, derived
 * from the `recent*` / `baseline*` columns. Makes the registry output the
 * single canonical shape so no caller has to remap.
 */
function withCanonicalFields(r: MoverData & { direction: 'rising' | 'declining' | 'stable', series?: MoversSeriesPoint[] }): MoversResultRow {
  return {
    ...r,
    clicks: r.recentClicks,
    impressions: r.recentImpressions,
    ctr: r.recentImpressions > 0 ? r.recentClicks / r.recentImpressions : 0,
    position: r.recentPosition,
    prevClicks: r.baselineClicks,
    prevImpressions: r.baselineImpressions,
    prevPosition: r.baselinePosition,
  }
}

/**
 * Shared direction-scoped selection + pagination. When `params.direction` is
 * set, report `total` as that direction's full pre-pagination count and slice
 * `[offset, offset+limit]` (matches the legacy `getAnalysis` dispatcher).
 * Direction-less callers (the dashboard top-N) get both directions uncapped and
 * slice themselves.
 */
function selectMoversDirection(
  rising: MoversResultRow[],
  declining: MoversResultRow[],
  stable: MoversResultRow[],
  params: { direction?: 'rising' | 'declining', limit?: number, offset?: number },
): { results: MoversResultRow[], meta: Record<string, number> } {
  if (params.direction) {
    const selected = params.direction === 'rising' ? rising : declining
    const total = selected.length
    const offset = params.offset ?? 0
    const limit = params.limit ?? total
    return {
      results: selected.slice(offset, offset + limit),
      meta: { total, rising: rising.length, declining: declining.length, stable: stable.length },
    }
  }
  const combined = [...rising, ...declining]
  return {
    results: combined,
    meta: { total: combined.length, rising: rising.length, declining: declining.length, stable: stable.length },
  }
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

    // A missing baseline means this keyword is genuinely new this period —
    // 0 clicks/impressions is correct, but a fabricated position 0 would
    // read as "#1" and produce a spurious huge positionChange. Keep the
    // baseline position (and the derived change) `null` instead.
    const baseline = baselineMap.get(row.query)
    const baselineClicksRaw = baseline?.clicks ?? 0
    const baselineImpressionsRaw = baseline?.impressions ?? 0
    const baselinePosition = baseline?.position ?? null
    const clicksChangePercent = percentDifference(clicks, baselineClicksRaw)
    const impressionsChangePercent = percentDifference(impressions, baselineImpressionsRaw)

    const data: MoverData = {
      keyword: row.query,
      page: pageMap.get(row.query) ?? null,
      recentClicks: clicks,
      recentImpressions: impressions,
      recentPosition: position,
      baselineClicks: Math.round(baselineClicksRaw),
      baselineImpressions: Math.round(baselineImpressionsRaw),
      baselinePosition,
      clicksChange: clicks - Math.round(baselineClicksRaw),
      clicksChangePercent,
      impressionsChangePercent,
      positionChange: baselinePosition != null ? position - baselinePosition : null,
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
        // Rows with no positionChange signal (brand-new keywords) sort last.
        return Math.abs(b.positionChange ?? 0) - Math.abs(a.positionChange ?? 0)
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
    // In direction mode `params.limit` is the page size, applied in `reduceSql`
    // after the direction split — so the SQL must fetch the full candidate pool,
    // not the page, or the per-direction `total` and pagination are wrong.
    // Without a direction, `limit` is the top-N cap and applies directly.
    const limit = params.direction ? 5000 : (params.limit ?? 2000)

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
          p.position AS baselinePosition,
          (c.clicks - COALESCE(p.clicks, 0.0)) AS clicksChange,
          CASE
            WHEN COALESCE(p.clicks, 0.0) = 0 THEN CASE WHEN c.clicks > 0 THEN 100.0 ELSE 0.0 END
            ELSE (c.clicks - p.clicks) * 100.0 / p.clicks
          END AS clicksChangePercent,
          CASE
            WHEN COALESCE(p.impressions, 0.0) = 0 THEN CASE WHEN c.impressions > 0 THEN 100.0 ELSE 0.0 END
            ELSE (c.impressions - p.impressions) * 100.0 / p.impressions
          END AS impressionsChangePercent,
          CASE WHEN p.position IS NOT NULL THEN (c.position - p.position) ELSE NULL END AS positionChange,
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
      current: { table: 'page_queries', partitions: enumeratePartitions(cur.startDate, cur.endDate) },
      previous: { table: 'page_queries', partitions: enumeratePartitions(prev.startDate, prev.endDate) },
    }
  },

  reduceSql(rows, params) {
    const arr = Array.isArray(rows) ? rows : []
    const normalized: MoversResultRow[] = arr.map((r) => {
      const recentClicks = num(r.recentClicks)
      const recentImpressions = num(r.recentImpressions)
      const recentPosition = num(r.recentPosition)
      const baselineClicks = Math.round(num(r.baselineClicks))
      const baselineImpressions = Math.round(num(r.baselineImpressions))
      const baselinePosition = r.baselinePosition == null ? null : num(r.baselinePosition)
      return {
        keyword: str(r.keyword),
        page: r.page == null ? null : str(r.page),
        recentClicks,
        recentImpressions,
        recentPosition,
        baselineClicks,
        baselineImpressions,
        baselinePosition,
        clicksChange: num(r.clicksChange),
        clicksChangePercent: num(r.clicksChangePercent),
        impressionsChangePercent: num(r.impressionsChangePercent),
        positionChange: r.positionChange == null ? null : num(r.positionChange),
        direction: str(r.direction) as 'rising' | 'declining' | 'stable',
        series: parseJsonList(r.seriesJson).map(s => ({
          week: str(s.week),
          clicks: num(s.clicks),
          impressions: num(s.impressions),
        })),
      } satisfies MoverData & { direction: 'rising' | 'declining' | 'stable', series: MoversSeriesPoint[] }
    }).map(withCanonicalFields)
    const rising = normalized.filter(r => r.direction === 'rising')
    const declining = normalized.filter(r => r.direction === 'declining')
    const stable = normalized.filter(r => r.direction === 'stable')
    return selectMoversDirection(rising, declining, stable, params)
  },

  buildRows(params) {
    const { current, previous } = comparisonOf(params)
    return {
      current: queriesQueryState(current, params.limit),
      previous: queriesQueryState(previous, params.limit),
    }
  },

  reduceRows(rows, params) {
    const map = (rows && !Array.isArray(rows)) ? rows as Record<string, Row[]> : { current: [], previous: [] }
    const current = (map.current ?? []) as unknown as QueriesRow[]
    const previous = (map.previous ?? []) as unknown as QueriesRow[]
    const result = analyzeMovers({ current, previous }, {
      changeThreshold: params.changeThreshold,
      minImpressions: params.minImpressions,
    })
    const rising = result.rising.map(r => withCanonicalFields({ ...r, direction: 'rising' as const }))
    const declining = result.declining.map(r => withCanonicalFields({ ...r, direction: 'declining' as const }))
    return selectMoversDirection(rising, declining, [], params)
  },
})

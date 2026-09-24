/**
 * `movers` — identifies (query, page) pairs with significant changes between
 * current and previous periods. Comparison analyzer: both paths consume
 * `current` / `previous` keyword rows and full-outer-join them on
 * `(query, page)`, so vanished pairs report as declining. SQL adds a weekly
 * sparkline (`series`) for the returned page of rows; the row reducer omits
 * `series` (matches existing live-GSC behavior). Rows carry a `direction` tag.
 */

import type { AnalysisParams } from '@gscdump/engine/analysis-types'
import type { Row } from '@gscdump/engine/contracts'
import type { QueriesRow } from '../types'
import { fetchBudgetOf, num } from '@gscdump/engine/analysis-types'
import { defineAnalyzer } from '@gscdump/engine/analyzer'
import { comparisonOf } from '@gscdump/engine/period'
import { enumeratePartitions } from '@gscdump/engine/planner'
import { METRIC_EXPR } from '@gscdump/engine/sql-fragments'
import { queriesQueryState } from '../analyzer/adapt-rows'
import { paginateClause, paginateInMemory, resolveSort } from '../analyzer/paginate'
import { parseJsonRows as parseJsonList, rowString as str } from '../analyzer/row-values'
import { percentDifference } from '../scoring'

/**
 * Sort keys. `*Delta` sorts by the absolute change, `*DeltaPercent` by the
 * percent change. Both sort by magnitude, so large drops rank with large gains.
 */
export type MoversSortMetric
  = | 'clicks'
    | 'impressions'
    | 'clicksDelta'
    | 'clicksDeltaPercent'
    | 'impressionsDelta'
    | 'impressionsDeltaPercent'
    | 'positionDelta'

export const MOVERS_SORT_METRICS: readonly MoversSortMetric[] = [
  'clicks',
  'impressions',
  'clicksDelta',
  'clicksDeltaPercent',
  'impressionsDelta',
  'impressionsDeltaPercent',
  'positionDelta',
]

const DEFAULT_SORT = { sortBy: 'clicksDelta', sortDir: 'desc' } as const

const DEFAULT_MOVERS_LIMIT = 2000

export interface MoversOptions {
  /** Minimum change threshold to flag. Default: 0.2 (20%) */
  changeThreshold?: number
  /** Minimum impressions in the larger of the two periods. Default: 50 */
  minImpressions?: number
  /** Metric to sort results by. Default: clicksDelta */
  sortBy?: MoversSortMetric
  /** `desc` puts the largest change first. Default: desc */
  sortDir?: 'asc' | 'desc'
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
  /** `null` when the (query, page) pair has no current-period data (it vanished). */
  recentPosition: number | null
  baselineClicks: number
  baselineImpressions: number
  /** `null` when the (query, page) pair has no previous-period data (it is new). */
  baselinePosition: number | null
  clicksChange: number
  clicksChangePercent: number
  impressionsChange: number
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
  position: number | null
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

function sortValue(row: MoverData, sortBy: MoversSortMetric): number {
  switch (sortBy) {
    case 'clicks':
      return row.recentClicks
    case 'impressions':
      return row.recentImpressions
    case 'clicksDelta':
      return Math.abs(row.clicksChange)
    case 'clicksDeltaPercent':
      return Math.abs(row.clicksChangePercent)
    case 'impressionsDelta':
      return Math.abs(row.impressionsChange)
    case 'impressionsDeltaPercent':
      return Math.abs(row.impressionsChangePercent)
    case 'positionDelta':
      // Rows with no positionChange signal (new or vanished pairs) sort last.
      return Math.abs(row.positionChange ?? 0)
  }
}

function moversComparator(sortBy: MoversSortMetric, sortDir: 'asc' | 'desc'): (a: MoverData, b: MoverData) => number {
  const mult = sortDir === 'asc' ? 1 : -1
  return (a, b) => (sortValue(a, sortBy) - sortValue(b, sortBy)) * mult
    || a.keyword.localeCompare(b.keyword)
    || (a.page ?? '').localeCompare(b.page ?? '')
}

/** SQL twin of `sortValue`. Keys come from the `MOVERS_SORT_METRICS` allow-list. */
const SQL_SORT_EXPR: Record<MoversSortMetric, string> = {
  clicks: 'recentClicks',
  impressions: 'recentImpressions',
  clicksDelta: 'ABS(clicksChange)',
  clicksDeltaPercent: 'ABS(clicksChangePercent)',
  impressionsDelta: 'ABS(impressionsChange)',
  impressionsDeltaPercent: 'ABS(impressionsChangePercent)',
  positionDelta: 'ABS(COALESCE(positionChange, 0))',
}

/**
 * Shared direction selection + pagination for the row path. With
 * `params.direction`, `total` counts that direction; without it, `total`
 * counts rising plus declining rows. Both slice `[offset, offset + limit]`.
 */
function selectMoversDirection(
  result: MoversResult,
  params: { direction?: 'rising' | 'declining', limit?: number, offset?: number },
  compare: (a: MoverData, b: MoverData) => number,
): { results: MoversResultRow[], meta: Record<string, number> } {
  const tag = (direction: 'rising' | 'declining') => (r: MoverData) => withCanonicalFields({ ...r, direction })
  const selected = params.direction === 'rising'
    ? result.rising.map(tag('rising'))
    : params.direction === 'declining'
      ? result.declining.map(tag('declining'))
      : [...result.rising.map(tag('rising')), ...result.declining.map(tag('declining'))].sort(compare)
  const paged = paginateInMemory(selected, { limit: params.limit ?? DEFAULT_MOVERS_LIMIT, offset: params.offset })
  return {
    results: paged,
    meta: {
      total: selected.length,
      returned: paged.length,
      rising: result.rising.length,
      declining: result.declining.length,
      stable: result.stable.length,
    },
  }
}

interface PeriodMetrics {
  query: string
  page: string | null
  clicks: number
  impressions: number
  position: number
}

function pairKey(query: string, page: string | null): string {
  return `${query}\u0000${page ?? ''}`
}

function periodMap(rows: readonly QueriesRow[], factor: number): Map<string, PeriodMetrics> {
  const out = new Map<string, PeriodMetrics>()
  for (const row of rows) {
    const page = row.page ?? null
    out.set(pairKey(row.query, page), {
      query: row.query,
      page,
      clicks: num(row.clicks) / factor,
      impressions: num(row.impressions) / factor,
      position: num(row.position),
    })
  }
  return out
}

/**
 * Pure helper: identify "movers and shakers" between two periods. Rows join
 * on the full `(query, page)` identity in both directions, so a pair that
 * vanished from the current period reports as declining, and one query on
 * two pages yields two movers. `minImpressions` applies to the larger of the
 * two periods, so a drop below the floor still reports.
 */
export function analyzeMovers(
  input: MoversInput,
  options: MoversOptions = {},
): MoversResult {
  const {
    changeThreshold = 0.2,
    minImpressions = 50,
    sortBy = DEFAULT_SORT.sortBy,
    sortDir = DEFAULT_SORT.sortDir,
  } = options

  const current = periodMap(input.current, 1)
  const previous = periodMap(input.previous, input.normalizationFactor ?? 1)

  const rising: MoverData[] = []
  const declining: MoverData[] = []
  const stable: MoverData[] = []

  for (const key of new Set([...current.keys(), ...previous.keys()])) {
    const cur = current.get(key)
    const prev = previous.get(key)
    const identity = (cur ?? prev)!
    const clicks = cur?.clicks ?? 0
    const impressions = cur?.impressions ?? 0
    const baselineClicksRaw = prev?.clicks ?? 0
    const baselineImpressionsRaw = prev?.impressions ?? 0

    if (Math.max(impressions, baselineImpressionsRaw) < minImpressions)
      continue

    // A missing side is a real zero for clicks and impressions, but a
    // fabricated position 0 would read as "#1". Keep positions `null`.
    const recentPosition = cur?.position ?? null
    const baselinePosition = prev?.position ?? null
    const baselineClicks = Math.round(baselineClicksRaw)
    const baselineImpressions = Math.round(baselineImpressionsRaw)
    const clicksChangePercent = percentDifference(clicks, baselineClicksRaw)

    const data: MoverData = {
      keyword: identity.query,
      page: identity.page,
      recentClicks: clicks,
      recentImpressions: impressions,
      recentPosition,
      baselineClicks,
      baselineImpressions,
      baselinePosition,
      clicksChange: clicks - baselineClicks,
      clicksChangePercent,
      impressionsChange: impressions - baselineImpressions,
      impressionsChangePercent: percentDifference(impressions, baselineImpressionsRaw),
      positionChange: recentPosition != null && baselinePosition != null ? recentPosition - baselinePosition : null,
    }

    const absChange = Math.abs(clicksChangePercent / 100)
    if (clicksChangePercent > 0 && absChange >= changeThreshold)
      rising.push(data)
    else if (clicksChangePercent < 0 && absChange >= changeThreshold)
      declining.push(data)
    else
      stable.push(data)
  }

  const compare = moversComparator(sortBy, sortDir)
  rising.sort(compare)
  declining.sort(compare)
  stable.sort((a, b) => b.recentClicks - a.recentClicks)

  return { rising, declining, stable }
}

function resolveMoversSort(params: AnalysisParams): { sortBy: MoversSortMetric, sortDir: 'asc' | 'desc' } {
  return resolveSort(params, MOVERS_SORT_METRICS, DEFAULT_SORT)
}

export const moversAnalyzer = defineAnalyzer<AnalysisParams, Row, MoversResultRow[]>({
  id: 'movers',

  buildSql(params) {
    const { current: cur, previous: prev } = comparisonOf(params)
    const minImpressions = params.minImpressions ?? 50
    const changeThreshold = params.changeThreshold ?? 0.2
    const { sortBy, sortDir } = resolveMoversSort(params)
    const orderBy = `${SQL_SORT_EXPR[sortBy]} ${sortDir === 'asc' ? 'ASC' : 'DESC'}, keyword ASC, page ASC`
    // Literal allow-list, never user text.
    const directions = params.direction === 'rising'
      ? `('rising')`
      : params.direction === 'declining'
        ? `('declining')`
        : `('rising', 'declining')`

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
      joined AS (
        SELECT
          COALESCE(c.query, p.query) AS keyword,
          COALESCE(c.url, p.url) AS page,
          COALESCE(c.clicks, 0.0) AS recentClicks,
          COALESCE(c.impressions, 0.0) AS recentImpressions,
          c.position AS recentPosition,
          COALESCE(p.clicks, 0.0) AS baselineClicks,
          COALESCE(p.impressions, 0.0) AS baselineImpressions,
          p.position AS baselinePosition
        FROM cur c
        FULL OUTER JOIN prev p ON c.query = p.query AND c.url = p.url
        WHERE GREATEST(COALESCE(c.impressions, 0.0), COALESCE(p.impressions, 0.0)) >= ?
      ),
      derived AS (
        SELECT
          *,
          (recentClicks - baselineClicks) AS clicksChange,
          CASE
            WHEN baselineClicks = 0 THEN CASE WHEN recentClicks > 0 THEN 100.0 ELSE 0.0 END
            ELSE (recentClicks - baselineClicks) * 100.0 / baselineClicks
          END AS clicksChangePercent,
          (recentImpressions - baselineImpressions) AS impressionsChange,
          CASE
            WHEN baselineImpressions = 0 THEN CASE WHEN recentImpressions > 0 THEN 100.0 ELSE 0.0 END
            ELSE (recentImpressions - baselineImpressions) * 100.0 / baselineImpressions
          END AS impressionsChangePercent,
          CASE
            WHEN recentPosition IS NOT NULL AND baselinePosition IS NOT NULL THEN (recentPosition - baselinePosition)
            ELSE NULL
          END AS positionChange
        FROM joined
      ),
      classified AS (
        SELECT
          *,
          CASE
            WHEN clicksChangePercent > 0 AND ABS(clicksChangePercent) / 100.0 >= ? THEN 'rising'
            WHEN clicksChangePercent < 0 AND ABS(clicksChangePercent) / 100.0 >= ? THEN 'declining'
            ELSE 'stable'
          END AS direction
        FROM derived
      ),
      counted AS (
        SELECT
          *,
          CAST(SUM(CASE WHEN direction = 'rising' THEN 1 ELSE 0 END) OVER () AS DOUBLE) AS risingCount,
          CAST(SUM(CASE WHEN direction = 'declining' THEN 1 ELSE 0 END) OVER () AS DOUBLE) AS decliningCount,
          CAST(SUM(CASE WHEN direction = 'stable' THEN 1 ELSE 0 END) OVER () AS DOUBLE) AS stableCount
        FROM classified
      ),
      selected AS (
        SELECT *
        FROM counted
        WHERE direction IN ${directions}
        ORDER BY ${orderBy}
        ${paginateClause({ limit: params.limit ?? DEFAULT_MOVERS_LIMIT, offset: params.offset })}
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
        ) u
        SEMI JOIN selected ON u.query = selected.keyword AND u.url = selected.page
        GROUP BY query, url, week
      ),
      series_by_entity AS (
        SELECT query, url, to_json(list({
          'week': strftime(week, '%Y-%m-%d'),
          'clicks': clicks,
          'impressions': impressions
        } ORDER BY week)) AS seriesJson
        FROM weekly GROUP BY query, url
      )
      SELECT selected.*, s.seriesJson
      FROM selected
      LEFT JOIN series_by_entity s ON selected.keyword = s.query AND selected.page = s.url
      ORDER BY ${orderBy}
    `

    return {
      sql,
      params: [
        cur.startDate,
        cur.endDate,
        prev.startDate,
        prev.endDate,
        minImpressions,
        changeThreshold,
        changeThreshold,
        cur.startDate,
        cur.endDate,
        prev.startDate,
        prev.endDate,
      ],
      current: { table: 'page_queries', partitions: enumeratePartitions(cur.startDate, cur.endDate) },
      previous: { table: 'page_queries', partitions: enumeratePartitions(prev.startDate, prev.endDate) },
    }
  },

  reduceSql(rows, params) {
    const arr = Array.isArray(rows) ? rows : []
    const results: MoversResultRow[] = arr.map(r => withCanonicalFields({
      keyword: str(r.keyword),
      page: r.page == null ? null : str(r.page),
      recentClicks: num(r.recentClicks),
      recentImpressions: num(r.recentImpressions),
      recentPosition: r.recentPosition == null ? null : num(r.recentPosition),
      baselineClicks: Math.round(num(r.baselineClicks)),
      baselineImpressions: Math.round(num(r.baselineImpressions)),
      baselinePosition: r.baselinePosition == null ? null : num(r.baselinePosition),
      clicksChange: num(r.clicksChange),
      clicksChangePercent: num(r.clicksChangePercent),
      impressionsChange: num(r.impressionsChange),
      impressionsChangePercent: num(r.impressionsChangePercent),
      positionChange: r.positionChange == null ? null : num(r.positionChange),
      direction: str(r.direction) as 'rising' | 'declining' | 'stable',
      series: parseJsonList(r.seriesJson).map(s => ({
        week: str(s.week),
        clicks: num(s.clicks),
        impressions: num(s.impressions),
      })),
    }))
    // Window counts run before LIMIT, so they cover every mover, not the page.
    // An empty page carries no counts; report zero rather than guess.
    const first = arr[0]
    const rising = num(first?.risingCount)
    const declining = num(first?.decliningCount)
    const stable = num(first?.stableCount)
    const total = params.direction === 'rising'
      ? rising
      : params.direction === 'declining'
        ? declining
        : rising + declining
    return {
      results,
      meta: { total, returned: results.length, rising, declining, stable },
    }
  },

  buildRows(params) {
    const { current, previous } = comparisonOf(params)
    return {
      current: queriesQueryState(current, fetchBudgetOf(params)),
      previous: queriesQueryState(previous, fetchBudgetOf(params)),
    }
  },

  reduceRows(rows, params) {
    const map = (rows && !Array.isArray(rows)) ? rows as Record<string, Row[]> : { current: [], previous: [] }
    const current = (map.current ?? []) as unknown as QueriesRow[]
    const previous = (map.previous ?? []) as unknown as QueriesRow[]
    const { sortBy, sortDir } = resolveMoversSort(params)
    const result = analyzeMovers({ current, previous }, {
      changeThreshold: params.changeThreshold,
      minImpressions: params.minImpressions,
      sortBy,
      sortDir,
    })
    return selectMoversDirection(result, params, moversComparator(sortBy, sortDir))
  },
})

import type { AnalysisParams } from '@gscdump/engine/analysis-types'
import type { Row } from '@gscdump/engine/contracts'
import type { ResolverOptions } from '@gscdump/engine/resolver'
import type { BuilderState } from 'gscdump/query'

import { padTimeseries } from '@gscdump/engine/period'
import {
  buildExtrasQueries,
  buildTotalsSql,
  mergeExtras,
  resolveComparisonSQL,
  resolveToSQLOptimized,
} from '@gscdump/engine/resolver'
import { extractDateRange } from 'gscdump/query'

export interface QueryAnalyzerExtraQuery {
  name: string
  sql: string
  params: unknown[]
}

export interface QueryAnalyzerPlan<TK extends string = string> {
  tableKey: TK
  sql: string
  params: unknown[]
  extraQueries?: QueryAnalyzerExtraQuery[]
}

function requireBuilderState(
  input: unknown,
  tool: 'data-query' | 'data-detail',
): BuilderState {
  if (
    !input
    || typeof input !== 'object'
    || !('dimensions' in input)
    || !Array.isArray((input as { dimensions?: unknown }).dimensions)
  ) {
    throw new Error(`${tool}: params.q is required (BuilderState)`)
  }
  return input as BuilderState
}

function optionalBuilderState(
  input: unknown,
  tool: 'data-query' | 'data-detail',
  key: 'q' | 'qc',
): BuilderState | null {
  if (input == null)
    return null
  if (
    typeof input !== 'object'
    || !('dimensions' in input)
    || !Array.isArray((input as { dimensions?: unknown }).dimensions)
  ) {
    throw new Error(`${tool}: params.${key} must be a BuilderState`)
  }
  return input as BuilderState
}

const NUMERIC_METRIC_COLS = [
  'clicks',
  'impressions',
  'ctr',
  'position',
  'prevClicks',
  'prevImpressions',
  'prevCtr',
  'prevPosition',
  'variantCount',
  'totalCount',
] as const

function coerceNumericCols(row: Record<string, unknown>): Record<string, unknown> {
  const out = { ...row }
  for (const col of NUMERIC_METRIC_COLS) {
    if (col in out && out[col] != null)
      out[col] = Number(out[col] as number | bigint)
  }
  return out
}

function shapeDataQuery(
  rows: Row[],
  extras: Record<string, Row[]> | undefined,
  opts: { hasPrev: boolean },
): { results: Row[], meta: Record<string, unknown> } {
  let totalCount: number
  let cleaned: Record<string, unknown>[]
  let totals: { clicks: number, impressions: number, ctr: number, position: number }
  if (opts.hasPrev) {
    cleaned = (rows as Record<string, unknown>[]).map(coerceNumericCols)
    totalCount = Number((extras?.count?.[0] as { total?: number } | undefined)?.total ?? cleaned.length)
    const totalsRow = (extras?.totals?.[0] ?? {}) as Record<string, unknown>
    totals = {
      clicks: Number(totalsRow.clicks ?? 0),
      impressions: Number(totalsRow.impressions ?? 0),
      ctr: Number(totalsRow.ctr ?? 0),
      position: Number(totalsRow.position ?? 0),
    }
  }
  else {
    const first = rows[0] as Record<string, unknown> | undefined
    totalCount = Number(first?.totalCount ?? 0)
    totals = {
      clicks: Number(first?.totalClicks ?? 0),
      impressions: Number(first?.totalImpressions ?? 0),
      ctr: Number(first?.totalCtr ?? 0),
      position: Number(first?.totalPosition ?? 0),
    }
    cleaned = rows.map((raw) => {
      const {
        totalCount: _tc,
        totalClicks: _tclk,
        totalImpressions: _timp,
        totalCtr: _tctr,
        totalPosition: _tpos,
        sum_position: _sp,
        ...rest
      } = raw as Record<string, unknown>
      return coerceNumericCols(rest)
    })
  }

  const extrasResults: { key: string, results: Record<string, unknown>[] }[] = []
  if (extras?.canonicalExtras)
    extrasResults.push({ key: 'canonicalExtras', results: extras.canonicalExtras as Record<string, unknown>[] })
  const merged = mergeExtras(cleaned, extrasResults)

  return {
    results: merged as unknown as Row[],
    meta: { totalCount, totals },
  }
}

export function buildDataQueryPlan<TK extends string>(
  params: AnalysisParams,
  options: ResolverOptions<TK>,
): QueryAnalyzerPlan<TK> {
  const state = requireBuilderState(params.q, 'data-query')
  if (state.dimensions.includes('date'))
    throw new Error('data-query: date dimension not supported; use data-detail')

  const prev = optionalBuilderState(params.qc, 'data-query', 'qc')
  const extras = buildExtrasQueries(state, options)

  const extraQueries: QueryAnalyzerExtraQuery[] = [
    ...extras.map(extra => ({ name: extra.key, sql: extra.sql, params: extra.params })),
  ]

  const tableKey = options.adapter.inferTable(state.dimensions)

  if (prev) {
    const totals = buildTotalsSql(state, options)
    const comparison = resolveComparisonSQL(
      state,
      prev,
      options,
      params.comparisonFilter,
    )
    extraQueries.unshift({ name: 'totals', sql: totals.sql, params: totals.params })
    extraQueries.push({ name: 'count', sql: comparison.countSql, params: comparison.countParams })
    return {
      tableKey,
      sql: comparison.sql,
      params: comparison.params,
      extraQueries,
    }
  }

  const optimized = resolveToSQLOptimized(state, options)
  return {
    tableKey,
    sql: optimized.sql,
    params: optimized.params,
    extraQueries,
  }
}

// --- Row-query plans (cross-dimension fallback) ---------------------------
//
// When a breakdown's grouped + filtered dimensions span two stored datasets,
// the SQL path can't resolve a table (`UnresolvableDatasetError`). These row
// plans run plain `BuilderState`s through the source's `queryRows`, which the
// composite source routes to the live GSC API — the only source that computes
// cross-dimension aggregates.

function totalsState(state: BuilderState): BuilderState {
  return { ...state, dimensions: [], orderBy: undefined, rowLimit: 1 }
}

function readTotals(row: Record<string, unknown> | undefined): { clicks: number, impressions: number, ctr: number, position: number } {
  return {
    clicks: Number(row?.clicks ?? 0),
    impressions: Number(row?.impressions ?? 0),
    ctr: Number(row?.ctr ?? 0),
    position: Number(row?.position ?? 0),
  }
}

/** Row-query plan for `data-query`. Comparison (`qc`) joins two periods. */
export function buildDataQueryRows(params: AnalysisParams): Record<string, BuilderState> {
  const state = requireBuilderState(params.q, 'data-query')
  if (state.dimensions.includes('date'))
    throw new Error('data-query: date dimension not supported; use data-detail')
  const queries: Record<string, BuilderState> = { main: state, totals: totalsState(state) }
  const prev = optionalBuilderState(params.qc, 'data-query', 'qc')
  if (prev) {
    queries.prevMain = prev
    queries.prevTotals = totalsState(prev)
  }
  return queries
}

/** Post-processing for `data-query` row results. Mirrors `shapeDataQuery`. */
export function shapeDataQueryRowResults(
  rowMap: Record<string, Row[]>,
  params: AnalysisParams,
): { results: Row[], meta: Record<string, unknown> } {
  const main = (rowMap.main ?? []).map(r => coerceNumericCols(r as Record<string, unknown>))
  const totals = readTotals(rowMap.totals?.[0] as Record<string, unknown> | undefined)

  if (params.qc == null)
    return { results: main as unknown as Row[], meta: { totalCount: main.length, totals } }

  // Comparison: join current + previous breakdowns on their dimension values.
  const state = requireBuilderState(params.q, 'data-query')
  const dims = state.dimensions
  const keyOf = (row: Record<string, unknown>): string => dims.map(d => String(row[d] ?? '')).join('')
  const prevByKey = new Map<string, Record<string, unknown>>()
  for (const r of rowMap.prevMain ?? [])
    prevByKey.set(keyOf(r as Record<string, unknown>), r as Record<string, unknown>)

  const filter = params.comparisonFilter
  const merged: Record<string, unknown>[] = []
  const seen = new Set<string>()
  for (const cur of main) {
    const key = keyOf(cur)
    seen.add(key)
    const prev = prevByKey.get(key)
    const row: Record<string, unknown> = {
      ...cur,
      prevClicks: Number(prev?.clicks ?? 0),
      prevImpressions: Number(prev?.impressions ?? 0),
      prevCtr: Number(prev?.ctr ?? 0),
      prevPosition: Number(prev?.position ?? 0),
    }
    if (passesComparisonFilter(filter, { isNew: !prev, isLost: false, clicksChange: Number(cur.clicks ?? 0) - Number(prev?.clicks ?? 0) }))
      merged.push(row)
  }
  // `lost` rows exist in the previous period only.
  for (const prev of rowMap.prevMain ?? []) {
    const p = prev as Record<string, unknown>
    const key = keyOf(p)
    if (seen.has(key))
      continue
    const row: Record<string, unknown> = {
      ...p,
      clicks: 0,
      impressions: 0,
      ctr: 0,
      position: 0,
      prevClicks: Number(p.clicks ?? 0),
      prevImpressions: Number(p.impressions ?? 0),
      prevCtr: Number(p.ctr ?? 0),
      prevPosition: Number(p.position ?? 0),
    }
    if (passesComparisonFilter(filter, { isNew: false, isLost: true, clicksChange: -Number(p.clicks ?? 0) }))
      merged.push(row)
  }

  if (state.orderBy) {
    const { column, dir } = state.orderBy
    merged.sort((a, b) => {
      const av = Number(a[column]) || 0
      const bv = Number(b[column]) || 0
      return dir === 'asc' ? av - bv : bv - av
    })
  }
  return {
    results: merged.map(r => coerceNumericCols(r)) as unknown as Row[],
    meta: { totalCount: merged.length, totals },
  }
}

function passesComparisonFilter(
  filter: AnalysisParams['comparisonFilter'],
  ctx: { isNew: boolean, isLost: boolean, clicksChange: number },
): boolean {
  switch (filter) {
    case 'new': return ctx.isNew
    case 'lost': return ctx.isLost
    case 'improving': return ctx.clicksChange > 0
    case 'declining': return ctx.clicksChange < 0
    default: return true
  }
}

/** Row-query plan for `data-detail`. `qc` adds a previous-period totals query. */
export function buildDataDetailRows(params: AnalysisParams): Record<string, BuilderState> {
  const state = requireBuilderState(params.q, 'data-detail')
  if (!state.dimensions.includes('date'))
    throw new Error('data-detail: `date` dimension is required')
  const queries: Record<string, BuilderState> = { main: state, totals: totalsState(state) }
  const prev = optionalBuilderState(params.qc, 'data-detail', 'qc')
  if (prev)
    queries.prevTotals = totalsState(prev)
  return queries
}

/** Post-processing for `data-detail` row results. Mirrors `shapeDataDetailRows`. */
export function shapeDataDetailRowResults(
  rowMap: Record<string, Row[]>,
  params: AnalysisParams,
): { results: Row[], meta: Record<string, unknown> } {
  const state = requireBuilderState(params.q, 'data-detail')
  const { startDate, endDate } = extractDateRange(state.filter)
  const coerced = (rowMap.main ?? []).map(r => coerceNumericCols(r as Record<string, unknown>))
  const daily = startDate && endDate
    ? padTimeseries(coerced, { startDate, endDate })
    : coerced
  const meta: Record<string, unknown> = { totals: readTotals(rowMap.totals?.[0] as Record<string, unknown> | undefined) }
  if (rowMap.prevTotals)
    meta.previousTotals = readTotals(rowMap.prevTotals[0] as Record<string, unknown> | undefined)
  return { results: daily as unknown as Row[], meta }
}

/**
 * Pure post-processing for `data-query` rows. Adapter-free so reducers can
 * call it without re-running the SQL plan.
 */
export function shapeDataQueryRows(
  rows: Row[],
  params: AnalysisParams,
  extras?: Record<string, Row[]>,
): { results: Row[], meta: Record<string, unknown> } {
  const hasPrev = params.qc != null
  return shapeDataQuery(rows, extras, { hasPrev })
}

export function buildDataDetailPlan<TK extends string>(
  params: AnalysisParams,
  options: ResolverOptions<TK>,
): QueryAnalyzerPlan<TK> {
  const state = requireBuilderState(params.q, 'data-detail')
  if (!state.dimensions.includes('date'))
    throw new Error('data-detail: `date` dimension is required')

  // The date rows and their current-period totals come from one scan. The
  // optimized resolver carries COUNT/SUM window columns on every grouped row;
  // shapeDataDetailRows strips those private columns after reading the first
  // row. Comparison still needs one previous-period totals scan.
  const main = resolveToSQLOptimized(state, options)
  const prev = optionalBuilderState(params.qc, 'data-detail', 'qc')

  const extraQueries: QueryAnalyzerExtraQuery[] = []
  if (prev) {
    const previousTotals = buildTotalsSql(prev, options)
    extraQueries.push({ name: 'prevTotals', sql: previousTotals.sql, params: previousTotals.params })
  }

  const tableKey = options.adapter.inferTable(state.dimensions)

  return {
    tableKey,
    sql: main.sql,
    params: main.params,
    extraQueries,
  }
}

/**
 * Pure post-processing for `data-detail` rows. Reads the date range off
 * `params.q` so it stays adapter-free; reducers call it directly.
 */
export function shapeDataDetailRows(
  rows: Row[],
  params: AnalysisParams,
  extras?: Record<string, Row[]>,
): { results: Row[], meta: Record<string, unknown> } {
  const state = requireBuilderState(params.q, 'data-detail')
  const { startDate: rangeStart, endDate: rangeEnd } = extractDateRange(state.filter)
  const first = rows[0] as Record<string, unknown> | undefined
  const totals = {
    clicks: Number(first?.totalClicks ?? 0),
    impressions: Number(first?.totalImpressions ?? 0),
    ctr: Number(first?.totalCtr ?? 0),
    position: Number(first?.totalPosition ?? 0),
  }
  const coerced = (rows as Array<Record<string, unknown>>).map((raw) => {
    const {
      totalCount: _tc,
      totalClicks: _tclk,
      totalImpressions: _timp,
      totalCtr: _tctr,
      totalPosition: _tpos,
      sum_position: _sp,
      ...rest
    } = raw
    return coerceNumericCols(rest)
  })
  const daily = rangeStart && rangeEnd
    ? padTimeseries(coerced, { startDate: rangeStart, endDate: rangeEnd })
    : coerced
  const meta: Record<string, unknown> = { totals }
  if (extras?.prevTotals) {
    const previousTotalsRow = (extras.prevTotals[0] ?? {}) as Record<string, unknown>
    meta.previousTotals = {
      clicks: Number(previousTotalsRow.clicks ?? 0),
      impressions: Number(previousTotalsRow.impressions ?? 0),
      ctr: Number(previousTotalsRow.ctr ?? 0),
      position: Number(previousTotalsRow.position ?? 0),
    }
  }
  return { results: daily as unknown as Row[], meta }
}

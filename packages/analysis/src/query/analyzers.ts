import type { Row } from '@gscdump/engine/contracts'
import type { ResolverOptions } from '@gscdump/engine/resolver'
import type { BuilderState } from 'gscdump/query'
import type { AnalysisParams } from '../types'

import {
  buildExtrasQueries,
  buildTotalsSql,
  mergeExtras,
  resolveComparisonSQL,
  resolveToSQL,
  resolveToSQLOptimized,
} from '@gscdump/engine/resolver'
import { extractDateRange } from 'gscdump/query'
import { padTimeseries } from '../period'

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
  shape: (
    rows: Row[],
    params: AnalysisParams,
    extras?: Record<string, Row[]>,
  ) => { results: Row[], meta: Record<string, unknown> }
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
  if (opts.hasPrev) {
    cleaned = (rows as Record<string, unknown>[]).map(coerceNumericCols)
    totalCount = Number((extras?.count?.[0] as { total?: number } | undefined)?.total ?? cleaned.length)
  }
  else {
    const first = rows[0] as Record<string, unknown> | undefined
    totalCount = Number(first?.totalCount ?? 0)
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

  const totalsRow = (extras?.totals?.[0] ?? {}) as Record<string, unknown>
  const totals = {
    clicks: Number(totalsRow.clicks ?? 0),
    impressions: Number(totalsRow.impressions ?? 0),
    ctr: Number(totalsRow.ctr ?? 0),
    position: Number(totalsRow.position ?? 0),
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
  const totals = buildTotalsSql(state, options)
  const extras = buildExtrasQueries(state, options)

  const extraQueries: QueryAnalyzerExtraQuery[] = [
    { name: 'totals', sql: totals.sql, params: totals.params },
    ...extras.map(extra => ({ name: extra.key, sql: extra.sql, params: extra.params })),
  ]

  const tableKey = options.adapter.inferTable(state.dimensions)

  if (prev) {
    const comparison = resolveComparisonSQL(
      state,
      prev,
      options,
      params.comparisonFilter,
    )
    extraQueries.push({ name: 'count', sql: comparison.countSql, params: comparison.countParams })
    return {
      tableKey,
      sql: comparison.sql,
      params: comparison.params,
      extraQueries,
      shape: (rows, _params, resolvedExtras) => shapeDataQuery(rows, resolvedExtras, { hasPrev: true }),
    }
  }

  const optimized = resolveToSQLOptimized(state, options)
  return {
    tableKey,
    sql: optimized.sql,
    params: optimized.params,
    extraQueries,
    shape: (rows, _params, resolvedExtras) => shapeDataQuery(rows, resolvedExtras, { hasPrev: false }),
  }
}

export function buildDataDetailPlan<TK extends string>(
  params: AnalysisParams,
  options: ResolverOptions<TK>,
): QueryAnalyzerPlan<TK> {
  const state = requireBuilderState(params.q, 'data-detail')
  if (!state.dimensions.includes('date'))
    throw new Error('data-detail: `date` dimension is required')

  const main = resolveToSQL(state, options)
  const totals = buildTotalsSql(state, options)
  const prev = optionalBuilderState(params.qc, 'data-detail', 'qc')

  const extraQueries: QueryAnalyzerExtraQuery[] = [
    { name: 'totals', sql: totals.sql, params: totals.params },
  ]
  if (prev) {
    const previousTotals = buildTotalsSql(prev, options)
    extraQueries.push({ name: 'prevTotals', sql: previousTotals.sql, params: previousTotals.params })
  }

  const tableKey = options.adapter.inferTable(state.dimensions)
  const { startDate: rangeStart, endDate: rangeEnd } = extractDateRange(state.filter)

  return {
    tableKey,
    sql: main.sql,
    params: main.params,
    extraQueries,
    shape: (rows, _params, extras) => {
      const coerced = (rows as Array<Record<string, unknown>>).map(coerceNumericCols)
      const daily = rangeStart && rangeEnd
        ? padTimeseries(coerced, { startDate: rangeStart, endDate: rangeEnd })
        : coerced
      const totalsRow = (extras?.totals?.[0] ?? {}) as Record<string, unknown>
      const meta: Record<string, unknown> = {
        totals: {
          clicks: Number(totalsRow.clicks ?? 0),
          impressions: Number(totalsRow.impressions ?? 0),
          ctr: Number(totalsRow.ctr ?? 0),
          position: Number(totalsRow.position ?? 0),
        },
      }
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
    },
  }
}

// Pure orchestration of `resolveToSQLOptimized` + `buildExtrasQueries` and
// `resolveComparisonSQL` + `buildTotalsSql` against a caller-supplied
// `runSQL` callable. Hosts wire their own `engine.runSQL` (or a fake) and
// keep auth/tenant routing outside.

import type { Grain } from '@gscdump/contracts'
import type { BuilderState } from 'gscdump/query'
import type { SearchType, TableName } from '../storage'
import type { ComparisonFilter } from './types'
import { enumeratePartitions } from '../planner'
import { buildExtrasQueries, buildTotalsSql, resolveComparisonSQL, resolveToSQLOptimized } from './compiler'
import { createParquetResolverAdapter } from './pg-adapter'

export interface RunQueryCtx {
  userId: string
  siteId: string
  table: TableName
  searchType?: SearchType
  /**
   * Temporal granularity. `'day'` (default) drives `enumeratePartitions` to
   * emit `daily/{date}` only; hourly partitions are skipped by construction.
   * `'hour'` is reserved for hourly read paths and must use the dedicated
   * hourly query surface (callers pass `partitions: [hourly/{date}]`
   * directly through `runSQL`).
   */
  grain?: Grain
}

export interface RunSQLFn {
  (opts: {
    ctx: { userId: string, siteId: string }
    table: TableName
    fileSets: Record<string, { table: TableName, partitions: string[] }>
    sql: string
    params: unknown[]
    searchType?: SearchType
  }): Promise<{ rows: Array<Record<string, unknown>> }>
}

export interface OptimizedQueryResult {
  rows: Array<Record<string, unknown>>
  totalCount: number
  totals: { clicks: number, impressions: number, ctr: number, position: number }
  extras: Array<{ key: string, rows: Array<Record<string, unknown>> }>
}

export interface ComparisonQueryResult {
  rows: Array<Record<string, unknown>>
  totalCount: number
  totals: Record<string, unknown>
}

function runArgs(ctx: RunQueryCtx, partitions: string[]) {
  return {
    ctx: { userId: ctx.userId, siteId: ctx.siteId },
    table: ctx.table,
    fileSets: { FILES: { table: ctx.table, partitions } },
    ...(ctx.searchType !== undefined ? { searchType: ctx.searchType } : {}),
  }
}

export async function runOptimizedQuery(
  runSQL: RunSQLFn,
  ctx: RunQueryCtx,
  state: BuilderState,
  dateRange: { startDate: string, endDate: string },
): Promise<OptimizedQueryResult> {
  const adapter = createParquetResolverAdapter()
  const partitions = enumeratePartitions(dateRange.startDate, dateRange.endDate)
  const base = runArgs(ctx, partitions)

  const optimized = resolveToSQLOptimized(state, { adapter, siteId: undefined })
  const extras = buildExtrasQueries(state, { adapter, siteId: undefined })

  const [optRes, ...extrasRows] = await Promise.all([
    runSQL({ ...base, sql: optimized.sql, params: optimized.params }),
    ...extras.map(e => runSQL({ ...base, sql: e.sql, params: e.params })),
  ])

  const firstRow = optRes.rows[0] as Record<string, unknown> | undefined
  const totalCount = Number(firstRow?.totalCount ?? 0)
  const totals = {
    clicks: Number(firstRow?.totalClicks ?? 0),
    impressions: Number(firstRow?.totalImpressions ?? 0),
    ctr: Number(firstRow?.totalCtr ?? 0),
    position: Number(firstRow?.totalPosition ?? 0),
  }
  const rows = optRes.rows.map((r) => {
    const {
      totalCount: _tc,
      totalClicks: _tcl,
      totalImpressions: _ti,
      totalCtr: _tr,
      totalPosition: _tp,
      ...rest
    } = r as Record<string, unknown>
    return rest
  })
  return {
    rows,
    totalCount,
    totals,
    extras: extras.map((e, i) => ({ key: e.key, rows: extrasRows[i]!.rows })),
  }
}

export async function runComparisonQuery(
  runSQL: RunSQLFn,
  ctx: RunQueryCtx,
  current: BuilderState,
  previous: BuilderState,
  windows: {
    current: { startDate: string, endDate: string }
    previous: { startDate: string, endDate: string }
  },
  filter?: ComparisonFilter,
): Promise<ComparisonQueryResult> {
  const adapter = createParquetResolverAdapter()
  const comparison = resolveComparisonSQL(current, previous, { adapter, siteId: undefined }, filter)
  const totals = buildTotalsSql(current, { adapter, siteId: undefined })

  const startDate = windows.current.startDate < windows.previous.startDate
    ? windows.current.startDate
    : windows.previous.startDate
  const endDate = windows.current.endDate > windows.previous.endDate
    ? windows.current.endDate
    : windows.previous.endDate
  const partitions = enumeratePartitions(startDate, endDate)
  const base = runArgs(ctx, partitions)

  const main = await runSQL({ ...base, sql: comparison.sql, params: comparison.params })
  const count = await runSQL({ ...base, sql: comparison.countSql, params: comparison.countParams })
  const totalsRow = await runSQL({ ...base, sql: totals.sql, params: totals.params })

  return {
    rows: main.rows,
    totalCount: Number(count.rows[0]?.total ?? 0),
    totals: (totalsRow.rows[0] ?? {}) as Record<string, unknown>,
  }
}

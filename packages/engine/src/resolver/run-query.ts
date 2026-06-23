// Pure orchestration of `resolveToSQLOptimized` + `buildExtrasQueries` and
// `resolveComparisonSQL` + `buildTotalsSql` against a caller-supplied
// `runSQL` callable. Hosts wire their own `engine.runSQL` (or a fake) and
// keep auth/tenant routing outside.

import type { Grain } from '@gscdump/contracts'
import type { BuilderState } from 'gscdump/query'
import type { SearchType, TableName } from '../storage'
import type { ComparisonFilter } from './types'
import { enumeratePartitions } from '../planner'
import { canonicalRollupCovers } from './canonical-source'
import { buildExtrasQueries, buildTotalsSql, resolveComparisonSQL, resolveToSQLOptimized } from './compile'
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
    fileSets: Record<string, { table: TableName, partitions?: string[], keys?: string[] }>
    sql: string
    params: unknown[]
    searchType?: SearchType
  }): Promise<{ rows: Array<Record<string, unknown>> }>
}

/**
 * Optional overlay that serves a resolver extra (e.g. canonical-variant
 * grouping, keyed `'canonicalExtras'`) from a precomputed source — typically a
 * materialised rollup — instead of the live window-function SQL. Return the
 * rows in the exact shape the live extra produces (`mergeExtras` consumes
 * either source unchanged), or `null` to decline so the caller falls back to
 * the live query. Pure seam: storage/tenant routing lives in the host's
 * implementation, not here. See ADR-0017.
 */
export interface ResolveExtraFn {
  (opts: {
    key: string
    state: BuilderState
    ctx: RunQueryCtx
    dateRange: { startDate: string, endDate: string }
  }): Promise<Array<Record<string, unknown>> | null>
}

export interface RunOptimizedQueryOptions {
  /** Overlay tried per extra before the live SQL; absent → today's live path. */
  resolveExtra?: ResolveExtraFn
  /**
   * Opt-in canonical-primary correctness: group/compare `queryCanonical` as a
   * total key (NULL/'' folds to the raw `query`). Default false = legacy raw
   * nullable column. See ADR-0018.
   */
  canonicalFallback?: boolean
  /**
   * Opt-in canonical-primary performance (ADR-0018 Gap 2): object keys of the
   * `query_canonical_daily` rollup parquet(s). When supplied AND the query is
   * coverable (`canonicalRollupCovers`) AND `canonicalFallback` is on AND the
   * window is within the rollup's coverage, the MAIN query reads these
   * pre-summed `(query_canonical × date)` rows instead of re-aggregating raw
   * partitions; variant extras still read raw. Ignored (live path) on any miss,
   * so a mis-wired host degrades to correct-but-slow, never wrong.
   *
   * `canonicalFallback` is REQUIRED: the rollup is built with
   * `COALESCE(NULLIF(query_canonical, ''), query)` (fallback semantics), so
   * serving it to a legacy (`canonicalFallback: false`) caller would change
   * NULL/'' rows from legacy buckets to raw-query keys. The rollup is already
   * null-free, so the rollup READ itself runs without fallback.
   *
   * `coversThrough` (ISO `YYYY-MM-DD`, the rollup's newest covered date) gates
   * staleness: the source is used only when `dateRange.endDate <= coversThrough`,
   * else the live path serves the window so the recent tail is never silently
   * undercounted. Omit to assert full coverage (use with care).
   */
  canonicalSource?: { keys: string[], coversThrough?: string }
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

// The rollup is full-history but may lag the newest synced day. Serve it only
// when the requested window ends at/before its coverage, else the live path
// fills the recent tail. No `coversThrough` asserts full coverage.
function canonicalSourceWithinCoverage(source: { coversThrough?: string }, windowEnd: string): boolean {
  return source.coversThrough === undefined || windowEnd <= source.coversThrough
}

function runArgs(ctx: RunQueryCtx, partitions: string[]): { ctx: { userId: string, siteId: string }, table: RunQueryCtx['table'], fileSets: { FILES: { table: RunQueryCtx['table'], partitions: string[] } }, searchType?: RunQueryCtx['searchType'] } {
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
  options: RunOptimizedQueryOptions = {},
): Promise<OptimizedQueryResult> {
  const partitions = enumeratePartitions(dateRange.startDate, dateRange.endDate)
  const base = runArgs(ctx, partitions)

  // Decide whether the MAIN query can read the pre-summed canonical rollup.
  // Capabilities don't depend on the fallback flag, so a probe adapter is fine.
  const probe = createParquetResolverAdapter({ canonicalFallback: options.canonicalFallback ?? false })
  const useCanonicalSource = options.canonicalSource !== undefined
    // Rollup carries fallback (COALESCE) semantics — only valid when opted in.
    && (options.canonicalFallback ?? false)
    // Never serve a window newer than the rollup's coverage (silent undercount).
    && canonicalSourceWithinCoverage(options.canonicalSource, dateRange.endDate)
    && canonicalRollupCovers(state, probe.capabilities)

  // Rollup is already null-free → no fallback needed (and it lacks the raw
  // `query` column the fallback COALESCE would reference).
  const adapter = useCanonicalSource
    ? createParquetResolverAdapter({ canonicalFallback: false })
    : probe

  const optimized = resolveToSQLOptimized(state, { adapter, siteId: undefined })
  const extras = buildExtrasQueries(state, { adapter, siteId: undefined })

  // Main reads the rollup keys when eligible; extras always read raw partitions
  // (variant enrichment needs the per-query rows the rollup collapsed away).
  const mainArgs = useCanonicalSource
    ? { ...base, fileSets: { FILES: { table: ctx.table, keys: options.canonicalSource!.keys } } }
    : base

  // Each extra prefers the optional overlay (e.g. a materialised rollup); a
  // `null` result means "not available / declined" and we run the live SQL.
  // The overlay skips the live window-function pass entirely on a hit.
  const resolveExtra = options.resolveExtra
  const [optRes, ...extrasRows] = await Promise.all([
    runSQL({ ...mainArgs, sql: optimized.sql, params: optimized.params }),
    ...extras.map(async (e) => {
      const overlaid = resolveExtra
        ? await resolveExtra({ key: e.key, state, ctx, dateRange })
        : null
      return overlaid !== null
        ? { rows: overlaid }
        : runSQL({ ...base, sql: e.sql, params: e.params })
    }),
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
  options: { canonicalFallback?: boolean, canonicalSource?: { keys: string[], coversThrough?: string } } = {},
): Promise<ComparisonQueryResult> {
  const probe = createParquetResolverAdapter({ canonicalFallback: options.canonicalFallback ?? false })
  // Both windows must be coverable; the date-grained rollup serves both from
  // the same keys. Requires fallback opt-in (rollup has COALESCE semantics) and
  // coverage through the newer window's end. Otherwise live raw aggregation.
  const useCanonicalSource = options.canonicalSource !== undefined
    && (options.canonicalFallback ?? false)
    && canonicalSourceWithinCoverage(options.canonicalSource, windows.current.endDate > windows.previous.endDate ? windows.current.endDate : windows.previous.endDate)
    && canonicalRollupCovers(current, probe.capabilities)
    && canonicalRollupCovers(previous, probe.capabilities)
  const adapter = useCanonicalSource
    ? createParquetResolverAdapter({ canonicalFallback: false })
    : probe
  const comparison = resolveComparisonSQL(current, previous, { adapter, siteId: undefined }, filter)
  const totals = buildTotalsSql(current, { adapter, siteId: undefined })

  const startDate = windows.current.startDate < windows.previous.startDate
    ? windows.current.startDate
    : windows.previous.startDate
  const endDate = windows.current.endDate > windows.previous.endDate
    ? windows.current.endDate
    : windows.previous.endDate
  const partitions = enumeratePartitions(startDate, endDate)
  const base = useCanonicalSource
    ? { ...runArgs(ctx, partitions), fileSets: { FILES: { table: ctx.table, keys: options.canonicalSource!.keys } } }
    : runArgs(ctx, partitions)

  const main = await runSQL({ ...base, sql: comparison.sql, params: comparison.params })
  const count = await runSQL({ ...base, sql: comparison.countSql, params: comparison.countParams })
  const totalsRow = await runSQL({ ...base, sql: totals.sql, params: totals.params })

  return {
    rows: main.rows,
    totalCount: Number(count.rows[0]?.total ?? 0),
    totals: (totalsRow.rows[0] ?? {}) as Record<string, unknown>,
  }
}

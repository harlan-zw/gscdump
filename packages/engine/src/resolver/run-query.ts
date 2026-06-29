// Pure orchestration of `resolveToSQLOptimized` + `buildExtrasQueries` and
// `resolveComparisonSQL` + `buildTotalsSql` against a caller-supplied
// `runSQL` callable. Hosts wire their own `engine.runSQL` (or a fake) and
// keep auth/tenant routing outside.

import type { Grain } from '@gscdump/contracts'
import type { BuilderState } from 'gscdump/query'
import type { SearchType, TableName } from '../storage'
import type { ComparisonFilter } from './types'
import { buildLogicalPlan } from 'gscdump/query/plan'
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

export interface CanonicalQueryDimSource {
  /** Object keys for the versioned query_dim parquet. */
  keys: string[]
  normalizerVersion: number
  intentVersion?: number
  builtAt?: number
}

export interface PrimaryColumnarSource {
  /** Pre-resolved compacted/Iceberg parquet object keys for the requested fact table. */
  keys: string[]
  /** Oldest covered date (`YYYY-MM-DD`). Omit to assert the source covers all older dates. */
  coversFrom?: string
  /** Newest covered date (`YYYY-MM-DD`). Omit to assert the source covers the current tail. */
  coversThrough?: string
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
   * Deprecated compatibility flag. Canonical reads now derive from query_dim,
   * not a nullable fact-table `query_canonical` column.
   */
  canonicalFallback?: boolean
  /**
   * Versioned query dimension backing canonical reads over fact rows. Required
   * whenever a query groups or filters by `queryCanonical`; a canonical rollup
   * source may carry the same metadata/key set via `canonicalSource.queryDim`.
   */
  queryDim?: CanonicalQueryDimSource
  /**
   * Primary fact-file source for consumer reads. Callers pass compacted or
   * Iceberg data-file keys with explicit coverage metadata; raw daily
   * partitions are only used when `primarySourceFallback: 'raw'` is set.
   */
  primarySource?: PrimaryColumnarSource
  /**
   * Explicit compatibility escape hatch for raw daily shards. Default is
   * strict: missing/empty/stale primary coverage fails with
   * `QuerySourceCoverageError`.
   */
  primarySourceFallback?: 'raw'
  /**
   * Opt-in canonical-primary performance (ADR-0018 Gap 2): object keys of the
   * `query_canonical_daily` rollup parquet(s). When supplied AND the query is
   * coverable (`canonicalRollupCovers`) AND the window is within the rollup's
   * coverage, the MAIN query reads these
   * pre-summed `(query_canonical × date)` rows instead of re-aggregating raw
   * partitions. Variant extras still need fact-grain rows, so they read
   * `primarySource` when present and raw partitions only via
   * `primarySourceFallback: 'raw'`.
   *
   * `coversThrough` (ISO `YYYY-MM-DD`, the rollup's newest covered date) gates
   * staleness: the source is used only when `dateRange.endDate <= coversThrough`,
   * else strict mode fails so the recent tail is never silently undercounted.
   * Omit to assert full coverage (use with care).
   */
  canonicalSource?: {
    keys: string[]
    coversThrough?: string
    queryDim?: CanonicalQueryDimSource
  }
  /**
   * @deprecated Canonical-source misses are recorded on `source.fallbacks`;
   * raw daily fallback is controlled by `primarySourceFallback: 'raw'`.
   */
  canonicalSourceFallback?: 'raw'
  /** Optional version gates for the query dimension backing `canonicalSource`. */
  canonicalRequirements?: {
    normalizerVersion?: number
    intentVersion?: number
  }
}

export type QuerySourceKind = 'canonical-rollup' | 'primary-columnar' | 'raw-partitions'

export type QuerySourceFallbackKind
  = | 'primary-source-missing'
    | 'primary-source-empty'
    | 'primary-source-missing-coverage'
    | 'primary-source-stale-coverage'
    | 'canonical-source-missing'
    | 'canonical-source-empty'
    | 'canonical-source-not-coverable'
    | 'canonical-source-stale-coverage'
    | 'query-dim-missing'
    | 'query-dim-empty'
    | 'query-dim-stale-version'

export interface QuerySourceFallback {
  kind: QuerySourceFallbackKind
  message: string
}

export interface QuerySourceDecision {
  kind: QuerySourceKind
  fallback?: QuerySourceFallback
  fallbacks?: QuerySourceFallback[]
}

export class QuerySourceCoverageError extends Error {
  override name = 'QuerySourceCoverageError'

  constructor(readonly fallback: QuerySourceFallback) {
    super(fallback.message)
  }
}

export interface OptimizedQueryResult {
  rows: Array<Record<string, unknown>>
  totalCount: number
  totals: { clicks: number, impressions: number, ctr: number, position: number }
  extras: Array<{ key: string, rows: Array<Record<string, unknown>> }>
  source: QuerySourceDecision
  extraSource?: QuerySourceDecision
}

export interface ComparisonQueryResult {
  rows: Array<Record<string, unknown>>
  totalCount: number
  totals: Record<string, unknown>
  source: QuerySourceDecision
}

// The rollup is full-history but may lag the newest synced day. Serve it only
// when the requested window ends at/before its coverage, else the live path
// fills the recent tail. No `coversThrough` asserts full coverage.
function canonicalSourceWithinCoverage(source: { coversThrough?: string }, windowEnd: string): boolean {
  return source.coversThrough === undefined || windowEnd <= source.coversThrough
}

function querySourceDecision(kind: QuerySourceKind, fallbacks: QuerySourceFallback[] = []): QuerySourceDecision {
  const first = fallbacks[0]
  return {
    kind,
    ...(first ? { fallback: first, fallbacks } : {}),
  }
}

function canonicalFeatureRequested(state: BuilderState, capabilities: ReturnType<typeof createParquetResolverAdapter>['capabilities']): boolean {
  const plan = buildLogicalPlan(state, capabilities)
  return plan.groupByDimensions.includes('queryCanonical')
    || plan.dimensionFilters.some(f => f.dimension === 'queryCanonical')
}

function fallback(kind: QuerySourceFallbackKind, message: string): QuerySourceFallback {
  return { kind, message }
}

function staleQueryDim(
  source: CanonicalQueryDimSource,
  requirements: RunOptimizedQueryOptions['canonicalRequirements'] | undefined,
): QuerySourceFallback | undefined {
  if (requirements?.normalizerVersion !== undefined && source.normalizerVersion !== requirements.normalizerVersion) {
    return fallback(
      'query-dim-stale-version',
      `canonical query dimension normalizer v${source.normalizerVersion} does not match required v${requirements.normalizerVersion}`,
    )
  }
  if (requirements?.intentVersion !== undefined && source.intentVersion !== requirements.intentVersion) {
    return fallback(
      'query-dim-stale-version',
      `canonical query dimension intent v${source.intentVersion ?? 'missing'} does not match required v${requirements.intentVersion}`,
    )
  }
  return undefined
}

function canonicalQueryDim(options: RunOptimizedQueryOptions): CanonicalQueryDimSource | undefined {
  return options.queryDim ?? options.canonicalSource?.queryDim
}

function queryDimMiss(
  source: CanonicalQueryDimSource | undefined,
  requirements: RunOptimizedQueryOptions['canonicalRequirements'] | undefined,
): QuerySourceFallback | undefined {
  if (!source) {
    return fallback(
      'query-dim-missing',
      'canonical query requires queryDim; fact tables do not carry query_canonical',
    )
  }
  if (source.keys.length === 0) {
    return fallback(
      'query-dim-empty',
      'queryDim has no parquet keys; refusing to run canonical query from an empty dimension',
    )
  }
  return staleQueryDim(source, requirements)
}

function decideCanonicalSource(
  state: BuilderState,
  capabilities: ReturnType<typeof createParquetResolverAdapter>['capabilities'],
  options: RunOptimizedQueryOptions,
  windowEnd: string,
): QuerySourceDecision {
  const canonicalRequested = canonicalFeatureRequested(state, capabilities)
  if (!canonicalRequested) {
    return querySourceDecision('raw-partitions')
  }

  const dimMiss = queryDimMiss(canonicalQueryDim(options), options.canonicalRequirements)
  if (dimMiss)
    throw new QuerySourceCoverageError(dimMiss)

  const source = options.canonicalSource
  const miss = (() => {
    if (!source) {
      return fallback(
        'canonical-source-missing',
        'canonical rollup source missing; falling back to primary facts joined through query_dim',
      )
    }
    if (source.keys.length === 0) {
      return fallback(
        'canonical-source-empty',
        'canonicalSource has no parquet keys; falling back to primary facts joined through query_dim',
      )
    }
    if (!canonicalSourceWithinCoverage(source, windowEnd)) {
      return fallback(
        'canonical-source-stale-coverage',
        `canonicalSource covers through ${source.coversThrough}, but query needs ${windowEnd}`,
      )
    }
    if (!canonicalRollupCovers(state, capabilities)) {
      return fallback(
        'canonical-source-not-coverable',
        'canonicalSource only covers queryCanonical/date reads without raw-grain filters',
      )
    }
    return undefined
  })()

  if (!miss)
    return querySourceDecision('canonical-rollup')
  return querySourceDecision('raw-partitions', [miss])
}

function primarySourceMiss(
  source: PrimaryColumnarSource | undefined,
  dateRange: { startDate: string, endDate: string },
): QuerySourceFallback | undefined {
  if (!source) {
    return fallback(
      'primary-source-missing',
      'primary columnar source is required; pass primarySourceFallback: "raw" to use raw daily partitions explicitly',
    )
  }
  if (source.keys.length === 0) {
    return fallback(
      'primary-source-empty',
      'primarySource has no parquet keys; refusing to return partial or empty data implicitly',
    )
  }
  if (source.coversFrom !== undefined && dateRange.startDate < source.coversFrom) {
    return fallback(
      'primary-source-missing-coverage',
      `primarySource covers from ${source.coversFrom}, but query starts ${dateRange.startDate}`,
    )
  }
  if (source.coversThrough !== undefined && dateRange.endDate > source.coversThrough) {
    return fallback(
      'primary-source-stale-coverage',
      `primarySource covers through ${source.coversThrough}, but query needs ${dateRange.endDate}`,
    )
  }
  return undefined
}

function decidePrimarySource(
  options: RunOptimizedQueryOptions,
  dateRange: { startDate: string, endDate: string },
  priorFallbacks: QuerySourceFallback[] = [],
): QuerySourceDecision {
  const miss = primarySourceMiss(options.primarySource, dateRange)
  if (!miss)
    return querySourceDecision('primary-columnar', priorFallbacks)

  const fallbacks = [...priorFallbacks, miss]
  if (options.primarySourceFallback === 'raw')
    return querySourceDecision('raw-partitions', fallbacks)

  throw new QuerySourceCoverageError(miss)
}

function sourceFallbacks(source: QuerySourceDecision): QuerySourceFallback[] {
  if (source.fallbacks)
    return source.fallbacks
  return source.fallback ? [source.fallback] : []
}

function runArgs(ctx: RunQueryCtx, partitions: string[]): { ctx: { userId: string, siteId: string }, table: RunQueryCtx['table'], fileSets: { FILES: { table: RunQueryCtx['table'], partitions: string[] } }, searchType?: RunQueryCtx['searchType'] } {
  return {
    ctx: { userId: ctx.userId, siteId: ctx.siteId },
    table: ctx.table,
    fileSets: { FILES: { table: ctx.table, partitions } },
    ...(ctx.searchType !== undefined ? { searchType: ctx.searchType } : {}),
  }
}

function primaryRunArgs(ctx: RunQueryCtx, keys: string[]): { ctx: { userId: string, siteId: string }, table: RunQueryCtx['table'], fileSets: { FILES: { table: RunQueryCtx['table'], keys: string[] } }, searchType?: RunQueryCtx['searchType'] } {
  return {
    ctx: { userId: ctx.userId, siteId: ctx.siteId },
    table: ctx.table,
    fileSets: { FILES: { table: ctx.table, keys } },
    ...(ctx.searchType !== undefined ? { searchType: ctx.searchType } : {}),
  }
}

function withQueryDimFileSet<T extends { fileSets: Record<string, { table: TableName, partitions?: string[], keys?: string[] }> }>(
  args: T,
  queryDim: CanonicalQueryDimSource | undefined,
  enabled: boolean,
): T {
  if (!enabled || !queryDim)
    return args
  return {
    ...args,
    fileSets: {
      ...args.fileSets,
      QUERY_DIM: { table: 'queries', keys: queryDim.keys },
    },
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
  const probe = createParquetResolverAdapter()
  const canonicalRequested = canonicalFeatureRequested(state, probe.capabilities)
  const canonicalDecision = decideCanonicalSource(state, probe.capabilities, options, dateRange.endDate)
  const useCanonicalSource = canonicalDecision.kind === 'canonical-rollup'
  const source = useCanonicalSource
    ? canonicalDecision
    : decidePrimarySource(options, dateRange, sourceFallbacks(canonicalDecision))

  // Rollup is already null-free → no fallback needed (and it lacks the raw
  // `query` column the fallback COALESCE would reference).
  const adapter = useCanonicalSource
    ? createParquetResolverAdapter({ queryCanonicalSource: 'column' })
    : probe

  const optimized = resolveToSQLOptimized(state, { adapter, siteId: undefined })
  const extras = buildExtrasQueries(state, { adapter: probe, siteId: undefined })
  const extraSource = extras.length > 0
    ? (useCanonicalSource ? decidePrimarySource(options, dateRange) : source)
    : undefined

  // Main reads rollup keys when eligible. Extras need fact-grain rows, so they
  // use the primary fact source when present and raw partitions only through an
  // explicit fallback.
  const queryDim = canonicalQueryDim(options)
  const mainArgsBase = useCanonicalSource
    ? { ...base, fileSets: { FILES: { table: ctx.table, keys: options.canonicalSource!.keys } } }
    : source.kind === 'primary-columnar'
      ? primaryRunArgs(ctx, options.primarySource!.keys)
      : base
  const mainArgs = withQueryDimFileSet(mainArgsBase, queryDim, canonicalRequested && !useCanonicalSource)
  const extraArgsBase = extraSource?.kind === 'primary-columnar'
    ? primaryRunArgs(ctx, options.primarySource!.keys)
    : base
  const extraArgs = withQueryDimFileSet(extraArgsBase, queryDim, extras.length > 0)

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
        : runSQL({ ...extraArgs, sql: e.sql, params: e.params })
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
    source,
    ...(extraSource ? { extraSource } : {}),
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
  options: RunOptimizedQueryOptions = {},
): Promise<ComparisonQueryResult> {
  const probe = createParquetResolverAdapter()
  const maxWindowEnd = windows.current.endDate > windows.previous.endDate ? windows.current.endDate : windows.previous.endDate
  const currentSource = decideCanonicalSource(current, probe.capabilities, options, maxWindowEnd)
  const previousSource = decideCanonicalSource(previous, probe.capabilities, options, maxWindowEnd)
  const startDate = windows.current.startDate < windows.previous.startDate
    ? windows.current.startDate
    : windows.previous.startDate
  const endDate = windows.current.endDate > windows.previous.endDate
    ? windows.current.endDate
    : windows.previous.endDate
  const comparisonRange = { startDate, endDate }
  const source: QuerySourceDecision = currentSource.kind === 'canonical-rollup' && previousSource.kind === 'canonical-rollup'
    ? querySourceDecision('canonical-rollup')
    : decidePrimarySource(options, comparisonRange, [
        ...sourceFallbacks(currentSource),
        ...sourceFallbacks(previousSource),
      ])
  const useCanonicalSource = source.kind === 'canonical-rollup'
  const adapter = useCanonicalSource
    ? createParquetResolverAdapter({ queryCanonicalSource: 'column' })
    : probe
  const comparison = resolveComparisonSQL(current, previous, { adapter, siteId: undefined }, filter)
  const totals = buildTotalsSql(current, { adapter, siteId: undefined })
  const partitions = enumeratePartitions(startDate, endDate)
  const baseRaw = useCanonicalSource
    ? { ...runArgs(ctx, partitions), fileSets: { FILES: { table: ctx.table, keys: options.canonicalSource!.keys } } }
    : source.kind === 'primary-columnar'
      ? primaryRunArgs(ctx, options.primarySource!.keys)
      : runArgs(ctx, partitions)
  const base = withQueryDimFileSet(baseRaw, canonicalQueryDim(options), !useCanonicalSource && (
    canonicalFeatureRequested(current, probe.capabilities) || canonicalFeatureRequested(previous, probe.capabilities)
  ))

  const main = await runSQL({ ...base, sql: comparison.sql, params: comparison.params })
  const count = await runSQL({ ...base, sql: comparison.countSql, params: comparison.countParams })
  const totalsRow = await runSQL({ ...base, sql: totals.sql, params: totals.params })

  return {
    rows: main.rows,
    totalCount: Number(count.rows[0]?.total ?? 0),
    totals: (totalsRow.rows[0] ?? {}) as Record<string, unknown>,
    source,
  }
}

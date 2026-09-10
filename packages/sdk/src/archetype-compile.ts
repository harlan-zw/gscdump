/**
 * Fail-closed `BuilderState → ArchetypeQuery` compiler.
 *
 * Canonical home for the mapping both consumers used to carry locally
 * (gscdump.com `server/utils/analytics/archetype-compiler.ts` and nuxtseo's
 * `useProGscdump/archetype-builders.ts::builderStateToArchetype`): translate a
 * loosely-typed `{ dimensions, filter, orderBy, rowLimit }` shape into the
 * typed `ArchetypeQuery` surface the archetype executors understand.
 *
 * Every branch FAILS CLOSED to `null` (→ the caller keeps its legacy path)
 * whenever the archetype shape can't represent everything the `BuilderState`
 * asked for. A dropped predicate is a WRONG answer, not a missing feature: a
 * `queryCanonical` filter on a date series once returned the WHOLE-SITE series
 * as if it were the keyword's (nuxtseo keyword detail page, 2026-07-13).
 * This function never throws.
 *
 * Input tolerance: the filter tree may be the SDK-branded `{ _filters }` form
 * OR the partner wire form (`{ type: 'and', filters: [...] }` groups around
 * `{ type, column, value, from, to }` leaves used by legacy hosted payloads).
 * `normalizeBuilderStateResult` from `gscdump/query` parses both into the internal shape,
 * and equality leaves are recognised under both spellings (`eq` / `equals`).
 *
 * Pure — no I/O, no env. Unit-tested directly.
 */

import type {
  ArchetypeFacet,
  ArchetypeQuery,
  EntityDailyTimeseriesQuery,
  GscSearchType,
  WireDateRange,
} from '@gscdump/contracts'
import type { BuilderState, Dimension, Filter, Metric } from 'gscdump/query'
import {
  entityDailyTimeseries as createEntityDailyTimeseries,
  multiSeriesStackedDaily as createMultiSeriesStackedDaily,
  siteDailyTimeseries as createSiteDailyTimeseries,
  topNBreakdown as createTopNBreakdown,
  twoDimensionDetail as createTwoDimensionDetail,
} from '@gscdump/contracts/archetypes'
import { extractDateRange, normalizeBuilderStateResult } from 'gscdump/query'

// The dimensions the compiler knows how to reason about. `searchType` is a
// query param (handled separately via `opts.searchType`/`state.searchType`),
// never a groupable dimension, so it is deliberately excluded here.
const KNOWN_DIMENSIONS = new Set<Dimension>(['query', 'queryCanonical', 'page', 'country', 'device', 'searchAppearance', 'date', 'hour'])

// Comparison operators legitimate ONLY on the `date` dimension (range
// bounds) — `extractWireDateRange` already consumes these; seeing them here
// just confirms the leaf is a date-range clause, not an equality predicate.
const DATE_RANGE_OPERATORS = new Set(['between', 'gte', 'gt', 'lte', 'lt'])

// Both spellings of the equality operator: `equals` (canonical builder / GSC
// API) and `eq` (legacy partner wire format).
const EQUALITY_OPERATORS = new Set(['equals', 'eq'])

// Dimensions an `entity-daily-timeseries` can pin (matches
// `EntityDailyTimeseriesQuery['entity']['dimension']`).
const ENTITY_DIMENSIONS = ['page', 'query', 'queryCanonical'] as const satisfies readonly EntityDailyTimeseriesQuery['entity']['dimension'][]

/**
 * Walk a normalized `Filter` tree collecting `dimension → value` equality
 * pins. Returns `false` (bail) the moment it sees anything an archetype
 * facet can't represent: an OR group (equality-under-OR isn't a flat facet
 * list), a non-equality predicate on a non-date dimension (notEquals /
 * contains / regex / metric HAVING filters), a date-comparison operator on a
 * NON-date dimension, a conflicting equality on the same dimension twice, or
 * a leaf dimension outside {@link KNOWN_DIMENSIONS}. Failing closed here is
 * the whole point: a caller must never get a query silently missing part of
 * its filter.
 */
function collectEqualityMatches(filter: Filter<any> | undefined, out: Map<Dimension, string>): boolean {
  if (!filter)
    return true
  if (filter._groupType === 'or')
    return false
  for (const f of filter._filters) {
    if (f.dimension === 'date') {
      if (!DATE_RANGE_OPERATORS.has(f.operator))
        return false
      continue
    }
    if (!EQUALITY_OPERATORS.has(f.operator) || !KNOWN_DIMENSIONS.has(f.dimension as Dimension))
      return false
    const dim = f.dimension as Dimension
    const existing = out.get(dim)
    if (existing !== undefined && existing !== f.expression)
      return false
    out.set(dim, f.expression)
  }
  for (const nested of filter._nestedGroups ?? []) {
    if (!collectEqualityMatches(nested, out))
      return false
  }
  return true
}

/**
 * Extract the `{ start, end }` date window from a builder-state filter in
 * either accepted format (SDK-branded or partner wire). Returns `null` when no
 * complete range is present.
 */
export function extractWireDateRange(filter: unknown): WireDateRange | null {
  const parsed = normalizeBuilderStateResult({ filter })
  if (!parsed.ok)
    return null
  const { startDate, endDate } = extractDateRange(parsed.value.filter)
  return startDate && endDate ? { start: startDate, end: endDate } : null
}

export interface BuilderStateToArchetypeOptions {
  searchType?: GscSearchType
  compareRange?: WireDateRange
}

/**
 * Translate a `BuilderState` into the best-fit `ArchetypeQuery`, or `null`
 * when the shape can't be expressed (the caller keeps its legacy path — this
 * function never throws).
 *
 * Supported shapes (5 of the archetypes — the others are either caller-driven
 * builders never reached via a BuilderState, `arbitrary-sql`, or
 * `aux-cloud-only`):
 *  - `dimensions: ['date']`, no entity filter                → site-daily-timeseries
 *  - `dimensions: ['date']`, one page/query/queryCanonical
 *    equality                                                → entity-daily-timeseries
 *  - `dimensions: ['date', X]`                               → multi-series-stacked-daily
 *  - `dimensions: [X]` (non-date)                            → top-n-breakdown (extra
 *    equality filters on OTHER dimensions become `facets`)
 *  - `dimensions: ['page','query']` (either order)           → two-dimension-detail
 *
 * Everything else — 0 or 3+ dimensions, no date range, an OR group, a
 * non-equality predicate the target SQL builder can't apply, a
 * `two-dimension-detail` pair that isn't exactly {page, query} (the SQL is
 * hardcoded to `url, query` regardless of which two dims were requested) —
 * returns `null`.
 */
export function builderStateToArchetype(
  siteId: string,
  input: BuilderState,
  opts: BuilderStateToArchetypeOptions = {},
): ArchetypeQuery | null {
  const parsed = normalizeBuilderStateResult(input)
  if (!parsed.ok)
    return null
  const state = parsed.value

  // Archetypes cannot express raw-row predicates or live response options.
  if (state.prefilter !== undefined || state.dataState !== undefined || state.aggregationType !== undefined)
    return null
  const { startDate, endDate } = extractDateRange(state.filter)
  if (!startDate || !endDate)
    return null
  const range = { start: startDate, end: endDate }

  const matches = new Map<Dimension, string>()
  if (!collectEqualityMatches(state.filter, matches))
    return null

  const dims = (state.dimensions ?? []) as Dimension[]
  if (dims.some(d => !KNOWN_DIMENSIONS.has(d)))
    return null
  if (dims.includes('hour') || dims.includes('searchAppearance'))
    return null // no archetype SQL builder groups by these today

  if (dims.includes('date') && (state.rowLimit !== undefined || state.startRow !== undefined || state.orderBy !== undefined))
    return null
  if (state.orderBy?.column === 'date')
    return null

  const searchType = opts.searchType ?? state.searchType
  const metrics = state.metrics
  const cmp = opts.compareRange
  const order = state.orderBy ? { metric: state.orderBy.column as Metric, dir: state.orderBy.dir } : undefined

  // date-only series
  if (dims.length === 1 && dims[0] === 'date') {
    const entityDims = ENTITY_DIMENSIONS.filter(c => matches.has(c))
    if (entityDims.length > 1)
      return null // ArchetypeQuery entity is single-dimension; can't pin more than one of page/query/queryCanonical
    if (entityDims.length === 1) {
      const dim = entityDims[0]!
      if (matches.size > 1)
        return null // an extra unaccounted filter dimension would be silently dropped
      return createEntityDailyTimeseries(siteId, range, { dimension: dim, value: matches.get(dim)! }, { searchType, compareRange: cmp, metrics })
    }
    if (matches.size > 0)
      return null // e.g. a bare country/device filter on a whole-site series — buildSiteDailyTimeseries applies no facets
    return createSiteDailyTimeseries(siteId, range, { searchType, compareRange: cmp, metrics })
  }

  // date + secondary dimension → stacked series
  if (dims.length === 2 && dims.includes('date')) {
    if (matches.size > 0)
      return null // buildMultiSeriesStackedDaily applies no equality facets
    if (metrics !== undefined && metrics.length !== 1)
      return null
    const series = dims.find(d => d !== 'date')!
    return createMultiSeriesStackedDaily(siteId, range, series, { searchType, compareRange: cmp, metric: metrics?.[0] })
  }

  // single non-date dimension → ranked breakdown. top-n-breakdown is the one
  // archetype whose SQL builder actually applies `facets`, so extra equality
  // matches on OTHER dimensions (e.g. "top queries for this one page") are
  // preserved instead of dropped.
  if (dims.length === 1 && dims[0] !== 'date') {
    const primary = dims[0]!
    if (matches.has(primary))
      return null // grouping AND pinning the same dimension is ambiguous — single-row-lookup is the right shape, not reachable from this compiler
    const facets: ArchetypeFacet[] = [...matches.entries()].map(([column, value]) => ({ column, op: 'eq' as const, value }))
    return createTopNBreakdown(siteId, range, primary, {
      searchType,
      metrics,
      compareRange: cmp,
      ...(order ? { orderBy: order } : {}),
      limit: state.rowLimit ?? 50,
      ...(state.startRow ? { offset: state.startRow } : {}),
      ...(facets.length ? { facets } : {}),
    })
  }

  // two non-date dimensions → page × query detail grid. buildTwoDimensionDetail
  // is hardcoded to (url, query) regardless of which two dims were requested,
  // so only compile when the pair really IS {page, query} — anything else
  // (e.g. country × device) would silently return the wrong grid.
  if (dims.length === 2 && !dims.includes('date')) {
    if (state.startRow !== undefined && state.startRow !== 0)
      return null
    const set = new Set(dims)
    if (!set.has('page') || !set.has('query'))
      return null
    if (matches.size > 0)
      return null // two-dimension-detail's `filter` only takes page/query values, not arbitrary facets
    return createTwoDimensionDetail(siteId, range, {
      searchType,
      metrics,
      compareRange: cmp,
      ...(order ? { orderBy: order } : {}),
      ...(state.rowLimit ? { limit: state.rowLimit } : {}),
    })
  }

  return null
}

/**
 * Archetypes a hosted seam's execution wrapper can safely serve end-to-end
 * today (rows + an ACCURATE `totalCount`/`totals`, matching the legacy
 * `R2QueryResult` contract). `builderStateToArchetype` above can produce a
 * `two-dimension-detail` query, but `TwoDimensionDetailQuery`/
 * `buildTwoDimensionDetail` support neither `offset` nor `includeTotal` —
 * there is no way to get an exact grand total or paginate past page 1 through
 * the dispatcher yet, so seam wrappers decline it (same as a compile miss)
 * rather than serve a wrong `totalCount`. Revisit once the contract grows
 * those fields.
 */
export function archetypeSeamSupportsQuery(query: ArchetypeQuery): boolean {
  return query.archetype !== 'two-dimension-detail'
}

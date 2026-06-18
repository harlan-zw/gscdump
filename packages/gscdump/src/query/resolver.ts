import type { GscSearchAnalyticsDimension, GscSearchAnalyticsFilterGroup, GscSearchAnalyticsFilterOperator, GscSearchAnalyticsRequest, GscSearchType } from '../contracts'
import type { Result } from '../core/result'
import type { SearchType } from './constants'
import type { QueryError } from './errors'
import type { BuilderState, Filter, FilterInput, InternalFilter, JsonFilter } from './types'
import { addDays } from '../core/gsc-dates'
import { err, ok, unwrapResult } from '../core/result'
import { SearchTypes } from './constants'
import { queryErrors, queryErrorToException } from './errors'
import { isDateOperator, isMetricOperator, isQueryParam, isSpecialOperator } from './operator-meta'

const KNOWN_SEARCH_TYPES = new Set<string>(Object.values(SearchTypes))

// Check if value is a JSON filter (serialized) vs a real Filter object
export function isJsonFilter(value: unknown): value is JsonFilter {
  return (
    typeof value === 'object'
    && value !== null
    && '_filters' in value
    && Array.isArray((value as JsonFilter)._filters)
  )
}

// Convert JSON filter to Filter object
export function parseJsonFilter(json: JsonFilter): Filter<any> {
  return {
    _constraints: {},
    _filters: json._filters.map(f => ({
      dimension: f.dimension,
      operator: f.operator,
      expression: f.expression,
      expression2: f.expression2,
    } as InternalFilter)),
    _nestedGroups: json._nestedGroups?.map(parseJsonFilter),
    _groupType: json._groupType,
  } as Filter<any>
}

// Wire-format filter shape used by partner clients (e.g. nuxtseo.com pro).
// Groups are `{ type: 'and' | 'or', filters: [...] }`; leaves are
// `{ type: <op>, column, value, from, to }`. The SDK's branded `Filter<any>`
// shape has `_filters`, `_nestedGroups`, `_groupType` and `dimension`/
// `operator`/`expression` on leaves. Convert here so a single normalize step
// handles both formats uniformly.
interface AltFilter {
  type?: string
  column?: string
  from?: string
  to?: string
  value?: string
  filters?: AltFilter[]
}

function isWireGroupType(type: string | undefined): type is 'and' | 'or' {
  return type === 'and' || type === 'or'
}

function convertWireLeaf(alt: AltFilter): InternalFilter | null {
  if (!alt.column || !alt.type || isWireGroupType(alt.type))
    return null
  const f: InternalFilter = {
    dimension: alt.column as InternalFilter['dimension'],
    operator: alt.type as InternalFilter['operator'],
    expression: alt.type === 'between' ? (alt.from ?? '') : (alt.value ?? ''),
  }
  if (alt.type === 'between' && alt.to)
    f.expression2 = alt.to
  return f
}

function convertWireGroup(alt: AltFilter): Filter<any> | null {
  if (!isWireGroupType(alt.type)) {
    const leaf = convertWireLeaf(alt)
    return leaf ? ({ _filters: [leaf] } as Filter<any>) : null
  }
  const leaves: InternalFilter[] = []
  const nested: Filter<any>[] = []
  for (const child of alt.filters ?? []) {
    if (isWireGroupType(child.type)) {
      const sub = convertWireGroup(child)
      if (sub)
        nested.push(sub)
    }
    else {
      const leaf = convertWireLeaf(child)
      if (leaf)
        leaves.push(leaf)
    }
  }
  if (leaves.length === 0 && nested.length === 0)
    return null
  return {
    _filters: leaves,
    _nestedGroups: nested.length > 0 ? nested : undefined,
    _groupType: alt.type,
  } as Filter<any>
}

function isWireFilter(input: unknown): input is AltFilter {
  if (!input || typeof input !== 'object')
    return false
  const o = input as Record<string, unknown>
  if ('_filters' in o)
    return false
  return ('type' in o && typeof o.type === 'string')
    || ('filters' in o && Array.isArray(o.filters))
}

// Normalize input to Filter (handles SDK Filter, JsonFilter, and partner
// wire format `{ type, filters | column, value, from, to }`).
export function normalizeFilter(input?: FilterInput): Filter<any> | undefined {
  if (!input)
    return undefined
  if (isWireFilter(input))
    return convertWireGroup(input as AltFilter) ?? undefined
  // SDK Filter / JsonFilter both expose an ARRAY `_filters`. Only pass an object
  // through when it is structurally a filter group — a malformed body (no
  // `_filters`, or a non-array `_filters`) would otherwise crash the downstream
  // `for (const f of filter._filters)` / `filter._filters.filter(...)` consumers
  // with `_filters is not iterable` (GSCDUMP-9). Treat it as "no filter".
  if (typeof input === 'object' && Array.isArray((input as Filter<any>)._filters))
    return input as Filter<any>
  return undefined
}

// Project an untyped partner-API request body into a typed BuilderState,
// normalizing the embedded filter from wire format. Use at the receive edge
// of partner endpoints that accept JSON bodies from SDK consumers.
/**
 * Errors-as-values core for {@link normalizeBuilderState}: returns an
 * `invalid-builder-state` `QueryError` when the untrusted partner-API body is
 * not an object, instead of throwing. Receive-edge parse, so hosts can map a bad
 * body to a 4xx.
 */
export function normalizeBuilderStateResult(state: unknown): Result<BuilderState, QueryError> {
  if (!state || typeof state !== 'object')
    return err(queryErrors.invalidBuilderState(state))
  const s = state as Record<string, unknown>
  const normalized: BuilderState = {
    // `dimensions` is iterated and `.includes()`d downstream (host handlers +
    // plan.ts `[...state.dimensions]`). A missing/non-array value from an
    // untrusted body crashed with `dimensions is undefined` (GSCDUMP-8); coerce
    // to [] (a valid totals query) so the output invariant holds.
    dimensions: (Array.isArray(s.dimensions) ? s.dimensions : []) as BuilderState['dimensions'],
    // `metrics` must pass through UNTOUCHED: plan.ts treats `undefined` as
    // "default to all 4 metrics" (`state.metrics ? … : [clicks,impressions,…]`).
    // Coercing `undefined → []` (truthy) selected NO metrics, so `ORDER BY
    // impressions` hit an ungrouped column → R2 SQL 40004 on every range-bound
    // page-breakdown query (GSCDUMP-A/C). Leave the undefined sentinel intact.
    metrics: s.metrics as BuilderState['metrics'],
    filter: normalizeFilter(s.filter as FilterInput | undefined) as BuilderState['filter'],
    orderBy: s.orderBy as BuilderState['orderBy'],
    rowLimit: s.rowLimit as number | undefined,
    startRow: s.startRow as number | undefined,
    dataState: s.dataState as BuilderState['dataState'],
    aggregationType: s.aggregationType as BuilderState['aggregationType'],
  }
  if (typeof s.searchType === 'string' && KNOWN_SEARCH_TYPES.has(s.searchType))
    normalized.searchType = s.searchType as SearchType
  return ok(normalized)
}

export function normalizeBuilderState(state: unknown): BuilderState {
  return unwrapResult(normalizeBuilderStateResult(state), queryErrorToException)
}

interface FilterExtraction {
  startDate?: string
  endDate?: string
  searchType?: string
  dimensionFilter?: Filter<any>
}

function extractSpecialFilters(filter?: Filter<any>): FilterExtraction {
  // Defensive: a filter whose `_filters` isn't an array (malformed partner body
  // reaching a direct caller that bypassed normalizeFilter) would crash the
  // `for (const f of filter._filters)` below — treat it as no special filters.
  if (!filter || !Array.isArray(filter._filters))
    return {}

  let startDate: string | undefined
  let endDate: string | undefined
  let searchType: string | undefined
  const otherFilters: InternalFilter[] = []
  const cleanedNestedGroups: Filter<any>[] = []

  // Process flat filters
  for (const f of filter._filters) {
    if (f.dimension === 'date' && isDateOperator(f.operator)) {
      // Process date filters
      switch (f.operator) {
        case 'gte':
          startDate = f.expression
          break
        case 'gt':
          startDate = addDays(f.expression, 1)
          break
        case 'lte':
          endDate = f.expression
          break
        case 'lt':
          endDate = addDays(f.expression, -1)
          break
        case 'between':
          startDate = f.expression
          endDate = f.expression2
          break
      }
    }
    else if (isQueryParam(f.dimension)) {
      // Process query param filters
      if (f.dimension === 'searchType') {
        searchType = f.expression
      }
    }
    else if (isMetricOperator(f.operator) || isSpecialOperator(f.operator)) {
      // Metric and special filters are server-side only, skip for GSC API body
      // but preserve in otherFilters so getState() retains them
      otherFilters.push(f)
    }
    else {
      otherFilters.push(f)
    }
  }

  // Process nested groups recursively.
  // Outer-scope date/searchType wins: nested-group values are only adopted
  // when the outer scope didn't set them. Otherwise an inner OR group could
  // silently override the user's top-level date range.
  if (filter._nestedGroups) {
    for (const nested of filter._nestedGroups) {
      const extracted = extractSpecialFilters(nested)
      if (!startDate && extracted.startDate)
        startDate = extracted.startDate
      if (!endDate && extracted.endDate)
        endDate = extracted.endDate
      if (!searchType && extracted.searchType)
        searchType = extracted.searchType
      if (extracted.dimensionFilter) {
        cleanedNestedGroups.push(extracted.dimensionFilter)
      }
    }
  }

  const dimensionFilter = (otherFilters.length > 0 || cleanedNestedGroups.length > 0)
    ? {
        ...filter,
        _filters: otherFilters,
        _nestedGroups: cleanedNestedGroups.length > 0 ? cleanedNestedGroups : undefined,
      } as Filter<any>
    : undefined

  return { startDate, endDate, searchType, dimensionFilter }
}

export function extractDateRange(input?: FilterInput): { startDate?: string, endDate?: string } {
  const filter = normalizeFilter(input)
  const { startDate, endDate } = extractSpecialFilters(filter)
  return { startDate, endDate }
}

export function extractMetricFilters(input?: FilterInput): InternalFilter[] {
  const filter = normalizeFilter(input)
  if (!filter)
    return []
  const metricFilters = filter._filters.filter(f => isMetricOperator(f.operator))
  const nested = filter._nestedGroups?.flatMap(g => extractMetricFilters(g)) ?? []
  return [...metricFilters, ...nested]
}

export function extractSpecialOperatorFilters(input?: FilterInput): InternalFilter[] {
  const filter = normalizeFilter(input)
  if (!filter)
    return []
  const special = filter._filters.filter(f => isSpecialOperator(f.operator))
  const nested = filter._nestedGroups?.flatMap(g => extractSpecialOperatorFilters(g)) ?? []
  return [...special, ...nested]
}

/**
 * Pull `searchType` out of a BuilderState filter. Returns undefined for
 * missing/invalid shapes — callers treat that as "no scope" (cross-type read).
 * Validated against the canonical `SearchTypes` set so unknown strings
 * don't reach the engine.
 */
export function extractSearchType(state: BuilderState | undefined | null): SearchType | undefined {
  if (!state)
    return undefined
  // Top-level builder .type() wins over filter-embedded searchType.
  if (state.searchType && KNOWN_SEARCH_TYPES.has(state.searchType))
    return state.searchType
  const filter = (state as { filter?: unknown }).filter
  if (!filter || typeof filter !== 'object')
    return undefined
  const raw = (filter as { searchType?: unknown }).searchType
  if (typeof raw !== 'string' || raw.length === 0)
    return undefined
  return KNOWN_SEARCH_TYPES.has(raw) ? raw as SearchType : undefined
}

/**
 * Errors-as-values core: turns a `BuilderState` into a GSC API request body or
 * returns a typed `QueryError` for every modelled bad-query case (missing date
 * range, out-of-range row limit / start row, hour/dataState mismatch, illegal
 * aggregationType combination). `resolveToBody` is the throwing wrapper over this
 * for `.toBody()` and the live-API client paths.
 */
export function resolveToBodyResult(state: BuilderState): Result<GscSearchAnalyticsRequest, QueryError> {
  // Extract date constraints and query params from filter
  const { startDate, endDate, searchType, dimensionFilter } = extractSpecialFilters(state.filter)

  if (!startDate || !endDate)
    return err(queryErrors.missingDateRange())

  const body: GscSearchAnalyticsRequest = {
    dimensions: state.dimensions as GscSearchAnalyticsDimension[],
    startDate,
    endDate,
  }

  // Builder-level .type() overrides any searchType filter.
  const resolvedType = state.searchType ?? searchType
  if (resolvedType) {
    body.type = resolvedType as GscSearchType
  }

  if (state.rowLimit !== undefined) {
    if (!Number.isInteger(state.rowLimit) || state.rowLimit < 1)
      return err(queryErrors.invalidRowLimit(state.rowLimit))
    // Builder `.limit(n)` is a *total* row cap; the pagination layer in
    // `client.query` paginates in ≤25k chunks. Pass through unclamped so
    // `.toBody()` callers retain the original intent.
    body.rowLimit = state.rowLimit
  }

  if (state.startRow !== undefined) {
    if (!Number.isInteger(state.startRow) || state.startRow < 0)
      return err(queryErrors.invalidStartRow(state.startRow))
    if (state.startRow > 0)
      body.startRow = state.startRow
  }

  const hasHour = state.dimensions?.includes('hour' as GscSearchAnalyticsDimension)
  if (hasHour && state.dataState !== 'hourly_all')
    return err(queryErrors.hourDimensionRequiresHourlyState())
  if (state.dataState === 'hourly_all' && !hasHour)
    return err(queryErrors.hourlyStateRequiresHourDimension())

  if (state.dataState) {
    body.dataState = state.dataState
  }

  const filterGroups = resolveFilter(dimensionFilter)
  if (filterGroups.length > 0) {
    body.dimensionFilterGroups = filterGroups
  }

  if (state.aggregationType) {
    const groupsByPage = (body.dimensions ?? []).includes('page' as GscSearchAnalyticsDimension)
    const apiLeafFilters = filterGroups.flatMap(g => g.filters ?? [])
    const filtersByPage = apiLeafFilters.some(f => f.dimension === 'page')

    if (state.aggregationType === 'byProperty') {
      if (body.type === 'discover' || body.type === 'googleNews')
        return err(queryErrors.byPropertyUnsupportedSearchType())
      if (groupsByPage || filtersByPage)
        return err(queryErrors.byPropertyNotAllowedWithPage())
    }
    if (state.aggregationType === 'byNewsShowcasePanel') {
      if (body.type !== 'discover' && body.type !== 'googleNews')
        return err(queryErrors.byNewsShowcaseRequiresSearchType())
      if (groupsByPage || filtersByPage)
        return err(queryErrors.byNewsShowcaseNotAllowedWithPage())
      const saFilters = apiLeafFilters.filter(f => f.dimension === 'searchAppearance')
      const hasNewsShowcase = saFilters.some(f => f.operator === 'equals' && f.expression === 'NEWS_SHOWCASE')
      const hasOther = saFilters.some(f => !(f.operator === 'equals' && f.expression === 'NEWS_SHOWCASE'))
      if (!hasNewsShowcase || hasOther)
        return err(queryErrors.byNewsShowcaseRequiresShowcaseFilter())
    }
    body.aggregationType = state.aggregationType
  }

  return ok(body)
}

export function resolveToBody(state: BuilderState): GscSearchAnalyticsRequest {
  return unwrapResult(resolveToBodyResult(state), queryErrorToException)
}

function isApiFilter(f: InternalFilter): boolean {
  return !isMetricOperator(f.operator) && !isSpecialOperator(f.operator)
}

function resolveFilter(filter?: Filter<any>): GscSearchAnalyticsFilterGroup[] {
  if (!filter)
    return []

  const groups: GscSearchAnalyticsFilterGroup[] = []
  const groupType = filter._groupType ?? 'and'
  const apiFilters = filter._filters.filter(isApiFilter)

  // NOTE: Google docs flag `groupType: 'or'` as "not yet supported", but the API
  // currently accepts it on the searchAnalytics.query endpoint. We pass it through
  // and let Google decide; revisit if 400s start appearing in the wild.
  if (groupType === 'or') {
    if (apiFilters.length > 0) {
      groups.push({
        groupType: 'or',
        filters: apiFilters.map(f => ({
          dimension: f.dimension as GscSearchAnalyticsDimension,
          operator: f.operator as GscSearchAnalyticsFilterOperator,
          expression: f.expression,
        })),
      })
    }
  }
  else if (apiFilters.length > 0) {
    groups.push({
      filters: apiFilters.map(f => ({
        dimension: f.dimension as GscSearchAnalyticsDimension,
        operator: f.operator as GscSearchAnalyticsFilterOperator,
        expression: f.expression,
      })),
    })
  }

  // Process nested groups (preserved OR groups from and())
  if (filter._nestedGroups) {
    for (const nested of filter._nestedGroups) {
      groups.push(...resolveFilter(nested))
    }
  }

  return groups
}

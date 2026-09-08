import type { GscSearchAnalyticsDimension, GscSearchAnalyticsFilterGroup, GscSearchAnalyticsFilterOperator, GscSearchAnalyticsRequest, GscSearchType } from '../contracts'
import type { Result } from '../core/result'
import type { SearchType } from './constants'
import type { QueryError } from './errors'
import type { BuilderState, Filter, FilterInput, InternalFilter } from './types'
import { addDays } from '../core/gsc-dates'
import { err, ok, unwrapResult } from '../core/result'
import { SearchTypes } from './constants'
import { queryErrors, queryErrorToException } from './errors'
import { isDateOperator, isMetric, isMetricOperator, isQueryParam, isSpecialOperator } from './operator-meta'

const KNOWN_DIMENSIONS = new Set<string>(['page', 'query', 'queryCanonical', 'country', 'device', 'date', 'hour', 'searchAppearance'])
const FILTER_OPERATORS = new Set<string>(['equals', 'notEquals', 'contains', 'notContains', 'includingRegex', 'excludingRegex'])
const KNOWN_SEARCH_TYPES = new Set<string>(Object.values(SearchTypes))

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(item => typeof item === 'string')
}

function isCalendarDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value))
    return false
  const parsed = new Date(`${value}T00:00:00Z`)
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value
}

// Parse both SDK groups and partner wire groups without dropping malformed leaves.
function parseFilterResult(input: unknown, ancestors = new Set<object>()): Result<Filter<any> | undefined, QueryError> {
  if (input === undefined)
    return ok(undefined)
  if (!isRecord(input) || ancestors.has(input))
    return err(queryErrors.malformedFilterLeaf())
  ancestors.add(input)
  const invalid = (): Result<never, QueryError> => err(queryErrors.malformedFilterLeaf())
  const leaves: InternalFilter[] = []
  const nested: Filter<any>[] = []
  const wire = !('_filters' in input)
  const groupType = wire ? input.type : input._groupType
  const isGroup = groupType === 'and' || groupType === 'or'
  if (!wire && groupType !== undefined && !isGroup)
    return invalid()
  const values = wire ? (isGroup ? input.filters : [input]) : input._filters
  if (!Array.isArray(values))
    return invalid()
  for (const value of values) {
    if (!isRecord(value))
      return invalid()
    if (wire && (value.type === 'and' || value.type === 'or')) {
      const parsed = parseFilterResult(value, ancestors)
      if (!parsed.ok)
        return parsed
      if (parsed.value)
        nested.push(parsed.value)
      continue
    }
    const dimension = wire ? value.column : value.dimension
    const operator = wire ? (value.type === 'eq' ? 'equals' : value.type === 'ne' ? 'notEquals' : value.type) : value.operator
    const between = operator === 'between' || operator === 'metricBetween'
    const expression = wire ? (between ? value.from : value.value) : value.expression
    const expression2 = wire ? (between ? value.to : undefined) : value.expression2
    if (typeof dimension !== 'string' || !dimension || typeof operator !== 'string' || !operator
      || typeof expression !== 'string' || (expression2 !== undefined && typeof expression2 !== 'string')
      || (between && expression2 === undefined)) {
      return invalid()
    }
    if (!KNOWN_DIMENSIONS.has(dimension) && !isMetric(dimension) && !isQueryParam(dimension))
      return invalid()
    if (!FILTER_OPERATORS.has(operator) && !isDateOperator(operator) && !isMetricOperator(operator) && !isSpecialOperator(operator))
      return invalid()
    if (dimension === 'searchType' && (operator !== 'equals' || !KNOWN_SEARCH_TYPES.has(expression)))
      return invalid()
    if (isDateOperator(operator) && (dimension !== 'date' || !isCalendarDate(expression)
      || (expression2 !== undefined && !isCalendarDate(expression2)))) {
      return invalid()
    }
    if (isMetricOperator(operator) && (!isMetric(dimension) || !expression.trim() || !Number.isFinite(Number(expression))
      || (expression2 !== undefined && (!expression2.trim() || !Number.isFinite(Number(expression2)))))) {
      return invalid()
    }
    leaves.push({ dimension, operator, expression, ...(expression2 !== undefined ? { expression2 } : {}) } as InternalFilter)
  }
  if (!wire && input._nestedGroups !== undefined) {
    if (!Array.isArray(input._nestedGroups))
      return invalid()
    for (const group of input._nestedGroups) {
      const parsed = parseFilterResult(group, ancestors)
      if (!parsed.ok)
        return parsed
      if (!parsed.value)
        return invalid()
      nested.push(parsed.value)
    }
  }
  if (groupType === 'or' && (leaves.length === 0 || nested.length > 0
    || leaves.some(leaf => leaf.dimension === 'searchType' || (leaf.dimension === 'date' && isDateOperator(leaf.operator))))) {
    return invalid()
  }
  ancestors.delete(input)
  return ok({
    _filters: leaves,
    ...(nested.length ? { _nestedGroups: nested } : {}),
    ...(isGroup ? { _groupType: groupType } : {}),
  } as Filter<any>)
}

export function normalizeFilter(input?: FilterInput): Filter<any> | undefined {
  return unwrapResult(parseFilterResult(input), queryErrorToException)
}

type OrderBy = NonNullable<BuilderState['orderBy']>

// Accept canonical ordering and a single legacy { column, desc } specification.
function normalizeOrderBy(orderBy: unknown): OrderBy | undefined {
  if (Array.isArray(orderBy) && orderBy.length !== 1)
    return undefined
  const spec = Array.isArray(orderBy) ? orderBy[0] : orderBy
  if (!spec || typeof spec !== 'object')
    return undefined
  const o = spec as Record<string, unknown>
  if (typeof o.column !== 'string' || (!isMetric(o.column) && o.column !== 'date'))
    return undefined
  if (o.dir !== undefined && (typeof o.dir !== 'string' || !['asc', 'desc'].includes(o.dir.toLowerCase())))
    return undefined
  if (o.desc !== undefined && typeof o.desc !== 'boolean')
    return undefined
  const dir = typeof o.dir === 'string'
    ? (o.dir.toLowerCase() === 'asc' ? 'asc' : 'desc')
    : (o.desc === false ? 'asc' : 'desc')
  if (typeof o.desc === 'boolean' && o.desc !== (dir === 'desc'))
    return undefined
  return { column: o.column as OrderBy['column'], dir }
}

/** Parse an untrusted query body. Expected input failures stay in the error channel. */
export function normalizeBuilderStateResult(state: unknown): Result<BuilderState, QueryError> {
  if (!isRecord(state))
    return err(queryErrors.invalidBuilderState(state))
  const s = state
  const invalidState = (message: string): Result<never, QueryError> => err({ ...queryErrors.invalidBuilderState(state), message })
  if (s.dimensions !== undefined && (!isStringArray(s.dimensions) || !s.dimensions.every(dimension => KNOWN_DIMENSIONS.has(dimension))))
    return invalidState(`dimensions must contain valid names: ${[...KNOWN_DIMENSIONS].join(', ')}.`)
  if (s.metrics !== undefined && (!isStringArray(s.metrics) || !s.metrics.every(isMetric)))
    return invalidState('metrics must contain clicks, impressions, ctr, or position.')
  if (s.searchType !== undefined && (typeof s.searchType !== 'string' || !KNOWN_SEARCH_TYPES.has(s.searchType)))
    return invalidState(`searchType must be one of: ${[...KNOWN_SEARCH_TYPES].join(', ')}.`)
  if (s.dataState !== undefined && !['all', 'final', 'hourly_all'].includes(s.dataState as string))
    return invalidState('dataState must be all, final, or hourly_all.')
  if (s.aggregationType !== undefined && !['auto', 'byPage', 'byProperty', 'byNewsShowcasePanel'].includes(s.aggregationType as string))
    return invalidState('aggregationType must be auto, byPage, byProperty, or byNewsShowcasePanel.')
  if (s.rowLimit !== undefined && (!Number.isSafeInteger(s.rowLimit) || (s.rowLimit as number) < 1))
    return err(queryErrors.invalidRowLimit(s.rowLimit))
  if (s.startRow !== undefined && (!Number.isSafeInteger(s.startRow) || (s.startRow as number) < 0))
    return err(queryErrors.invalidStartRow(s.startRow))
  const orderBy = normalizeOrderBy(s.orderBy)
  if (s.orderBy !== undefined && orderBy === undefined)
    return invalidState('orderBy requires a metric or date column and a consistent asc or desc direction.')
  const filter = parseFilterResult(s.filter)
  if (!filter.ok)
    return filter
  const prefilter = parseFilterResult(s.prefilter)
  if (!prefilter.ok)
    return prefilter
  return ok({
    dimensions: (s.dimensions ?? []) as BuilderState['dimensions'],
    // Omitted metrics select all metrics. An empty array is an explicit selection.
    metrics: s.metrics as BuilderState['metrics'],
    filter: filter.value,
    prefilter: prefilter.value,
    orderBy,
    rowLimit: s.rowLimit as number | undefined,
    startRow: s.startRow as number | undefined,
    dataState: s.dataState as BuilderState['dataState'],
    aggregationType: s.aggregationType as BuilderState['aggregationType'],
    searchType: s.searchType as SearchType | undefined,
  })
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
  const normalized = normalizeFilter(filter as FilterInput | undefined)
  const raw = extractSpecialFilters(normalized).searchType
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

import type { GscSearchAnalyticsDimension, GscSearchAnalyticsFilterGroup, GscSearchAnalyticsFilterOperator, GscSearchAnalyticsRequest, GscSearchType } from '../contracts'
import type { SearchType } from './constants'
import type { BuilderState, Filter, FilterInput, InternalFilter, JsonFilter } from './types'
import { addDays } from '../core/gsc-dates'
import { SearchTypes } from './constants'
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
  // SDK Filter / JsonFilter both expose `_filters` — pass through.
  return input as Filter<any>
}

interface FilterExtraction {
  startDate?: string
  endDate?: string
  searchType?: string
  dimensionFilter?: Filter<any>
}

function extractSpecialFilters(filter?: Filter<any>): FilterExtraction {
  if (!filter)
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

  // Process nested groups recursively
  if (filter._nestedGroups) {
    for (const nested of filter._nestedGroups) {
      const extracted = extractSpecialFilters(nested)
      // Merge date/searchType from nested
      if (extracted.startDate)
        startDate = extracted.startDate
      if (extracted.endDate)
        endDate = extracted.endDate
      if (extracted.searchType)
        searchType = extracted.searchType
      // Keep cleaned nested filter if it has dimension filters
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
  const filter = (state as { filter?: unknown }).filter
  if (!filter || typeof filter !== 'object')
    return undefined
  const raw = (filter as { searchType?: unknown }).searchType
  if (typeof raw !== 'string' || raw.length === 0)
    return undefined
  return KNOWN_SEARCH_TYPES.has(raw) ? raw as SearchType : undefined
}

export function resolveToBody(state: BuilderState): GscSearchAnalyticsRequest {
  // Extract date constraints and query params from filter
  const { startDate, endDate, searchType, dimensionFilter } = extractSpecialFilters(state.filter)

  if (!startDate || !endDate) {
    throw new Error('Date range required: use .where(between(date, start, end)) or .where(and(gte(date, start), lte(date, end)))')
  }

  const body: GscSearchAnalyticsRequest = {
    dimensions: state.dimensions as GscSearchAnalyticsDimension[],
    startDate,
    endDate,
  }

  if (searchType) {
    body.searchType = searchType as GscSearchType
  }

  if (state.rowLimit) {
    body.rowLimit = state.rowLimit
  }

  if (state.startRow) {
    body.startRow = state.startRow
  }

  const filterGroups = resolveFilter(dimensionFilter)
  if (filterGroups.length > 0) {
    body.dimensionFilterGroups = filterGroups
  }

  return body
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

  if (groupType === 'or') {
    // OR group - all filters in one group with OR logic
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
  else {
    // AND - flat filters become one AND group
    if (apiFilters.length > 0) {
      groups.push({
        filters: apiFilters.map(f => ({
          dimension: f.dimension as GscSearchAnalyticsDimension,
          operator: f.operator as GscSearchAnalyticsFilterOperator,
          expression: f.expression,
        })),
      })
    }
  }

  // Process nested groups (preserved OR groups from and())
  if (filter._nestedGroups) {
    for (const nested of filter._nestedGroups) {
      groups.push(...resolveFilter(nested))
    }
  }

  return groups
}

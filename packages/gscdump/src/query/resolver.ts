import type { DimensionFilterGroup, SearchAnalyticsQuery } from '../core/types'
import type { BuilderState, DateOperator, Filter, FilterInput, InternalFilter, JsonFilter, MetricOperator, QueryParamName, SpecialOperator } from './types'

const DATE_OPERATORS: DateOperator[] = ['gte', 'gt', 'lte', 'lt', 'between']
const METRIC_OPERATORS: MetricOperator[] = ['metricGte', 'metricGt', 'metricLte', 'metricLt', 'metricBetween']
const SPECIAL_OPERATORS: SpecialOperator[] = ['topLevel']
const QUERY_PARAMS: QueryParamName[] = ['searchType']

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

// Normalize input to Filter (handles both Filter and JsonFilter)
function normalizeFilter(input?: FilterInput): Filter<any> | undefined {
  if (!input)
    return undefined
  // JsonFilter has _filters but lacks the symbol brand
  // We can just treat it as Filter since we only access _filters/_nestedGroups/_groupType
  return input as Filter<any>
}

function isMetricOperator(op: string): boolean {
  return METRIC_OPERATORS.includes(op as MetricOperator)
}

function isSpecialOperator(op: string): boolean {
  return SPECIAL_OPERATORS.includes(op as SpecialOperator)
}

function isDateOperator(op: string): op is DateOperator {
  return DATE_OPERATORS.includes(op as DateOperator)
}

function isQueryParam(dim: string): dim is QueryParamName {
  return QUERY_PARAMS.includes(dim as QueryParamName)
}

function addDays(dateStr: string, days: number): string {
  const d = new Date(dateStr)
  d.setDate(d.getDate() + days)
  return d.toISOString().split('T')[0]
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

export function resolveToBody(state: BuilderState): SearchAnalyticsQuery {
  // Extract date constraints and query params from filter
  const { startDate, endDate, searchType, dimensionFilter } = extractSpecialFilters(state.filter)

  if (!startDate || !endDate) {
    throw new Error('Date range required: use .where(between(date, start, end)) or .where(and(gte(date, start), lte(date, end)))')
  }

  const body: SearchAnalyticsQuery = {
    dimensions: state.dimensions,
    startDate,
    endDate,
  }

  if (searchType) {
    body.searchType = searchType
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

function resolveFilter(filter?: Filter<any>): DimensionFilterGroup[] {
  if (!filter)
    return []

  const groups: DimensionFilterGroup[] = []
  const groupType = filter._groupType ?? 'and'
  const apiFilters = filter._filters.filter(isApiFilter)

  if (groupType === 'or') {
    // OR group - all filters in one group with OR logic
    if (apiFilters.length > 0) {
      groups.push({
        groupType: 'or',
        filters: apiFilters.map(f => ({
          dimension: f.dimension,
          operator: f.operator,
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
          dimension: f.dimension,
          operator: f.operator,
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

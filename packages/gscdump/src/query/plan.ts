import type { TableName } from '../contracts'
import type {
  BuilderState,
  Dimension,
  FilterInput,
  FilterOperator,
  InternalFilter,
  Metric,
  MetricOperator,
  QueryParamName,
} from './types'

import { isDateOperator, isMetric, isQueryParam, isRegexOperator } from './operator-meta'
import {
  extractDateRange,
  extractMetricFilters,
  extractSpecialOperatorFilters,
  normalizeFilter,
} from './resolver'

export type { TableName } from '../contracts'

// One source of truth: a logical dataset IS a storage table name. The engine
// compiler and analysis adapters both consume `LogicalDataset`; keeping the
// alias here means a new table in `analytics/storage` automatically becomes a
// valid dataset, and rename drift fails to compile.
export type LogicalDataset = TableName
export type ComparisonFilter = 'new' | 'lost' | 'improving' | 'declining'

export interface PlannerCapabilities {
  regex?: boolean
  multiDataset?: boolean
  comparisonJoin?: boolean
  windowTotals?: boolean
}

export interface LogicalDimensionFilter {
  dimension: Dimension
  operator: FilterOperator
  expression: string
  expression2?: string
}

export interface LogicalMetricFilter {
  metric: Metric
  operator: MetricOperator
  expression: number
  expression2?: number
}

// Tree representation of dimension filters that preserves AND/OR group
// structure. The compiler uses this to emit `(a OR b)`-style SQL; the flat
// `dimensionFilters` list is retained for callers that only need the leaves
// (e.g. dataset inference).
export interface LogicalFilterLeaf {
  kind: 'leaf'
  filter: LogicalDimensionFilter
}

export interface LogicalFilterGroup {
  kind: 'group'
  groupType: 'and' | 'or'
  children: LogicalFilterNode[]
}

export type LogicalFilterNode = LogicalFilterLeaf | LogicalFilterGroup

export interface LogicalQueryPlan {
  dataset: LogicalDataset
  dimensions: Dimension[]
  groupByDimensions: Dimension[]
  hasDate: boolean
  metrics: Metric[]
  dateRange: {
    startDate: string
    endDate: string
  }
  dimensionFilters: LogicalDimensionFilter[]
  dimensionFilterTree?: LogicalFilterNode
  metricFilters: LogicalMetricFilter[]
  // Row-level WHERE filters on raw metric columns. Distinct from `metricFilters`
  // (HAVING). Sourced from `state.prefilter`.
  prefilters: LogicalMetricFilter[]
  specialFilters: {
    topLevel: boolean
  }
  queryParams: Partial<Record<QueryParamName, string>>
  orderBy?: BuilderState['orderBy']
  rowLimit?: number
  startRow?: number
}

export interface LogicalComparisonPlan {
  current: LogicalQueryPlan
  previous: LogicalQueryPlan
  comparisonFilter?: ComparisonFilter
}

export class UnsupportedLogicalCapabilityError extends Error {
  constructor(capability: keyof PlannerCapabilities, context: string) {
    super(`${context} requires ${capability} capability`)
    this.name = 'UnsupportedLogicalCapabilityError'
  }
}

function collectInternalFilters(filter: FilterInput | undefined): InternalFilter[] {
  if (!filter || !('_filters' in filter))
    return []

  const flat = filter._filters as InternalFilter[]
  const nested = filter._nestedGroups?.flatMap(group => collectInternalFilters(group)) ?? []
  return [...flat, ...nested]
}

function inferDataset(
  dimensions: readonly Dimension[],
  filterDims: readonly Dimension[] = [],
): LogicalDataset {
  const allDims = new Set<Dimension>([...dimensions, ...filterDims])
  const has = (dimension: Dimension): boolean => allDims.has(dimension)

  if (has('searchAppearance'))
    return 'search_appearance'
  if (has('page') && (has('query') || has('queryCanonical')))
    return 'page_keywords'
  if (has('query') || has('queryCanonical'))
    return 'keywords'
  if (has('page'))
    return 'pages'
  if (has('country'))
    return 'countries'
  if (has('device'))
    return 'devices'
  return 'keywords'
}

function requireCapability(
  capabilities: PlannerCapabilities | undefined,
  capability: keyof PlannerCapabilities,
  enabled: boolean,
  context: string,
): void {
  if (enabled && !capabilities?.[capability])
    throw new UnsupportedLogicalCapabilityError(capability, context)
}

// True iff the leaf is a real dimension predicate (not a date window, query
// param, metric HAVING, or topLevel marker). These get extracted onto the
// plan's top-level fields and must NOT appear in the dimension filter tree.
function isDimensionLeaf(filter: InternalFilter): boolean {
  if (isMetric(filter.dimension))
    return false
  if (filter.dimension === 'date' && isDateOperator(filter.operator))
    return false
  if (filter.operator === 'topLevel' || filter.operator.startsWith('metric'))
    return false
  if (isQueryParam(filter.dimension))
    return false
  return true
}

function toLogicalDimensionFilter(filter: InternalFilter): LogicalDimensionFilter {
  return {
    dimension: filter.dimension as Dimension,
    operator: filter.operator as FilterOperator,
    expression: filter.expression,
    expression2: filter.expression2,
  }
}

function buildDimensionFilterTree(
  filter: FilterInput | undefined,
  capabilities: PlannerCapabilities,
): LogicalFilterNode | undefined {
  if (!filter || !('_filters' in filter))
    return undefined

  const groupType = (filter._groupType ?? 'and') as 'and' | 'or'
  const children: LogicalFilterNode[] = []

  for (const f of filter._filters as InternalFilter[]) {
    if (!isDimensionLeaf(f))
      continue
    requireCapability(capabilities, 'regex', isRegexOperator(f.operator), 'logical plan')
    children.push({ kind: 'leaf', filter: toLogicalDimensionFilter(f) })
  }

  for (const g of filter._nestedGroups ?? []) {
    const sub = buildDimensionFilterTree(g, capabilities)
    if (sub)
      children.push(sub)
  }

  if (children.length === 0)
    return undefined
  if (children.length === 1)
    return children[0]
  return { kind: 'group', groupType, children }
}

export function buildLogicalPlan(
  state: BuilderState,
  capabilities: PlannerCapabilities = {},
): LogicalQueryPlan {
  // Coerce wire-format filters (`{ type, filters | column, value, from, to }`)
  // up-front so every downstream traversal sees the SDK's `_filters` shape.
  // Browser path (engine-duckdb-wasm) feeds raw consumer state; server path is
  // already pre-normalized by gscdump.com but normalizing twice is a no-op.
  const normalizedFilter = normalizeFilter(state.filter) as FilterInput | undefined

  const { startDate, endDate } = extractDateRange(normalizedFilter)
  if (!startDate || !endDate)
    throw new Error('logical plan requires date range (use between(date, ...) or gte/lte)')

  const allFilters = collectInternalFilters(normalizedFilter)
  const metricFilters = extractMetricFilters(normalizedFilter)
  const specialFilters = extractSpecialOperatorFilters(normalizedFilter)
  const normalizedPrefilter = normalizeFilter(state.prefilter) as FilterInput | undefined
  const prefilters = extractMetricFilters(normalizedPrefilter)

  const queryParams: Partial<Record<QueryParamName, string>> = {}
  const dimensionFilters: LogicalDimensionFilter[] = []

  for (const filter of allFilters) {
    if (isMetric(filter.dimension))
      continue
    if (filter.dimension === 'date' && isDateOperator(filter.operator))
      continue
    if (filter.operator === 'topLevel' || filter.operator.startsWith('metric'))
      continue
    if (isQueryParam(filter.dimension)) {
      queryParams[filter.dimension] = filter.expression
      continue
    }

    const operator = filter.operator as FilterOperator
    requireCapability(capabilities, 'regex', isRegexOperator(operator), 'logical plan')
    dimensionFilters.push({
      dimension: filter.dimension as Dimension,
      operator,
      expression: filter.expression,
      expression2: filter.expression2,
    })
  }

  const dimensionFilterTree = buildDimensionFilterTree(normalizedFilter, capabilities)

  const filterDims = dimensionFilters.map(filter => filter.dimension)
  const dataset = inferDataset(state.dimensions, filterDims)

  return {
    dataset,
    dimensions: [...state.dimensions],
    groupByDimensions: state.dimensions.filter(d => d !== 'date'),
    hasDate: state.dimensions.includes('date'),
    metrics: state.metrics ? [...state.metrics] : ['clicks', 'impressions', 'ctr', 'position'],
    dateRange: { startDate, endDate },
    dimensionFilters,
    dimensionFilterTree,
    metricFilters: metricFilters.map(filter => ({
      metric: filter.dimension as Metric,
      operator: filter.operator as MetricOperator,
      expression: Number(filter.expression),
      expression2: filter.expression2 == null ? undefined : Number(filter.expression2),
    })),
    prefilters: prefilters.map(filter => ({
      metric: filter.dimension as Metric,
      operator: filter.operator as MetricOperator,
      expression: Number(filter.expression),
      expression2: filter.expression2 == null ? undefined : Number(filter.expression2),
    })),
    specialFilters: {
      topLevel: specialFilters.some(filter => filter.operator === 'topLevel'),
    },
    queryParams,
    orderBy: state.orderBy,
    rowLimit: state.rowLimit,
    startRow: state.startRow,
  }
}

export function buildLogicalComparisonPlan(
  current: BuilderState,
  previous: BuilderState,
  capabilities: PlannerCapabilities = {},
  comparisonFilter?: ComparisonFilter,
): LogicalComparisonPlan {
  requireCapability(capabilities, 'comparisonJoin', true, 'logical comparison plan')

  const currentPlan = buildLogicalPlan(current, capabilities)
  const previousPlan = buildLogicalPlan(previous, capabilities)
  const usesMultipleDatasets = currentPlan.dataset !== previousPlan.dataset
  requireCapability(capabilities, 'multiDataset', usesMultipleDatasets, 'logical comparison plan')

  return {
    current: currentPlan,
    previous: previousPlan,
    comparisonFilter,
  }
}

import type { TableName } from '../contracts'
import type {
  BuilderState,
  DateOperator,
  Dimension,
  FilterInput,
  FilterOperator,
  InternalFilter,
  Metric,
  MetricOperator,
  QueryParamName,
} from './types'

import {
  extractDateRange,
  extractMetricFilters,
  extractSpecialOperatorFilters,
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
  metricFilters: LogicalMetricFilter[]
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

const QUERY_PARAMS: QueryParamName[] = ['searchType']
const DATE_OPERATORS: DateOperator[] = ['gte', 'gt', 'lte', 'lt', 'between']
const FILTER_METRICS: Metric[] = ['clicks', 'impressions', 'ctr', 'position']

function isMetric(value: string): value is Metric {
  return FILTER_METRICS.includes(value as Metric)
}

function isQueryParam(value: string): value is QueryParamName {
  return QUERY_PARAMS.includes(value as QueryParamName)
}

function isRegexOperator(operator: string): boolean {
  return operator === 'includingRegex' || operator === 'excludingRegex'
}

function isDateOperator(operator: string): operator is DateOperator {
  return DATE_OPERATORS.includes(operator as DateOperator)
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

  if (has('searchAppearance')) {
    throw new Error(
      'searchAppearance is only supported by the live GSC API; offline logical planning does not expose a matching dataset',
    )
  }

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

export function buildLogicalPlan(
  state: BuilderState,
  capabilities: PlannerCapabilities = {},
): LogicalQueryPlan {
  const { startDate, endDate } = extractDateRange(state.filter)
  if (!startDate || !endDate)
    throw new Error('logical plan requires date range (use between(date, ...) or gte/lte)')

  const allFilters = collectInternalFilters(state.filter)
  const metricFilters = extractMetricFilters(state.filter)
  const specialFilters = extractSpecialOperatorFilters(state.filter)

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
    metricFilters: metricFilters.map(filter => ({
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

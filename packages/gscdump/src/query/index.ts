import { currentPstDate, daysAgoPst } from './utils/dayjs'

// Date helpers
export function today(): string {
  return currentPstDate()
}

export function daysAgo(n: number): string {
  return daysAgoPst(n)
}

// Query builder
export { gsc } from './builder'
export type { GSCQueryBuilder } from './builder'

// Column references (groupable dimensions)
export { country, date, device, hour, page, query, queryCanonical, searchAppearance } from './columns'

// Metric columns (aggregated values)
export { clicks, ctr, impressions, position } from './columns'

// Query params (non-groupable filters)
export { searchType } from './columns'

// Constants (value enums)
export { Countries, Devices, SearchTypes } from './constants'

// Types
export type { Country, Device, SearchType } from './constants'

// Query errors (errors-as-values: typed `QueryError` + factory + helpers, plus
// the two error classes engines match on by name)
export * from './errors'

// Operators
export { and, between, contains, eq, gt, gte, inArray, like, lt, lte, ne, not, notRegex, or, regex, topLevel } from './operators'

export {
  buildLogicalComparisonPlan,
  buildLogicalComparisonPlanResult,
  buildLogicalPlan,
  buildLogicalPlanResult,
} from './plan'
export type {
  ComparisonFilter,
  LogicalComparisonPlan,
  LogicalDataset,
  LogicalDimensionFilter,
  LogicalMetricFilter,
  LogicalQueryPlan,
  PlannerCapabilities,
} from './plan'
// Resolver
export { extractDateRange, extractMetricFilters, extractSearchType, extractSpecialOperatorFilters, normalizeBuilderState, normalizeBuilderStateResult, normalizeFilter, resolveToBody, resolveToBodyResult } from './resolver'

// Types
export type { BuilderState, Column, Dimension, DimensionValueMap, Filter, FilterInput, GSCResult, GSCRow, InternalFilter, JsonFilter, JsonInternalFilter, Metric, MetricColumn, QueryParam, QueryParamName, QueryParamValueMap } from './types'

export { currentPstDate } from './utils/dayjs'

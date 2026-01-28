import { currentPstDate, dayjsPst } from './utils/dayjs'

// Date helpers
export function today(): string {
  return currentPstDate()
}

export function daysAgo(n: number): string {
  return dayjsPst().subtract(n, 'day').format('YYYY-MM-DD')
}

// Query builder
export { gsc } from './builder'
export type { GSCQueryBuilder } from './builder'

// Column references (groupable dimensions)
export { country, date, device, page, query, queryCanonical, searchAppearance } from './columns'

// Metric columns (aggregated values)
export { clicks, ctr, impressions, position } from './columns'

// Query params (non-groupable filters)
export { searchType } from './columns'

// Constants (value enums)
export { Countries, Devices, SearchTypes } from './constants'

// Types
export type { Country, Device, SearchType } from './constants'

// Operators
export { and, between, contains, eq, gt, gte, inArray, like, lt, lte, ne, not, notRegex, or, regex, topLevel } from './operators'

// Resolver
export { extractDateRange, extractMetricFilters, extractSpecialOperatorFilters } from './resolver'

// Types
export type { BuilderState, Column, Dimension, DimensionValueMap, Filter, GSCResult, GSCRow, InternalFilter, Metric, MetricColumn, QueryParam, QueryParamName, QueryParamValueMap } from './types'

export { currentPstDate, dayjs, dayjsPst } from './utils/dayjs'

import type { DateOperator, Metric, MetricOperator, QueryParamName, SpecialOperator } from './types'

export const DATE_OPERATORS: DateOperator[] = ['gte', 'gt', 'lte', 'lt', 'between']
export const METRIC_OPERATORS: MetricOperator[] = ['metricGte', 'metricGt', 'metricLte', 'metricLt', 'metricBetween']
export const SPECIAL_OPERATORS: SpecialOperator[] = ['topLevel']
export const QUERY_PARAMS: QueryParamName[] = ['searchType']
export const FILTER_METRICS: Metric[] = ['clicks', 'impressions', 'ctr', 'position']

export function isDateOperator(op: string): op is DateOperator {
  return DATE_OPERATORS.includes(op as DateOperator)
}

export function isMetricOperator(op: string): op is MetricOperator {
  return METRIC_OPERATORS.includes(op as MetricOperator)
}

export function isSpecialOperator(op: string): op is SpecialOperator {
  return SPECIAL_OPERATORS.includes(op as SpecialOperator)
}

export function isQueryParam(value: string): value is QueryParamName {
  return QUERY_PARAMS.includes(value as QueryParamName)
}

export function isMetric(value: string): value is Metric {
  return FILTER_METRICS.includes(value as Metric)
}

export function isRegexOperator(op: string): boolean {
  return op === 'includingRegex' || op === 'excludingRegex'
}

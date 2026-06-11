import type {
  Dimension,
  FilterInput,
  InternalFilter,
  Metric,
} from 'gscdump/query'
import { normalizeUrl } from 'gscdump/normalize'

function collectInternalFilters(filter: FilterInput | undefined): InternalFilter[] {
  if (!filter || !('_filters' in filter))
    return []

  const flat = filter._filters as InternalFilter[]
  const nested = filter._nestedGroups?.flatMap(group => collectInternalFilters(group)) ?? []
  return [...flat, ...nested]
}

export function getInternalFilters(filter: FilterInput | undefined): InternalFilter[] {
  return collectInternalFilters(filter)
}

export function getDimensionFilters(
  filter: FilterInput | undefined,
  isMetricDimension: (dim: string) => dim is Metric,
): InternalFilter[] {
  return collectInternalFilters(filter).filter(f =>
    f.dimension !== 'date'
    && !isMetricDimension(f.dimension)
    && f.operator !== 'topLevel'
    && !f.operator.startsWith('metric'),
  )
}

export function getFilterDimensions(
  filter: FilterInput | undefined,
  isMetricDimension: (dim: string) => dim is Metric,
): Dimension[] {
  return getDimensionFilters(filter, isMetricDimension).map(f => f.dimension as Dimension)
}

function metricValue(row: Record<string, unknown>, metric: string): number {
  const value = row[metric]
  if (typeof value === 'number')
    return value
  if (typeof value === 'bigint')
    return Number(value)
  if (value == null)
    return 0
  return Number(value)
}

function dimensionValue(row: Record<string, unknown>, dimension: string): string {
  const value = row[dimension]
  return value == null ? '' : String(value)
}

export function matchesDimensionFilter(row: Record<string, unknown>, filter: InternalFilter): boolean {
  const raw = dimensionValue(row, filter.dimension)
  const value = filter.dimension === 'page' ? normalizeUrl(raw) : raw

  switch (filter.operator) {
    case 'equals':
      return value === filter.expression
    case 'notEquals':
      return value !== filter.expression
    case 'contains':
      return raw.includes(filter.expression)
    case 'notContains':
      return !raw.includes(filter.expression)
    case 'includingRegex':
      return new RegExp(filter.expression).test(raw)
    case 'excludingRegex':
      return !new RegExp(filter.expression).test(raw)
    default:
      return true
  }
}

export function matchesMetricFilter(row: Record<string, unknown>, filter: InternalFilter): boolean {
  const value = metricValue(row, filter.dimension)
  const target = Number(filter.expression)
  switch (filter.operator) {
    case 'metricGte':
      return value >= target
    case 'metricGt':
      return value > target
    case 'metricLte':
      return value <= target
    case 'metricLt':
      return value < target
    case 'metricBetween':
      return value >= target && value <= Number(filter.expression2)
    default:
      return true
  }
}

export function matchesTopLevelPage(row: Record<string, unknown>): boolean {
  const path = normalizeUrl(dimensionValue(row, 'page'))
  return (path.match(/\//g)?.length ?? 0) <= 1
}

export { dimensionValue, metricValue }

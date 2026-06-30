import type { BuilderState } from 'gscdump/query'
import type { FilterInput, InternalFilter, JsonInternalFilter } from 'gscdump/query'
import {
  matchesDimensionFilter,
  matchesMetricFilter,
  matchesTopLevelPage,
  metricValue,
} from '@gscdump/engine/resolver'

import {
  extractMetricFilters,
  extractSpecialOperatorFilters,
} from 'gscdump/query'

const METRIC_NAMES = ['clicks', 'impressions', 'ctr', 'position'] as const
type LocalFilter = InternalFilter | JsonInternalFilter

function isMetricDimension(dim: string): dim is typeof METRIC_NAMES[number] {
  return METRIC_NAMES.includes(dim as typeof METRIC_NAMES[number])
}

function isLocalDimensionFilter(filter: LocalFilter): boolean {
  return filter.dimension !== 'date'
    && !isMetricDimension(filter.dimension)
    && filter.operator !== 'topLevel'
    && !filter.operator.startsWith('metric')
}

function matchesDimensionFilterTree(row: Record<string, unknown>, filter: FilterInput | undefined): boolean {
  if (!filter || !('_filters' in filter))
    return true
  const localFilters = filter._filters as LocalFilter[]
  const checks = [
    ...localFilters
      .filter(isLocalDimensionFilter)
      .map(f => matchesDimensionFilter(row, f as InternalFilter)),
    ...(filter._nestedGroups ?? [])
      .map(group => matchesDimensionFilterTree(row, group)),
  ]
  if (checks.length === 0)
    return true
  return filter._groupType === 'or'
    ? checks.some(Boolean)
    : checks.every(Boolean)
}

export function applyBuilderStatePostProcessing(
  rows: Record<string, unknown>[],
  state: BuilderState,
): Record<string, unknown>[] {
  const metricFilters = extractMetricFilters(state.filter)
  const specialFilters = extractSpecialOperatorFilters(state.filter)

  const filtered = rows.filter((row) => {
    if (!matchesDimensionFilterTree(row, state.filter))
      return false
    if (!metricFilters.every(filter => matchesMetricFilter(row, filter)))
      return false
    if (specialFilters.some(filter => filter.operator === 'topLevel') && !matchesTopLevelPage(row))
      return false
    return true
  })

  const ordered = [...filtered].sort((a, b) => {
    const column = state.orderBy?.column ?? 'clicks'
    const dir = state.orderBy?.dir ?? 'desc'
    const left = column === 'date'
      ? String(a.date ?? '')
      : metricValue(a, column)
    const right = column === 'date'
      ? String(b.date ?? '')
      : metricValue(b, column)

    if (left === right)
      return 0
    if (dir === 'asc')
      return left < right ? -1 : 1
    return left > right ? -1 : 1
  })

  const offset = Math.max(0, Number(state.startRow ?? 0))
  const limit = Math.max(0, Number((state.rowLimit ?? ordered.length) || 0))
  return ordered.slice(offset, offset + limit)
}

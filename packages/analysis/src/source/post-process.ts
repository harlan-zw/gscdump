import type { BuilderState } from 'gscdump/query'
import {
  getDimensionFilters,
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

function isMetricDimension(dim: string): dim is typeof METRIC_NAMES[number] {
  return METRIC_NAMES.includes(dim as typeof METRIC_NAMES[number])
}

export function applyBuilderStatePostProcessing(
  rows: Record<string, unknown>[],
  state: BuilderState,
): Record<string, unknown>[] {
  const dimensionFilters = getDimensionFilters(state.filter, isMetricDimension)
  const metricFilters = extractMetricFilters(state.filter)
  const specialFilters = extractSpecialOperatorFilters(state.filter)

  const filtered = rows.filter((row) => {
    if (!dimensionFilters.every(filter => matchesDimensionFilter(row, filter)))
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

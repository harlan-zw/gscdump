import type { BuilderState, FilterInput, InternalFilter, JsonInternalFilter } from 'gscdump/query'
import {
  dimensionValue,
  matchesTopLevelPage,
  metricValue,
} from '@gscdump/engine/resolver'
import { normalizeUrl } from 'gscdump/normalize'

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

type Row = Record<string, unknown>
type RowMatcher = (row: Row) => boolean

function compileDimensionFilter(filter: InternalFilter): RowMatcher {
  const { dimension, expression } = filter
  switch (filter.operator) {
    case 'equals':
      return dimension === 'page'
        ? row => normalizeUrl(dimensionValue(row, dimension)) === expression
        : row => dimensionValue(row, dimension) === expression
    case 'notEquals':
      return dimension === 'page'
        ? row => normalizeUrl(dimensionValue(row, dimension)) !== expression
        : row => dimensionValue(row, dimension) !== expression
    case 'contains':
      return row => dimensionValue(row, dimension).includes(expression)
    case 'notContains':
      return row => !dimensionValue(row, dimension).includes(expression)
    case 'includingRegex': {
      let regex: RegExp | undefined
      return row => (regex ??= new RegExp(expression)).test(dimensionValue(row, dimension))
    }
    case 'excludingRegex': {
      let regex: RegExp | undefined
      return row => !(regex ??= new RegExp(expression)).test(dimensionValue(row, dimension))
    }
    default:
      return () => true
  }
}

function compileMetricFilter(filter: InternalFilter): RowMatcher {
  const { dimension } = filter
  const target = Number(filter.expression)
  switch (filter.operator) {
    case 'metricGte':
      return row => metricValue(row, dimension) >= target
    case 'metricGt':
      return row => metricValue(row, dimension) > target
    case 'metricLte':
      return row => metricValue(row, dimension) <= target
    case 'metricLt':
      return row => metricValue(row, dimension) < target
    case 'metricBetween': {
      const target2 = Number(filter.expression2)
      return (row) => {
        const value = metricValue(row, dimension)
        return value >= target && value <= target2
      }
    }
    default:
      return () => true
  }
}

function compileDimensionFilterTree(filter: FilterInput | undefined): RowMatcher {
  if (!filter || !('_filters' in filter))
    return () => true
  const localFilters = filter._filters as LocalFilter[]
  const matchers: RowMatcher[] = []
  for (const localFilter of localFilters) {
    if (isLocalDimensionFilter(localFilter))
      matchers.push(compileDimensionFilter(localFilter as InternalFilter))
  }
  for (const group of filter._nestedGroups ?? [])
    matchers.push(compileDimensionFilterTree(group))

  if (matchers.length === 0)
    return () => true
  if (filter._groupType === 'or') {
    return (row) => {
      for (const matches of matchers) {
        if (matches(row))
          return true
      }
      return false
    }
  }
  return (row) => {
    for (const matches of matchers) {
      if (!matches(row))
        return false
    }
    return true
  }
}

interface IndexedRow {
  row: Row
  index: number
}

/** Keep the best k rows in a max-heap whose root is the current worst row. */
function selectTopK(rows: Row[], k: number, compareRows: (a: Row, b: Row) => number): Row[] {
  const heap: IndexedRow[] = []
  const compare = (a: IndexedRow, b: IndexedRow): number => compareRows(a.row, b.row) || a.index - b.index
  const siftUp = (start: number): void => {
    let child = start
    while (child > 0) {
      const parent = (child - 1) >>> 1
      if (compare(heap[parent]!, heap[child]!) >= 0)
        break
      const swap = heap[parent]!
      heap[parent] = heap[child]!
      heap[child] = swap
      child = parent
    }
  }
  const siftDown = (): void => {
    let parent = 0
    while (true) {
      const left = parent * 2 + 1
      if (left >= heap.length)
        return
      const right = left + 1
      const worse = right < heap.length && compare(heap[right]!, heap[left]!) > 0 ? right : left
      if (compare(heap[parent]!, heap[worse]!) >= 0)
        return
      const swap = heap[parent]!
      heap[parent] = heap[worse]!
      heap[worse] = swap
      parent = worse
    }
  }

  for (let index = 0; index < rows.length; index++) {
    const candidate = { row: rows[index]!, index }
    if (heap.length < k) {
      heap.push(candidate)
      siftUp(heap.length - 1)
    }
    else if (compare(candidate, heap[0]!) < 0) {
      heap[0] = candidate
      siftDown()
    }
  }

  heap.sort(compare)
  return heap.map(entry => entry.row)
}

export function applyBuilderStatePostProcessing(
  rows: Row[],
  state: BuilderState,
): Row[] {
  const matchesDimensions = compileDimensionFilterTree(state.filter)
  const metricMatchers = extractMetricFilters(state.filter).map(compileMetricFilter)
  const hasTopLevelFilter = extractSpecialOperatorFilters(state.filter)
    .some(filter => filter.operator === 'topLevel')
  const column = state.orderBy?.column ?? 'clicks'
  const dir = state.orderBy?.dir ?? 'desc'
  const checkFiniteOrderValues = column !== 'date' && state.rowLimit !== undefined
  let hasNonFiniteOrderValue = false

  const filtered: Row[] = []
  for (const row of rows) {
    if (!matchesDimensions(row))
      continue
    let matchesMetrics = true
    for (const matchesMetric of metricMatchers) {
      if (!matchesMetric(row)) {
        matchesMetrics = false
        break
      }
    }
    if (!matchesMetrics)
      continue
    if (hasTopLevelFilter && !matchesTopLevelPage(row))
      continue
    filtered.push(row)
    if (checkFiniteOrderValues && !Number.isFinite(metricValue(row, column)))
      hasNonFiniteOrderValue = true
  }

  const compareRows = (a: Row, b: Row): number => {
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
  }

  const offset = Math.max(0, Number(state.startRow ?? 0))
  const limit = Math.max(0, Number((state.rowLimit ?? filtered.length) || 0))
  if (limit === 0)
    return []

  const requested = offset + limit
  // A bounded heap avoids sorting the discarded tail for normal paginated
  // queries. Full sort remains faster when the requested prefix is large.
  const useTopK = Number.isInteger(requested)
    && requested > 0
    && requested < filtered.length / 2
    && !hasNonFiniteOrderValue
  const ordered = useTopK
    ? selectTopK(filtered, requested, compareRows)
    : filtered.sort(compareRows)
  return ordered.slice(offset, offset + limit)
}

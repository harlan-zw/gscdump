/**
 * Domain row shapes + analysis utilities. Analyzer-call contracts
 * (`AnalysisParams`, `AnalysisResult`, `AnalysisTool`, `num`) live in
 * `@gscdump/engine/analysis-types`.
 */

export type SortOrder = 'asc' | 'desc'

/** Base search metrics */
export interface BaseMetrics {
  clicks: number
  impressions: number
  ctr: number
  position: number
}

/** Keyword row from query */
export interface QueriesRow extends BaseMetrics {
  query: string
  page?: string
}

/** Page row from query */
export interface PageRow extends BaseMetrics {
  page: string
}

/** Row with both query and page dimensions, both required */
export interface QueryPageRow extends BaseMetrics {
  query: string
  page: string
}

/** Date row from query */
export interface DateRow extends BaseMetrics {
  date: string
}

/**
 * Build a lookup Map from rows, keyed by some property and projected via `value`.
 * Optional filter drops rows before insertion (e.g. minimum-clicks gates).
 */
export function buildPeriodMap<T, V>(
  rows: readonly T[],
  key: (row: T) => string,
  value: (row: T) => V,
  filter?: (row: T) => boolean,
): Map<string, V> {
  const out = new Map<string, V>()
  for (const row of rows) {
    if (filter && !filter(row))
      continue
    out.set(key(row), value(row))
  }
  return out
}

/** Create a generic sorter for any metric type */
export function createSorter<T, M extends string>(
  getValue: (item: T, metric: M) => number,
  defaultMetric: M,
  defaultOrder: SortOrder = 'desc',
) {
  return (items: T[], sortBy: M = defaultMetric, sortOrder: SortOrder = defaultOrder): T[] => {
    const mult = sortOrder === 'desc' ? -1 : 1
    return [...items].sort((a, b) => (getValue(a, sortBy) - getValue(b, sortBy)) * mult)
  }
}

/**
 * Sorter for analyzers whose metrics are direct numeric properties on `T`
 * and whose default order varies by metric (e.g. `position: 'asc'`, others
 * `'desc'`). Collapses the `SORT_ORDER + createSorter + sortResults(...,
 * SORT_ORDER[sortBy])` boilerplate into a single declaration.
 */
export function createMetricSorter<T, M extends keyof T & string>(
  defaultMetric: M,
  orderByMetric: Record<M, SortOrder>,
): (items: T[], sortBy?: M) => T[] {
  return (items, sortBy = defaultMetric) => {
    const mult = orderByMetric[sortBy] === 'desc' ? -1 : 1
    return [...items].sort((a, b) => ((a[sortBy] as unknown as number) - (b[sortBy] as unknown as number)) * mult)
  }
}

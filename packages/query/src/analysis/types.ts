/**
 * Shared types for pure analysis functions.
 * These types describe the inputs and outputs of analysis functions
 * that operate on data, independent of how it was fetched.
 */

// Re-export from gscdump for convenience
export type { ComparisonResult, DateData, KeywordData, PageData } from 'gscdump'

/** Base search metrics present on all data rows */
export interface BaseMetrics {
  clicks: number
  impressions: number
  ctr: number
  position: number
}

/** Coerce nullable number to number, defaulting to 0 */
export function num(value: number | null | undefined): number {
  return value ?? 0
}

/** Row with both query and page dimensions */
export interface QueryPageRow extends BaseMetrics {
  query: string
  page: string
}

/** Date-keyed metrics for time series analysis */
export interface DateMetrics extends BaseMetrics {
  date: string
}

// Common sort order
export type SortOrder = 'asc' | 'desc'

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

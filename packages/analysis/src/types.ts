/**
 * Row-level helpers for analysis functions. `AnalysisParams` / `AnalysisResult`
 * / `AnalysisTool` live in `gscdump/contracts` — the canonical cross-package
 * contract — and are re-exported here for backward-compatible imports from
 * `@gscdump/analysis`.
 */

export type { AnalysisParams, AnalysisResult, AnalysisTool } from 'gscdump/contracts'

export type SortOrder = 'asc' | 'desc'

/** Base search metrics */
export interface BaseMetrics {
  clicks: number
  impressions: number
  ctr: number
  position: number
}

/** Keyword row from query */
export interface KeywordRow extends BaseMetrics {
  query: string
  page?: string
}

/** Page row from query */
export interface PageRow extends BaseMetrics {
  page: string
}

/** Date row from query */
export interface DateRow extends BaseMetrics {
  date: string
}

/** Coerce nullable number to number, defaulting to 0 */
export function num(value: number | null | undefined): number {
  return value ?? 0
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

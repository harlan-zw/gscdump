/**
 * Analyzer call contracts. Engine packages and analyzer authors share these
 * shapes so analyzers can be defined, dispatched, and consumed without
 * round-tripping through the analysis package.
 */

import type { BuilderState, SearchType } from 'gscdump/query'

export type AnalysisTool
  = | 'striking-distance' | 'opportunity' | 'movers' | 'decay'
    | 'zero-click' | 'brand' | 'cannibalization' | 'clustering'
    | 'concentration' | 'seasonality' | 'trends' | 'ctr-anomaly'
    | 'position-volatility' | 'long-tail' | 'intent-atlas' | 'query-migration'
    | 'bayesian-ctr' | 'stl-decompose' | 'change-point' | 'bipartite-pagerank'
    | 'survival'
    | 'position-distribution' | 'ctr-curve' | 'dark-traffic'
    | 'content-velocity' | 'keyword-breadth' | 'device-gap'
    | 'data-query' | 'data-detail'

export interface AnalysisParams {
  type: AnalysisTool
  startDate?: string
  endDate?: string
  prevStartDate?: string
  prevEndDate?: string
  brandTerms?: string[]
  limit?: number
  offset?: number
  /**
   * movers: select a single direction and paginate within it. When set, the
   * analyzer filters to that direction, reports `meta.total` as the full
   * pre-pagination count for the direction, and applies `limit`/`offset`. When
   * unset, both directions are returned uncapped (the top-N callers slice
   * themselves).
   */
  direction?: 'rising' | 'declining'
  /** Sort column. Each analyzer enforces its own whitelist. */
  sortBy?: string
  /** Sort direction. Default per-analyzer. */
  sortDir?: 'asc' | 'desc'
  minPosition?: number
  maxPosition?: number
  minImpressions?: number
  maxCtr?: number
  minPages?: number
  maxPositionSpread?: number
  minClusterSize?: number
  clusterBy?: 'prefix' | 'intent' | 'both'
  dimension?: 'pages' | 'keywords'
  topN?: number
  metric?: 'clicks' | 'impressions'
  changeThreshold?: number
  minPreviousClicks?: number
  threshold?: number
  weeks?: number
  minWeeksWithData?: number
  /** content-velocity lookback window in days (max 365, default 90). */
  days?: number
  /** data-query / data-detail primary BuilderState. */
  q?: BuilderState
  /** data-query / data-detail optional comparison-period BuilderState. */
  qc?: BuilderState
  /** data-query comparison filter applied to joined current/previous rows. */
  comparisonFilter?: 'new' | 'lost' | 'improving' | 'declining'
  /** GSC slice the analysis is scoped to. Undefined = analyzer runs cross-type (today's behaviour for web-only sites). */
  searchType?: SearchType
}

export interface AnalysisResult {
  results: Record<string, unknown>[]
  meta: Record<string, unknown>
}

/** Coerce arbitrary value (number, bigint, string, null) to number, defaulting to 0. */
export function num(v: unknown): number {
  if (typeof v === 'number')
    return v
  if (typeof v === 'bigint')
    return Number(v)
  if (v == null)
    return 0
  return Number(v)
}

export type AnalysisTool
  = | 'striking-distance' | 'opportunity' | 'movers' | 'decay'
    | 'zero-click' | 'brand' | 'cannibalization' | 'clustering'
    | 'concentration' | 'seasonality' | 'trends' | 'ctr-anomaly'
    | 'position-volatility' | 'long-tail' | 'intent-atlas' | 'query-migration'
    | 'bayesian-ctr' | 'stl-decompose' | 'change-point' | 'bipartite-pagerank'
    | 'survival'
  // Insight panels shared with gscdump.com `layers/app` pages. Their SQL
  // deliberately mirrors the server endpoints (`/api/sites/[siteId]/...`)
  // so browser + D1 paths return byte-identical shapes.
    | 'position-distribution' | 'ctr-curve' | 'dark-traffic'
    | 'content-velocity' | 'keyword-breadth' | 'device-gap'
  // Generic BuilderState-driven queries. data-query powers list / breakdown
  // pages; data-detail powers per-entity timeseries. Both delegate to
  // `@gscdump/analysis/query` and are browser-only (server keeps its own
  // D1-backed resolver call path).
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
  /** content-velocity: lookback window in days (max 365, default 90) */
  days?: number
  /**
   * data-query / data-detail: primary `BuilderState`. Intentionally typed as
   * `unknown` here to avoid a circular type dep on `gscdump/query`; consumers
   * cast via `BuilderState` from that module.
   */
  q?: unknown
  /** data-query / data-detail: optional comparison period `BuilderState`. */
  qc?: unknown
  /** data-query: comparison filter applied to joined current/previous rows. */
  comparisonFilter?: 'new' | 'lost' | 'improving' | 'declining'
}

export interface AnalysisResult {
  results: Record<string, unknown>[]
  meta: Record<string, unknown>
}

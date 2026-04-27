/**
 * Canonical cross-package contracts. Type-only — zero runtime cost.
 *
 * Imported by @gscdump/engine, @gscdump/analysis, @gscdump/cli, @gscdump/mcp,
 * @gscdump/cloud as the single source of truth for cross-cutting types so
 * schema identifiers, tenant shape, and analyzer IO can't drift across
 * packages.
 */

import type { BuilderState } from './query'

// ------------------------------------------------------------------
// Schema primitives
// ------------------------------------------------------------------

/** Logical table / dataset identifier. Canonical across query builder + storage engine. */
export type TableName = 'pages' | 'keywords' | 'countries' | 'devices' | 'page_keywords' | 'search_appearance'

/** Untyped row shape crossing storage/query boundaries. */
export type Row = Record<string, unknown>

export type ColumnType = 'DATE' | 'VARCHAR' | 'INTEGER' | 'BIGINT' | 'DOUBLE'

export interface ColumnDef {
  name: string
  type: ColumnType
  nullable: boolean
}

export interface TableSchema {
  name: TableName
  columns: ColumnDef[]
  sortKey: string[]
  /**
   * Monotonically increasing version. Tagged onto every manifest entry written
   * for this table; bump when columns are added/removed/retyped so readers can
   * detect stale on-disk data.
   */
  version: number
}

/** Tenant identity for multi-user / multi-site storage. */
export interface TenantCtx {
  userId: string
  siteId?: string
}

// ------------------------------------------------------------------
// Analysis primitives
// ------------------------------------------------------------------

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
}

export interface AnalysisResult {
  results: Record<string, unknown>[]
  meta: Record<string, unknown>
}

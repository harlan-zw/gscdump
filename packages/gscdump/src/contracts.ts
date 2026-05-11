/**
 * Canonical cross-package contracts. Type-only — zero runtime cost.
 *
 * Imported by @gscdump/engine, @gscdump/analysis, @gscdump/cli, @gscdump/mcp,
 * @gscdump/cloud as the single source of truth for cross-cutting types so
 * schema identifiers, tenant shape, and analyzer IO can't drift across
 * packages.
 */

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
// Google Search Console Search Analytics wire contracts
// ------------------------------------------------------------------

/**
 * Dimensions accepted by the Google Search Console Search Analytics API.
 *
 * This intentionally excludes package-only logical dimensions such as
 * `queryCanonical`; host apps must route those through an engine-backed path.
 */
export type GscSearchAnalyticsDimension = 'page' | 'query' | 'country' | 'device' | 'date' | 'searchAppearance'

export type GscSearchAnalyticsFilterOperator
  = | 'equals'
    | 'notEquals'
    | 'contains'
    | 'notContains'
    | 'includingRegex'
    | 'excludingRegex'

export interface GscSearchAnalyticsFilter {
  dimension: GscSearchAnalyticsDimension
  expression: string
  operator?: GscSearchAnalyticsFilterOperator
}

export interface GscSearchAnalyticsFilterGroup {
  groupType?: 'and' | 'or'
  filters: GscSearchAnalyticsFilter[]
}

export type GscSearchType = 'web' | 'image' | 'video' | 'news' | 'discover' | 'googleNews'

/**
 * Canonical host-facing Search Analytics request body.
 *
 * Google's generated client type also has deprecated/alternate fields. The
 * gscdump query builder emits `searchType`, so apps should forward that field
 * unchanged rather than translating it to `type`.
 */
export interface GscSearchAnalyticsRequest {
  startDate: string
  endDate: string
  dimensions?: GscSearchAnalyticsDimension[]
  dimensionFilterGroups?: GscSearchAnalyticsFilterGroup[]
  rowLimit?: number
  startRow?: number
  searchType?: GscSearchType
}

export interface GscSearchAnalyticsRow {
  keys: string[]
  clicks: number
  impressions: number
  ctr: number
  position: number
}

export interface GscSearchAnalyticsResponse {
  rows?: GscSearchAnalyticsRow[]
  responseAggregationType?: string
}

export type TableName = 'pages' | 'keywords' | 'countries' | 'devices' | 'page_keywords' | 'search_appearance'
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
  version: number
}

export interface TenantCtx {
  userId: string
  siteId?: string
}

export type GscSearchAnalyticsDimension = 'page' | 'query' | 'country' | 'device' | 'date' | 'hour' | 'searchAppearance'

export type GscDataState = 'final' | 'all' | 'hourly_all'

export interface GscSearchAnalyticsMetadata {
  /** First date (YYYY-MM-DD, PT) still being collected. Populated when dataState=`all` and grouped by `date`. */
  first_incomplete_date?: string
  /** First hour (YYYY-MM-DDThh:mm:ss±hh:mm, PT) still being collected. Populated when dataState=`hourly_all` and grouped by `hour`. */
  first_incomplete_hour?: string
}

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

export type GscAggregationType = 'auto' | 'byPage' | 'byProperty' | 'byNewsShowcasePanel'

export type GscResponseAggregationType = 'auto' | 'byPage' | 'byProperty' | 'byNewsShowcasePanel'

export interface GscSearchAnalyticsRequest {
  startDate: string
  endDate: string
  dimensions?: GscSearchAnalyticsDimension[]
  dimensionFilterGroups?: GscSearchAnalyticsFilterGroup[]
  rowLimit?: number
  startRow?: number
  /** GSC search corpus. Maps to wire field `type` (the API still accepts the deprecated `searchType` alias). */
  type?: GscSearchType
  dataState?: GscDataState
  aggregationType?: GscAggregationType
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
  responseAggregationType?: GscResponseAggregationType
  metadata?: GscSearchAnalyticsMetadata
}

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

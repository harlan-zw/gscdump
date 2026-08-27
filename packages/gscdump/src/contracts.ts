import type { GscSearchType } from '@gscdump/contracts/search-types'

// Schema/storage vocabulary is owned by the dependency-free `@gscdump/contracts`
// leaf package; re-exported here so `gscdump/contracts` stays the single import
// surface for GSC consumers. The GSC Search Analytics wire types below remain
// owned by this package (the live-API client is their only consumer).
export type { ColumnDef, ColumnType, Row, TableName, TableSchema, TenantCtx } from '@gscdump/contracts'
export type { GscSearchType } from '@gscdump/contracts/search-types'

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

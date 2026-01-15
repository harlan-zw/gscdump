import type { DataRow, DimensionFilter, Period } from '../../core/types'

export type DataType = 'web' | 'image' | 'video' | 'news' | 'discover' | 'googleNews'
export type DataState = 'final' | 'all'
export type AggregationType = 'byPage' | 'byProperty'

export interface QueryOptions {
  period?: Period
  prevPeriod?: Period
  domain?: string
  filters?: DimensionFilter[]
  /** Data type: web, image, video, news, discover, googleNews. Default: web */
  type?: DataType
  /** Data state: final (settled data) or all (includes fresh/unfinalized). Default: all */
  dataState?: DataState
  /**
   * Aggregation type: byPage (per-URL metrics) or byProperty (domain-level rollup).
   * Use byProperty for sc-domain: properties to get true totals.
   * byPage can undercount when same query hits multiple pages.
   * Default: byPage
   */
  aggregationType?: AggregationType
  /** Maximum rows to return. Default: 25000 (GSC API limit per request) */
  rowLimit?: number
}

export interface ComparisonResult<T> {
  current: T[]
  previous: T[]
  metadata?: {
    currentCount: number
    previousCount: number
    [key: string]: unknown
  }
}

export interface DeviceData extends Omit<DataRow, 'keys'> {
  dimension: 'device'
  device: string
  keys: null
}

export interface CountryData extends Omit<DataRow, 'keys'> {
  dimension: 'country'
  countryCodeGsc: string
  country: string
  countryCode: string
  keywords?: number
  keys: null
}

export interface AnalyticsData extends Omit<DataRow, 'keys'> {
  keywords: DataRow[]
}

export interface PageData extends Omit<DataRow, 'keys'> {
  dimension: 'page'
  page: string
  keyword?: string
  keywordPosition?: number
  prevClicks?: number
  clicksPercent?: number
  prevImpressions?: number
  impressionsPercent?: number
  lost?: boolean
  keys: null
}

export interface KeywordData extends Omit<DataRow, 'keys'> {
  dimension: 'query'
  keyword: string
  page?: string | null
  positionPercent?: number
  prevPosition?: number
  ctrPercent?: number
  prevCtr?: number
  lost?: boolean
  prevClicks?: number
  prevImpressions?: number
  keys: null
}

export interface DateData extends Omit<DataRow, 'keys'> {
  dimension: 'date'
  date: string
  keys: null
}

export interface SearchAppearanceData extends Omit<DataRow, 'keys'> {
  dimension: 'searchAppearance'
  searchAppearance: string
  keys: null
}

/**
 * Discriminated union of all query result row types.
 * Use the `dimension` field to narrow to specific types.
 */
export type QueryResultRow
  = | DateData
    | DeviceData
    | CountryData
    | PageData
    | KeywordData
    | SearchAppearanceData

// Simple row types for detail queries (no dimension discriminator)
export interface DateRow extends Omit<DataRow, 'keys'> {
  date: string
  keys: null
}

export interface KeywordRow extends Omit<DataRow, 'keys'> {
  keyword: string
  keys: null
}

export interface PageRow extends Omit<DataRow, 'keys'> {
  page: string
  keys: null
}

export interface FetchPageResult {
  dates: DateRow[]
  keywords: KeywordRow[]
}

export interface FetchKeywordResult {
  dates: DateRow[]
  pages: PageRow[]
}
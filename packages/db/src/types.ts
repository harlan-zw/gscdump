import type { DataRow } from 'gscdump'

export interface ComparisonResult<T> {
  current: T[]
  previous: T[]
  metadata?: {
    currentCount: number
    previousCount: number
    [key: string]: unknown
  }
}

export interface DatesComparisonResult {
  current: DateData[]
  previous: DateData[]
  metadata: {
    currentCount: number
    previousCount: number
    totals: {
      current: { clicks: number, impressions: number, ctr: number, position: number }
      previous: { clicks: number, impressions: number, ctr: number, position: number }
      clicksPercent: number
      impressionsPercent: number
      ctrPercent: number
      positionPercent: number
    }
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

export interface DateRow {
  date: string
  clicks?: number | null
  impressions?: number | null
  ctr?: number | null
  position?: number | null
}

export interface KeywordRow {
  keyword: string
  clicks?: number | null
  impressions?: number | null
  ctr?: number | null
  position?: number | null
}

export interface PageRow {
  page: string
  clicks?: number | null
  impressions?: number | null
  ctr?: number | null
  position?: number | null
}

export interface FetchPageResult {
  dates: DateRow[]
  keywords: KeywordRow[]
}

export interface FetchKeywordResult {
  dates: DateRow[]
  pages: PageRow[]
}

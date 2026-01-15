import type { indexing_v3 } from '@googleapis/indexing/v3'
import type { searchconsole_v1 } from '@googleapis/searchconsole/v1'

// Re-export GSC types for consumers
export type ApiSite = searchconsole_v1.Schema$WmxSite
export type ApiSitemap = searchconsole_v1.Schema$WmxSitemap
export type ApiSitemapContent = searchconsole_v1.Schema$WmxSitemapContent
export type SearchAnalyticsQuery = searchconsole_v1.Schema$SearchAnalyticsQueryRequest
export type SearchAnalyticsResponse = searchconsole_v1.Schema$SearchAnalyticsQueryResponse
export type DataRow = searchconsole_v1.Schema$ApiDataRow
export type DimensionFilter = searchconsole_v1.Schema$ApiDimensionFilter
export type DimensionFilterGroup = searchconsole_v1.Schema$ApiDimensionFilterGroup
export type UrlInspectionResult = searchconsole_v1.Schema$UrlInspectionResult
export type IndexStatusResult = searchconsole_v1.Schema$IndexStatusInspectionResult
export type MobileUsabilityResult = searchconsole_v1.Schema$MobileUsabilityInspectionResult
export type RichResultsResult = searchconsole_v1.Schema$RichResultsInspectionResult
export type InspectUrlIndexResponse = searchconsole_v1.Schema$InspectUrlIndexResponse

// Indexing API types
export type UrlNotificationMetadata = indexing_v3.Schema$UrlNotificationMetadata
export type PublishUrlNotificationResponse = indexing_v3.Schema$PublishUrlNotificationResponse

export type RequiredNonNullable<T> = Required<Exclude<T, null | undefined>>

export interface Site extends Required<Omit<ApiSite, 'siteUrl'>> {
  siteUrl: string
}

export interface Period {
  start: Date | string
  end: Date | string
}

export interface ResolvedAnalyticsRange {
  period: Period
  prevPeriod?: Period
}

export interface SiteAnalytics {
  analytics: {
    period: {
      totalClicks: number
      totalImpressions: number
    }
    prevPeriod: {
      totalClicks: number
      totalImpressions: number
    }
  }
  sitemaps: ApiSitemap[]
  indexedUrls: string[]
  period: {
    url: string
    clicks: number
    clicksPercent: number
    prevClicks: number
    impressions: number
    impressionsPercent: number
    prevImpressions: number
  }[]
  keywords: {
    keyword: string
    position: number
    prevPosition: number
    positionPercent: number
    ctr: number
    ctrPercent: number
    prevCtr: number
    clicks: number
  }[]
  graph: {
    keys?: undefined
    time: string
    clicks: number
    impressions: number
  }[]
}

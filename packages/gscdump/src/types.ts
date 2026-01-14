import type { indexing_v3 } from '@googleapis/indexing/v3'
import type { searchconsole_v1 } from '@googleapis/searchconsole/v1'

// Re-export GSC types for consumers
export type GscSite = searchconsole_v1.Schema$WmxSite
export type GscSitemap = searchconsole_v1.Schema$WmxSitemap
export type GscSitemapContent = searchconsole_v1.Schema$WmxSitemapContent
export type GscSearchAnalyticsQuery = searchconsole_v1.Schema$SearchAnalyticsQueryRequest
export type GscSearchAnalyticsResponse = searchconsole_v1.Schema$SearchAnalyticsQueryResponse
export type GscDataRow = searchconsole_v1.Schema$ApiDataRow
export type GscDimensionFilter = searchconsole_v1.Schema$ApiDimensionFilter
export type GscDimensionFilterGroup = searchconsole_v1.Schema$ApiDimensionFilterGroup
export type GscUrlInspectionResult = searchconsole_v1.Schema$UrlInspectionResult
export type GscIndexStatusResult = searchconsole_v1.Schema$IndexStatusInspectionResult
export type GscMobileUsabilityResult = searchconsole_v1.Schema$MobileUsabilityInspectionResult
export type GscRichResultsResult = searchconsole_v1.Schema$RichResultsInspectionResult

// Indexing API types
export type GscUrlNotificationMetadata = indexing_v3.Schema$UrlNotificationMetadata
export type GscPublishUrlNotificationResponse = indexing_v3.Schema$PublishUrlNotificationResponse

export type RequiredNonNullable<T> = Required<Exclude<T, null | undefined>>

export interface Site extends Required<Omit<searchconsole_v1.Schema$WmxSite, 'siteUrl'>> {
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
  sitemaps: searchconsole_v1.Schema$WmxSitemap[]
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

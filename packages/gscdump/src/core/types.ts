/** Search Console property returned by the Sites resource. */
export interface ApiSite {
  permissionLevel?: string | null
  siteUrl?: string | null
}

/** Per-content-type counts returned with a sitemap. */
export interface ApiSitemapContent {
  /** Deprecated by Google, retained because it can still appear on the wire. */
  indexed?: string | null
  submitted?: string | null
  type?: string | null
}

/** Sitemap returned by the Search Console Sitemaps resource. */
export interface ApiSitemap {
  contents?: ApiSitemapContent[]
  errors?: string | null
  isPending?: boolean | null
  isSitemapsIndex?: boolean | null
  lastDownloaded?: string | null
  lastSubmitted?: string | null
  path?: string | null
  type?: string | null
  warnings?: string | null
}

/** A Search Analytics dimension filter. */
export interface DimensionFilter {
  dimension?: string | null
  expression?: string | null
  operator?: string | null
}

/** A group of Search Analytics dimension filters. */
export interface DimensionFilterGroup {
  filters?: DimensionFilter[]
  groupType?: string | null
}

/** Raw Search Analytics request accepted by Google's REST endpoint. */
export interface SearchAnalyticsQuery {
  aggregationType?: string | null
  dataState?: string | null
  dimensionFilterGroups?: DimensionFilterGroup[]
  dimensions?: string[] | null
  endDate?: string | null
  rowLimit?: number | null
  searchType?: string | null
  startDate?: string | null
  startRow?: number | null
  type?: string | null
}

/** Raw Search Analytics result row. */
export interface DataRow {
  clicks?: number | null
  ctr?: number | null
  impressions?: number | null
  keys?: string[] | null
  position?: number | null
}

/** Completeness metadata returned with recent Search Analytics data. */
export interface SearchAnalyticsMetadata {
  firstIncompleteDate?: string | null
  firstIncompleteHour?: string | null
  /** Field name returned by the direct REST endpoint. */
  first_incomplete_date?: string | null
  /** Field name returned by the direct REST endpoint. */
  first_incomplete_hour?: string | null
}

/** Raw Search Analytics response returned by Google's REST endpoint. */
export interface SearchAnalyticsResponse {
  metadata?: SearchAnalyticsMetadata
  responseAggregationType?: string | null
  rows?: DataRow[]
}

export interface AmpIssue {
  issueMessage?: string | null
  severity?: string | null
}

export interface AmpInspectionResult {
  ampIndexStatusVerdict?: string | null
  ampUrl?: string | null
  indexingState?: string | null
  issues?: AmpIssue[]
  lastCrawlTime?: string | null
  pageFetchState?: string | null
  robotsTxtState?: string | null
  verdict?: string | null
}

export interface IndexStatusResult {
  coverageState?: string | null
  crawledAs?: string | null
  googleCanonical?: string | null
  indexingState?: string | null
  lastCrawlTime?: string | null
  pageFetchState?: string | null
  referringUrls?: string[] | null
  robotsTxtState?: string | null
  sitemap?: string[] | null
  userCanonical?: string | null
  verdict?: string | null
}

export interface MobileUsabilityIssue {
  issueType?: string | null
  message?: string | null
  severity?: string | null
}

export interface MobileUsabilityResult {
  issues?: MobileUsabilityIssue[]
  verdict?: string | null
}

export interface RichResultsIssue {
  issueMessage?: string | null
  severity?: string | null
}

export interface RichResultsItem {
  issues?: RichResultsIssue[]
  name?: string | null
}

export interface RichResultsDetectedItem {
  items?: RichResultsItem[]
  richResultType?: string | null
}

export interface RichResultsResult {
  detectedItems?: RichResultsDetectedItem[]
  verdict?: string | null
}

/** URL inspection payload returned by Search Console. */
export interface UrlInspectionResult {
  ampResult?: AmpInspectionResult
  indexStatusResult?: IndexStatusResult
  inspectionResultLink?: string | null
  mobileUsabilityResult?: MobileUsabilityResult
  richResultsResult?: RichResultsResult
}

export interface InspectUrlIndexResponse {
  inspectionResult?: UrlInspectionResult
}

/** A single Indexing API notification. */
export interface UrlNotification {
  notifyTime?: string | null
  type?: string | null
  url?: string | null
}

/** Latest Indexing API notifications recorded for a URL. */
export interface UrlNotificationMetadata {
  latestRemove?: UrlNotification
  latestUpdate?: UrlNotification
  url?: string | null
}

export interface PublishUrlNotificationResponse {
  urlNotificationMetadata?: UrlNotificationMetadata
}

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

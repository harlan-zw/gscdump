import type { BaseMetrics } from '../analysis/types'

// Sites
export interface DriverSite {
  siteUrl: string
  permissionLevel: string
}

export interface DriverSiteWithSync extends DriverSite {
  siteId: string
  syncStatus: string | null
  syncProgress: { total: number, completed: number, percent: number }
  lastSyncAt: number | null
  newestDateSynced: string | null
  oldestDateSynced: string | null
}

// Query
export interface DriverQueryParams {
  startDate: string
  endDate: string
  dimensions?: string[]
  rowLimit?: number
  startRow?: number
  searchType?: string
  filters?: Array<{ dimension: string, operator: string, expression: string }>
}

export interface DriverQueryRow extends BaseMetrics {
  [key: string]: unknown
}

export interface DriverQueryResult {
  rows: DriverQueryRow[]
  meta: {
    siteUrl: string
    dimensions: string[]
    dateRange: { startDate: string, endDate: string }
    rowCount: number
    hasMore: boolean
  }
}

// Sitemaps
export interface DriverSitemap {
  path: string
  type?: string
  isPending?: boolean
  errors?: number
  warnings?: number
  urlCount?: number
  lastDownloaded?: string | null
}

// Inspection
export interface DriverInspectResult {
  url: string
  verdict: string | null
  coverageState: string | null
  indexingState: string | null
  lastCrawlTime: string | null
  isIndexed: boolean
  raw: unknown
}

// Analysis
export type AnalysisTool
  = | 'striking-distance' | 'opportunity' | 'movers' | 'decay'
    | 'zero-click' | 'brand' | 'cannibalization' | 'clustering'
    | 'concentration' | 'seasonality' | 'trends'

export interface AnalysisParams {
  type: AnalysisTool
  startDate?: string
  endDate?: string
  prevStartDate?: string
  prevEndDate?: string
  brandTerms?: string[]
  limit?: number
  offset?: number
  // Tool-specific
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
  // Trends-specific
  weeks?: number
  minWeeksWithData?: number
}

export interface AnalysisResult {
  results: Record<string, unknown>[]
  meta: Record<string, unknown>
}

// Cloud-only types

export interface CloudSyncStatus {
  siteUrl: string
  syncStatus: string
  oldestDateAvailable: string | null
  oldestDateSynced: string | null
  newestDateSynced: string | null
  lastSyncAt: number | null
  lastError: string | null
  jobs: { queued: number, processing: number, completed: number, failed: number }
  progress: number
  daysSynced: number
  daysAvailable: number
  isSyncing: boolean
  hasData: boolean
  isComplete: boolean
  tables: Record<string, { queued: number, processing: number, completed: number, failed: number, totalRows: number }>
  failedJobs: { date: string, tableName: string, error: string, retryCount: number }[]
}

export interface CloudRegisterResult {
  siteId: string
  status: string
  message: string
  existing?: boolean
}

export interface CloudDeleteResult {
  deleted: boolean
  siteId: string
  siteUrl: string
}

export interface CloudTriggerSyncResult {
  success: boolean
  jobsQueued: number
  date: string
  message: string
}

export interface CloudBulkRegisterResult {
  results: { siteUrl: string, siteId?: string, status: string, error?: string }[]
  summary: { registered: number, alreadyExists: number, notFound: number, errors: number }
}

export interface CloudAvailableSite {
  siteUrl: string
  permissionLevel: string
  registered: boolean
  siteId?: string
  syncStatus?: string | null
  syncProgress?: { total: number, completed: number, percent: number }
}

export interface CloudIndexingData {
  trend: {
    date: string
    totalUrls: number
    indexedCount: number | null
    notIndexedCount: number | null
    errorCount: number | null
    indexedPercent: number
    issues: Record<string, number | null>
    coverage: Record<string, number | null>
  }[]
  summary: {
    totalUrls: number
    indexed: number
    notIndexed: number
    pending: number
    indexedPercent: number
    oldestCheck: string | null
    newestCheck: string | null
    change7d: number | null
    change28d: number | null
  }
  meta: { siteUrl: string, syncStatus: string | null }
}

export interface CloudIndexingDiagnostics {
  summary: { totalUrls: number, indexed: number, indexedPercent: number }
  issues: { type: string, label: string, severity: string, count: number }[]
  meta: { siteUrl: string }
}

export interface CloudIndexingUrls {
  urls: {
    url: string
    verdict: string | null
    coverageState: string | null
    indexingState: string | null
    lastCrawlTime: string | null
    firstCheckedAt: string
    lastCheckedAt: string
  }[]
  pagination: { total: number, limit: number, offset: number, hasMore: boolean }
  meta: { siteUrl: string, status: string, issue: string | null }
}

export interface CloudIndexPercent {
  trend: { date: string, percent: number, total: number, visible: number }[]
  invisibleUrls: { url: string, clicks: number, impressions: number }[]
  invisibleCount: number
  orphanPages: { url: string, clicks: number, impressions: number }[]
  orphanCount: number
  sitemaps: { path: string, urlCount: number, isIndex: boolean }[]
  summary: {
    currentPercent: number
    totalSitemapUrls: number
    visibleUrls: number
    change7d: number | null
    change28d: number | null
    dataDate: string
  }
  meta: { siteUrl: string, syncStatus: string | null, newestDateSynced: string | null }
}

export interface CloudSitemapHealth {
  sitemaps: { path: string, errors: number, warnings: number, urlCount: number, lastDownloaded: string | null, isPending: boolean }[]
  history: { date: string, errors: number, warnings: number, urlCount: number }[]
  meta: { siteUrl: string, syncStatus: string | null }
}

export interface CloudSitemapActionResult {
  success: boolean
  action: string
  sitemapUrl?: string
  sitemapCount?: number
  changed?: boolean
  deltas?: Record<string, unknown>
}

export interface CloudDataResult {
  rows: Record<string, unknown>[]
  totalCount: number
  totals: Record<string, number>
  meta: { siteUrl: string, syncStatus: string | null, newestDateSynced: string | null, oldestDateSynced: string | null }
}

export interface CloudDetailResult {
  daily: Record<string, unknown>[]
  totals: Record<string, number>
  previousTotals?: Record<string, number>
  meta: { siteUrl: string, syncStatus: string | null, newestDateSynced: string | null, oldestDateSynced: string | null }
}

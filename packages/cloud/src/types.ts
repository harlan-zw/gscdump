import type {
  AnalysisParams,
  AnalysisResult,
} from '@gscdump/analysis'
import type {
  DriverInspectResult,
  DriverQueryParams,
  DriverQueryResult,
  DriverSite,
  DriverSitemap,
  DriverSiteWithSync,
} from 'gscdump/driver'

export type {
  AnalysisParams,
  AnalysisResult,
} from '@gscdump/analysis'
export type {
  DriverInspectResult,
  DriverQueryParams,
  DriverQueryResult,
  DriverSite,
  DriverSitemap,
  DriverSiteWithSync,
} from 'gscdump/driver'

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

export interface CloudGscDriver {
  readonly mode: 'cloud'
  sites: () => Promise<DriverSite[]>
  query: (siteUrl: string, params: DriverQueryParams) => Promise<DriverQueryResult>
  sitemaps: (siteUrl: string) => Promise<DriverSitemap[]>
  submitSitemap: (siteUrl: string, feedpath: string) => Promise<{ success: boolean }>
  deleteSitemap: (siteUrl: string, feedpath: string) => Promise<{ success: boolean }>
  inspect: (siteUrl: string, url: string) => Promise<DriverInspectResult>
  analysis: (siteUrl: string, params: AnalysisParams) => Promise<AnalysisResult>
  sitesWithSync: () => Promise<DriverSiteWithSync[]>
  availableSites: () => Promise<CloudAvailableSite[]>
  registerSite: (siteUrl: string) => Promise<CloudRegisterResult>
  bulkRegister: (siteUrls: string[]) => Promise<CloudBulkRegisterResult>
  deleteSite: (siteUrl: string) => Promise<CloudDeleteResult>
  syncStatus: (siteUrl: string) => Promise<CloudSyncStatus>
  triggerSync: (siteUrl: string) => Promise<CloudTriggerSyncResult>
  indexing: (siteUrl: string, params?: { days?: number }) => Promise<CloudIndexingData>
  indexingDiagnostics: (siteUrl: string) => Promise<CloudIndexingDiagnostics>
  indexingUrls: (siteUrl: string, params?: { status?: string, issue?: string, search?: string, limit?: number, offset?: number }) => Promise<CloudIndexingUrls>
  indexPercent: (siteUrl: string) => Promise<CloudIndexPercent>
  sitemapHealth: (siteUrl: string) => Promise<CloudSitemapHealth>
  sitemapAction: (siteUrl: string, body: { action: string, sitemapUrl?: string }) => Promise<CloudSitemapActionResult>
  data: (siteUrl: string, params: Record<string, string>) => Promise<CloudDataResult>
  detail: (siteUrl: string, body: { q: unknown, qc?: unknown }) => Promise<CloudDetailResult>
  analysisPost: (siteUrl: string, body: AnalysisParams) => Promise<Record<string, unknown>>
  refreshSites: () => Promise<void>
}

export function isCloudDriver(driver: { mode?: string }): driver is CloudGscDriver {
  return driver.mode === 'cloud'
}

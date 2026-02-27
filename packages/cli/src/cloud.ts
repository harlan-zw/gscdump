import process from 'node:process'
import { logger } from './utils'

export interface CloudMeSite {
  siteId: string
  siteUrl: string
  syncStatus: string | null
  syncProgress: { total: number, completed: number, percent: number }
  lastSyncAt: number | null
  newestDateSynced: string | null
  oldestDateSynced: string | null
}

export interface CloudMeResponse {
  user: { publicId: string, email: string }
  sites: CloudMeSite[]
}

export interface CloudAvailableSite {
  siteUrl: string
  permissionLevel: string
  registered: boolean
  siteId?: string
  syncStatus?: string | null
  syncProgress?: { total: number, completed: number, percent: number }
}

export interface CloudRegisterResponse {
  siteId: string
  status: string
  message: string
  existing?: boolean
}

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

export interface CloudDataResponse {
  rows: Record<string, unknown>[]
  totalCount: number
  totals: Record<string, number>
  meta: { siteUrl: string, syncStatus: string | null, newestDateSynced: string | null, oldestDateSynced: string | null }
}

export interface CloudSitemapsResponse {
  sitemaps: { path: string, errors: number, warnings: number, urlCount: number, lastDownloaded: string | null, isPending: boolean }[]
  history: { date: string, errors: number, warnings: number, urlCount: number }[]
  meta: { siteUrl: string, syncStatus: string | null }
}

export interface CloudAnalysisResponse {
  results: Record<string, unknown>[]
  meta: Record<string, unknown>
}

export interface CloudQueryResponse {
  rows: Record<string, unknown>[]
  meta: {
    siteUrl: string
    dimensions: string[]
    dateRange: { startDate: string, endDate: string }
    rowCount: number
    hasMore: boolean
  }
}

export interface CloudIndexingResponse {
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

export interface CloudIndexingDiagnosticsResponse {
  summary: { totalUrls: number, indexed: number, indexedPercent: number }
  issues: { type: string, label: string, severity: string, count: number }[]
  meta: { siteUrl: string }
}

export interface CloudIndexingUrlsResponse {
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

export interface CloudIndexPercentResponse {
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

export interface CloudSitemapActionResponse {
  success: boolean
  action: string
  sitemapUrl?: string
  sitemapCount?: number
  changed?: boolean
  deltas?: Record<string, unknown>
}

export interface CloudTriggerSyncResponse {
  success: boolean
  jobsQueued: number
  date: string
  message: string
}

export interface CloudDeleteSiteResponse {
  deleted: boolean
  siteId: string
  siteUrl: string
}

export interface CloudBulkRegisterResponse {
  results: { siteUrl: string, siteId?: string, status: string, error?: string }[]
  summary: { registered: number, alreadyExists: number, notFound: number, errors: number }
}

export interface CloudAnalysisPostBody {
  type: string
  preset?: string
  startDate?: string
  endDate?: string
  prevStartDate?: string
  prevEndDate?: string
  brandTerms?: string[]
  search?: string
  limit?: number
  offset?: number
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
}

export interface CloudDetailResponse {
  daily: Record<string, unknown>[]
  totals: Record<string, number>
  previousTotals?: Record<string, number>
  meta: { siteUrl: string, syncStatus: string | null, newestDateSynced: string | null, oldestDateSynced: string | null }
}

export interface CloudClient {
  me: () => Promise<CloudMeResponse>
  availableSites: () => Promise<CloudAvailableSite[]>
  registerSite: (siteUrl: string) => Promise<CloudRegisterResponse>
  syncStatus: (siteId: string) => Promise<CloudSyncStatus>
  data: (siteId: string, params: Record<string, string>) => Promise<CloudDataResponse>
  sitemaps: (siteId: string) => Promise<CloudSitemapsResponse>
  analysis: (siteId: string, tool: string, params?: Record<string, string>) => Promise<CloudAnalysisResponse>
  query: (siteId: string, params: Record<string, string>) => Promise<CloudQueryResponse>
  indexing: (siteId: string, params?: Record<string, string>) => Promise<CloudIndexingResponse>
  indexingDiagnostics: (siteId: string) => Promise<CloudIndexingDiagnosticsResponse>
  indexingUrls: (siteId: string, params?: Record<string, string>) => Promise<CloudIndexingUrlsResponse>
  indexPercent: (siteId: string, params?: Record<string, string>) => Promise<CloudIndexPercentResponse>
  sitemapAction: (siteId: string, body: { action: string, sitemapUrl?: string }) => Promise<CloudSitemapActionResponse>
  triggerSync: (siteId: string) => Promise<CloudTriggerSyncResponse>
  deleteSite: (siteId: string) => Promise<CloudDeleteSiteResponse>
  bulkRegister: (siteUrls: string[]) => Promise<CloudBulkRegisterResponse>
  analysisPost: (siteId: string, body: CloudAnalysisPostBody) => Promise<Record<string, unknown>>
  detail: (siteId: string, body: { q: unknown, qc?: unknown }) => Promise<CloudDetailResponse>
}

async function cloudFetch<T>(url: string, options?: RequestInit): Promise<T> {
  const res = await fetch(url, options)

  if (res.status === 401) {
    logger.error('CLI session expired or revoked. Run gscdump init --force to re-authenticate.')
    process.exit(1)
  }

  if (!res.ok) {
    const body = await res.json().catch(() => ({ message: res.statusText })) as { message?: string }
    throw new Error(body.message || `HTTP ${res.status}: ${res.statusText}`)
  }

  return res.json() as Promise<T>
}

function buildUrl(base: string, path: string, query?: Record<string, string>): string {
  const url = new URL(path, base)
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined && v !== '')
        url.searchParams.set(k, v)
    }
  }
  return url.toString()
}

export function createCloudClient(cloudUrl: string, sessionId: string): CloudClient {
  const headers = { 'x-cli-session': sessionId, 'content-type': 'application/json' }

  return {
    me: () => cloudFetch<CloudMeResponse>(
      buildUrl(cloudUrl, '/api/cli/me'),
      { headers },
    ),

    availableSites: () => cloudFetch<CloudAvailableSite[]>(
      buildUrl(cloudUrl, '/api/cli/sites/available'),
      { headers },
    ),

    registerSite: (siteUrl: string) => cloudFetch<CloudRegisterResponse>(
      buildUrl(cloudUrl, '/api/sites/register'),
      { method: 'POST', headers, body: JSON.stringify({ siteUrl }) },
    ),

    syncStatus: (siteId: string) => cloudFetch<CloudSyncStatus>(
      buildUrl(cloudUrl, `/api/sites/${siteId}/sync-status`),
      { headers },
    ),

    data: (siteId: string, params: Record<string, string>) => cloudFetch<CloudDataResponse>(
      buildUrl(cloudUrl, `/api/sites/${siteId}/data`, params),
      { headers },
    ),

    sitemaps: (siteId: string) => cloudFetch<CloudSitemapsResponse>(
      buildUrl(cloudUrl, `/api/sites/${siteId}/sitemaps`),
      { headers },
    ),

    analysis: (siteId: string, tool: string, params?: Record<string, string>) => cloudFetch<CloudAnalysisResponse>(
      buildUrl(cloudUrl, `/api/sites/${siteId}/analysis/${tool}`, params),
      { headers },
    ),

    query: (siteId: string, params: Record<string, string>) => cloudFetch<CloudQueryResponse>(
      buildUrl(cloudUrl, `/api/sites/${siteId}/query`, params),
      { headers },
    ),

    indexing: (siteId: string, params?: Record<string, string>) => cloudFetch<CloudIndexingResponse>(
      buildUrl(cloudUrl, `/api/sites/${siteId}/indexing`, params),
      { headers },
    ),

    indexingDiagnostics: (siteId: string) => cloudFetch<CloudIndexingDiagnosticsResponse>(
      buildUrl(cloudUrl, `/api/sites/${siteId}/indexing/diagnostics`),
      { headers },
    ),

    indexingUrls: (siteId: string, params?: Record<string, string>) => cloudFetch<CloudIndexingUrlsResponse>(
      buildUrl(cloudUrl, `/api/sites/${siteId}/indexing/urls`, params),
      { headers },
    ),

    indexPercent: (siteId: string, params?: Record<string, string>) => cloudFetch<CloudIndexPercentResponse>(
      buildUrl(cloudUrl, `/api/sites/${siteId}/index-percent`, params),
      { headers },
    ),

    sitemapAction: (siteId: string, body: { action: string, sitemapUrl?: string }) => cloudFetch<CloudSitemapActionResponse>(
      buildUrl(cloudUrl, `/api/sites/${siteId}/sitemaps`),
      { method: 'POST', headers, body: JSON.stringify(body) },
    ),

    triggerSync: (siteId: string) => cloudFetch<CloudTriggerSyncResponse>(
      buildUrl(cloudUrl, `/api/sites/${siteId}/sync`),
      { method: 'POST', headers },
    ),

    deleteSite: (siteId: string) => cloudFetch<CloudDeleteSiteResponse>(
      buildUrl(cloudUrl, `/api/sites/${siteId}`),
      { method: 'DELETE', headers },
    ),

    bulkRegister: (siteUrls: string[]) => cloudFetch<CloudBulkRegisterResponse>(
      buildUrl(cloudUrl, '/api/sites/bulk-register'),
      { method: 'POST', headers, body: JSON.stringify({ siteUrls }) },
    ),

    analysisPost: (siteId: string, body: CloudAnalysisPostBody) => cloudFetch<Record<string, unknown>>(
      buildUrl(cloudUrl, `/api/cli/sites/${siteId}/analysis`),
      { method: 'POST', headers, body: JSON.stringify(body) },
    ),

    detail: (siteId: string, body: { q: unknown, qc?: unknown }) => cloudFetch<CloudDetailResponse>(
      buildUrl(cloudUrl, `/api/cli/sites/${siteId}/detail`),
      { method: 'POST', headers, body: JSON.stringify(body) },
    ),
  }
}

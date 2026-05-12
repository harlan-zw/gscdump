import type {
  AnalysisParams,
  AnalysisResult,
  CloudAvailableSite,
  CloudBulkRegisterResult,
  CloudDataResult,
  CloudDeleteResult,
  CloudDetailResult,
  CloudIndexingData,
  CloudIndexingDiagnostics,
  CloudIndexingUrls,
  CloudIndexPercent,
  CloudRegisterResult,
  CloudSitemapActionResult,
  CloudSitemapHealth,
  CloudSyncStatus,
  CloudTriggerSyncResult,
  DriverInspectResult,
  DriverQueryParams,
  DriverQueryResult,
  DriverSiteWithSync,
} from './types'

export interface CloudProtocolOptions {
  cloudUrl: string
  sessionId: string
  version?: string
  fetch?: typeof globalThis.fetch
}

export interface CloudProtocol {
  me: () => Promise<{ sites: DriverSiteWithSync[] }>
  availableSites: () => Promise<CloudAvailableSite[]>
  query: (siteUrl: string, params: DriverQueryParams) => Promise<DriverQueryResult>
  sitemaps: (siteId: string) => Promise<CloudSitemapHealth>
  submitSitemap: (siteId: string, feedpath: string) => Promise<unknown>
  deleteSitemap: (siteId: string, feedpath: string) => Promise<unknown>
  inspect: (siteId: string, url: string) => Promise<DriverInspectResult>
  analysis: (siteId: string, params: AnalysisParams) => Promise<AnalysisResult>
  registerSite: (siteUrl: string) => Promise<CloudRegisterResult>
  bulkRegister: (siteUrls: string[]) => Promise<CloudBulkRegisterResult>
  deleteSite: (siteId: string) => Promise<CloudDeleteResult>
  syncStatus: (siteId: string) => Promise<CloudSyncStatus>
  triggerSync: (siteId: string) => Promise<CloudTriggerSyncResult>
  indexing: (siteId: string, params?: { days?: number }) => Promise<CloudIndexingData>
  indexingDiagnostics: (siteId: string) => Promise<CloudIndexingDiagnostics>
  indexingUrls: (siteId: string, params?: { status?: string, issue?: string, search?: string, limit?: number, offset?: number }) => Promise<CloudIndexingUrls>
  indexPercent: (siteId: string) => Promise<CloudIndexPercent>
  sitemapHealth: (siteId: string) => Promise<CloudSitemapHealth>
  sitemapAction: (siteId: string, body: { action: string, sitemapUrl?: string }) => Promise<CloudSitemapActionResult>
  data: (siteId: string, params: Record<string, string>) => Promise<CloudDataResult>
  detail: (siteId: string, body: { q: unknown, qc?: unknown }) => Promise<CloudDetailResult>
  analysisPost: (siteId: string, body: AnalysisParams) => Promise<Record<string, unknown>>
}

const TRAILING_SLASH_RE = /\/$/

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

async function readErrorMessage(res: Response, fallback: string): Promise<string> {
  const body = await res.json().catch(() => ({ message: fallback })) as { message?: string }
  return body.message || fallback
}

function buildQueryBody(siteUrl: string, params: DriverQueryParams): Record<string, unknown> {
  const body: Record<string, unknown> = {
    siteUrl,
    startDate: params.startDate,
    endDate: params.endDate,
  }
  if (params.dimensions?.length)
    body.dimensions = params.dimensions
  if (params.rowLimit)
    body.rowLimit = params.rowLimit
  if (params.startRow)
    body.startRow = params.startRow
  if (params.searchType)
    body.searchType = params.searchType
  return body
}

export function createHostedCloudProtocol(options: CloudProtocolOptions): CloudProtocol {
  const cloudUrl = options.cloudUrl.replace(TRAILING_SLASH_RE, '')
  const fetchImpl = options.fetch ?? globalThis.fetch
  const headers: Record<string, string> = {
    'x-cli-session': options.sessionId,
    'content-type': 'application/json',
  }
  if (options.version)
    headers['x-cli-version'] = options.version

  async function request<T>(path: string, init?: RequestInit, query?: Record<string, string>): Promise<T> {
    const res = await fetchImpl(buildUrl(cloudUrl, path, query), {
      ...init,
      headers: {
        ...headers,
        ...init?.headers,
      },
    })

    if (res.status === 401)
      throw new Error('CLI session expired or revoked. Run gscdump init --force to re-authenticate.')

    if (res.status === 426)
      throw new Error(await readErrorMessage(res, 'CLI version too old. Run: npm install -g @gscdump/cli'))

    if (!res.ok)
      throw new Error(await readErrorMessage(res, `HTTP ${res.status}: ${res.statusText}`))

    return res.json() as Promise<T>
  }

  return {
    me() {
      return request<{ sites: DriverSiteWithSync[] }>('/api/cli/me')
    },
    availableSites() {
      return request<CloudAvailableSite[]>('/api/sites/available')
    },
    query(siteUrl, params) {
      return request<DriverQueryResult>('/api/gsc/query', {
        method: 'POST',
        body: JSON.stringify(buildQueryBody(siteUrl, params)),
      })
    },
    sitemaps(siteId) {
      return request<CloudSitemapHealth>(`/api/sites/${siteId}/sitemaps`)
    },
    submitSitemap(siteId, feedpath) {
      return request(`/api/sites/${siteId}/sitemaps`, {
        method: 'POST',
        body: JSON.stringify({ action: 'submit', sitemapUrl: feedpath }),
      })
    },
    deleteSitemap(siteId, feedpath) {
      return request(`/api/sites/${siteId}/sitemaps`, {
        method: 'POST',
        body: JSON.stringify({ action: 'delete', sitemapUrl: feedpath }),
      })
    },
    inspect(siteId, url) {
      return request<DriverInspectResult>(`/api/sites/${siteId}/inspect`, {
        method: 'POST',
        body: JSON.stringify({ url }),
      })
    },
    analysis(siteId, params) {
      return request<AnalysisResult>(`/api/__gsc/sites/${siteId}/analyze`, {
        method: 'POST',
        body: JSON.stringify(params),
      })
    },
    registerSite(siteUrl) {
      return request<CloudRegisterResult>('/api/sites/register', {
        method: 'POST',
        body: JSON.stringify({ siteUrl }),
      })
    },
    bulkRegister(siteUrls) {
      return request<CloudBulkRegisterResult>('/api/sites/bulk-register', {
        method: 'POST',
        body: JSON.stringify({ siteUrls }),
      })
    },
    deleteSite(siteId) {
      return request<CloudDeleteResult>(`/api/sites/${siteId}`, { method: 'DELETE' })
    },
    syncStatus(siteId) {
      return request<CloudSyncStatus>(`/api/sites/${siteId}/sync-status`)
    },
    triggerSync(siteId) {
      return request<CloudTriggerSyncResult>(`/api/sites/${siteId}/sync`, { method: 'POST' })
    },
    indexing(siteId, params) {
      const query: Record<string, string> = {}
      if (params?.days)
        query.days = String(params.days)
      return request<CloudIndexingData>(`/api/sites/${siteId}/indexing`, undefined, query)
    },
    indexingDiagnostics(siteId) {
      return request<CloudIndexingDiagnostics>(`/api/sites/${siteId}/indexing/diagnostics`)
    },
    indexingUrls(siteId, params) {
      const query: Record<string, string> = {}
      if (params?.status)
        query.status = params.status
      if (params?.issue)
        query.issue = params.issue
      if (params?.search)
        query.search = params.search
      if (params?.limit)
        query.limit = String(params.limit)
      if (params?.offset)
        query.offset = String(params.offset)
      return request<CloudIndexingUrls>(`/api/sites/${siteId}/indexing/urls`, undefined, query)
    },
    indexPercent(siteId) {
      return request<CloudIndexPercent>(`/api/sites/${siteId}/index-percent`)
    },
    sitemapHealth(siteId) {
      return request<CloudSitemapHealth>(`/api/sites/${siteId}/sitemaps`)
    },
    sitemapAction(siteId, body) {
      return request<CloudSitemapActionResult>(`/api/sites/${siteId}/sitemaps`, {
        method: 'POST',
        body: JSON.stringify(body),
      })
    },
    data(siteId, params) {
      return request<CloudDataResult>(`/api/sites/${siteId}/data`, undefined, params)
    },
    detail(siteId, body) {
      return request<CloudDetailResult>(`/api/sites/${siteId}/data/detail`, {
        method: 'POST',
        body: JSON.stringify(body),
      })
    },
    analysisPost(siteId, body) {
      return request<Record<string, unknown>>(`/api/__gsc/sites/${siteId}/analyze`, {
        method: 'POST',
        body: JSON.stringify(body),
      })
    },
  }
}

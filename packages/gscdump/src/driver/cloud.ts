import type { CloudGscDriver } from './driver'
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
  DriverSite,
  DriverSitemap,
  DriverSiteWithSync,
} from './types'

interface SiteMapping {
  siteUrl: string
  siteId: string
}

async function cloudFetch<T>(url: string, options?: RequestInit): Promise<T> {
  const res = await fetch(url, options)

  if (res.status === 401) {
    throw new Error('CLI session expired or revoked. Run gscdump init --force to re-authenticate.')
  }

  if (res.status === 426) {
    const body = await res.json().catch(() => ({ message: 'Upgrade required' })) as { message?: string }
    throw new Error(body.message || 'CLI version too old. Run: npm install -g @gscdump/cli')
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

export function createCloudDriver(options: {
  cloudUrl: string
  sessionId: string
  version?: string
}): CloudGscDriver {
  const { cloudUrl, sessionId, version } = options
  const headers: Record<string, string> = {
    'x-cli-session': sessionId,
    'content-type': 'application/json',
  }
  if (version)
    headers['x-cli-version'] = version

  // Cache siteUrl -> siteId mapping
  let siteCache: SiteMapping[] | null = null

  async function ensureSiteCache(): Promise<SiteMapping[]> {
    if (siteCache)
      return siteCache
    const me = await cloudFetch<{ sites: { siteId: string, siteUrl: string }[] }>(
      buildUrl(cloudUrl, '/api/cli/me'),
      { headers },
    )
    siteCache = me.sites.map(s => ({ siteUrl: s.siteUrl, siteId: s.siteId }))
    return siteCache
  }

  async function resolveSiteId(siteUrl: string): Promise<string> {
    const cache = await ensureSiteCache()
    const match = cache.find(s => s.siteUrl === siteUrl || s.siteUrl.includes(siteUrl))
    if (!match)
      throw new Error(`Site not found: ${siteUrl}. Run gscdump register first.`)
    return match.siteId
  }

  return {
    mode: 'cloud' as const,

    async sites(): Promise<DriverSite[]> {
      const available = await cloudFetch<CloudAvailableSite[]>(
        buildUrl(cloudUrl, '/api/sites/available'),
        { headers },
      )
      return available.map(s => ({
        siteUrl: s.siteUrl,
        permissionLevel: s.permissionLevel,
      }))
    },

    async sitesWithSync(): Promise<DriverSiteWithSync[]> {
      const me = await cloudFetch<{ sites: DriverSiteWithSync[] }>(
        buildUrl(cloudUrl, '/api/cli/me'),
        { headers },
      )
      // Refresh cache while we have the data
      siteCache = me.sites.map(s => ({ siteUrl: s.siteUrl, siteId: s.siteId }))
      return me.sites
    },

    async availableSites(): Promise<CloudAvailableSite[]> {
      return cloudFetch<CloudAvailableSite[]>(
        buildUrl(cloudUrl, '/api/sites/available'),
        { headers },
      )
    },

    async query(siteUrl: string, params: DriverQueryParams): Promise<DriverQueryResult> {
      const cache = await ensureSiteCache()
      const match = cache.find(s => s.siteUrl === siteUrl || s.siteUrl.includes(siteUrl))
      const resolvedSiteUrl = match?.siteUrl || siteUrl

      const body: Record<string, unknown> = {
        siteUrl: resolvedSiteUrl,
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

      return cloudFetch<DriverQueryResult>(
        buildUrl(cloudUrl, '/api/gsc/query'),
        { method: 'POST', headers, body: JSON.stringify(body) },
      )
    },

    async sitemaps(siteUrl: string): Promise<DriverSitemap[]> {
      const siteId = await resolveSiteId(siteUrl)
      const data = await cloudFetch<CloudSitemapHealth>(
        buildUrl(cloudUrl, `/api/sites/${siteId}/sitemaps`),
        { headers },
      )
      return data.sitemaps.map(sm => ({
        path: sm.path,
        isPending: sm.isPending,
        errors: sm.errors,
        warnings: sm.warnings,
        urlCount: sm.urlCount,
        lastDownloaded: sm.lastDownloaded,
      }))
    },

    async submitSitemap(siteUrl: string, feedpath: string) {
      const siteId = await resolveSiteId(siteUrl)
      await cloudFetch(
        buildUrl(cloudUrl, `/api/sites/${siteId}/sitemaps`),
        { method: 'POST', headers, body: JSON.stringify({ action: 'submit', sitemapUrl: feedpath }) },
      )
      return { success: true }
    },

    async deleteSitemap(siteUrl: string, feedpath: string) {
      const siteId = await resolveSiteId(siteUrl)
      await cloudFetch(
        buildUrl(cloudUrl, `/api/sites/${siteId}/sitemaps`),
        { method: 'POST', headers, body: JSON.stringify({ action: 'delete', sitemapUrl: feedpath }) },
      )
      return { success: true }
    },

    async inspect(siteUrl: string, url: string): Promise<DriverInspectResult> {
      const siteId = await resolveSiteId(siteUrl)
      return cloudFetch<DriverInspectResult>(
        buildUrl(cloudUrl, `/api/sites/${siteId}/inspect`),
        { method: 'POST', headers, body: JSON.stringify({ url }) },
      )
    },

    async analysis(siteUrl: string, params: AnalysisParams): Promise<AnalysisResult> {
      const siteId = await resolveSiteId(siteUrl)
      return cloudFetch<AnalysisResult>(
        buildUrl(cloudUrl, `/api/sites/${siteId}/analysis`),
        { method: 'POST', headers, body: JSON.stringify(params) },
      )
    },

    // Cloud-only methods

    async registerSite(siteUrl: string): Promise<CloudRegisterResult> {
      return cloudFetch<CloudRegisterResult>(
        buildUrl(cloudUrl, '/api/sites/register'),
        { method: 'POST', headers, body: JSON.stringify({ siteUrl }) },
      )
    },

    async bulkRegister(siteUrls: string[]): Promise<CloudBulkRegisterResult> {
      return cloudFetch<CloudBulkRegisterResult>(
        buildUrl(cloudUrl, '/api/sites/bulk-register'),
        { method: 'POST', headers, body: JSON.stringify({ siteUrls }) },
      )
    },

    async deleteSite(siteUrl: string): Promise<CloudDeleteResult> {
      const siteId = await resolveSiteId(siteUrl)
      const result = await cloudFetch<CloudDeleteResult>(
        buildUrl(cloudUrl, `/api/sites/${siteId}`),
        { method: 'DELETE', headers },
      )
      // Invalidate cache since site list changed
      siteCache = null
      return result
    },

    async syncStatus(siteUrl: string): Promise<CloudSyncStatus> {
      const siteId = await resolveSiteId(siteUrl)
      return cloudFetch<CloudSyncStatus>(
        buildUrl(cloudUrl, `/api/sites/${siteId}/sync-status`),
        { headers },
      )
    },

    async triggerSync(siteUrl: string): Promise<CloudTriggerSyncResult> {
      const siteId = await resolveSiteId(siteUrl)
      return cloudFetch<CloudTriggerSyncResult>(
        buildUrl(cloudUrl, `/api/sites/${siteId}/sync`),
        { method: 'POST', headers },
      )
    },

    async indexing(siteUrl: string, params?: { days?: number }): Promise<CloudIndexingData> {
      const siteId = await resolveSiteId(siteUrl)
      const query: Record<string, string> = {}
      if (params?.days)
        query.days = String(params.days)
      return cloudFetch<CloudIndexingData>(
        buildUrl(cloudUrl, `/api/sites/${siteId}/indexing`, query),
        { headers },
      )
    },

    async indexingDiagnostics(siteUrl: string): Promise<CloudIndexingDiagnostics> {
      const siteId = await resolveSiteId(siteUrl)
      return cloudFetch<CloudIndexingDiagnostics>(
        buildUrl(cloudUrl, `/api/sites/${siteId}/indexing/diagnostics`),
        { headers },
      )
    },

    async indexingUrls(siteUrl: string, params?: { status?: string, issue?: string, search?: string, limit?: number, offset?: number }): Promise<CloudIndexingUrls> {
      const siteId = await resolveSiteId(siteUrl)
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
      return cloudFetch<CloudIndexingUrls>(
        buildUrl(cloudUrl, `/api/sites/${siteId}/indexing/urls`, query),
        { headers },
      )
    },

    async indexPercent(siteUrl: string): Promise<CloudIndexPercent> {
      const siteId = await resolveSiteId(siteUrl)
      return cloudFetch<CloudIndexPercent>(
        buildUrl(cloudUrl, `/api/sites/${siteId}/index-percent`),
        { headers },
      )
    },

    async sitemapHealth(siteUrl: string): Promise<CloudSitemapHealth> {
      const siteId = await resolveSiteId(siteUrl)
      return cloudFetch<CloudSitemapHealth>(
        buildUrl(cloudUrl, `/api/sites/${siteId}/sitemaps`),
        { headers },
      )
    },

    async sitemapAction(siteUrl: string, body: { action: string, sitemapUrl?: string }): Promise<CloudSitemapActionResult> {
      const siteId = await resolveSiteId(siteUrl)
      return cloudFetch<CloudSitemapActionResult>(
        buildUrl(cloudUrl, `/api/sites/${siteId}/sitemaps`),
        { method: 'POST', headers, body: JSON.stringify(body) },
      )
    },

    async data(siteUrl: string, params: Record<string, string>): Promise<CloudDataResult> {
      const siteId = await resolveSiteId(siteUrl)
      return cloudFetch<CloudDataResult>(
        buildUrl(cloudUrl, `/api/sites/${siteId}/data`, params),
        { headers },
      )
    },

    async detail(siteUrl: string, body: { q: unknown, qc?: unknown }): Promise<CloudDetailResult> {
      const siteId = await resolveSiteId(siteUrl)
      return cloudFetch<CloudDetailResult>(
        buildUrl(cloudUrl, `/api/sites/${siteId}/data/detail`),
        { method: 'POST', headers, body: JSON.stringify(body) },
      )
    },

    async analysisPost(siteUrl: string, body: AnalysisParams): Promise<Record<string, unknown>> {
      const siteId = await resolveSiteId(siteUrl)
      return cloudFetch<Record<string, unknown>>(
        buildUrl(cloudUrl, `/api/sites/${siteId}/analysis`),
        { method: 'POST', headers, body: JSON.stringify(body) },
      )
    },

    async refreshSites(): Promise<void> {
      siteCache = null
    },
  }
}

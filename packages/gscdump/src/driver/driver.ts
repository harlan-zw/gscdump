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

export interface GscDriver {
  readonly mode: 'local' | 'cloud'
  sites: () => Promise<DriverSite[]>
  query: (siteUrl: string, params: DriverQueryParams) => Promise<DriverQueryResult>
  sitemaps: (siteUrl: string) => Promise<DriverSitemap[]>
  submitSitemap: (siteUrl: string, feedpath: string) => Promise<{ success: boolean }>
  deleteSitemap: (siteUrl: string, feedpath: string) => Promise<{ success: boolean }>
  inspect: (siteUrl: string, url: string) => Promise<DriverInspectResult>
  analysis: (siteUrl: string, params: AnalysisParams) => Promise<AnalysisResult>
}

export interface CloudGscDriver extends GscDriver {
  readonly mode: 'cloud'
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

export function isCloudDriver(driver: GscDriver): driver is CloudGscDriver {
  return driver.mode === 'cloud'
}

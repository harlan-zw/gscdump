// Lifecycle adapters: map gscdump.com's partner lifecycle wire shape into
// the user-facing site/sync shapes hosts typically render. These live in the
// SDK so hosts don't reinvent the mapping per app.

import type { GscdumpSyncStatusResponse, GscdumpUserSite, PartnerLifecycleResponse, PartnerLifecycleSite } from '@gscdump/contracts'

function normalizeLifecycleUrl(url: string | null | undefined): string {
  return (url || '')
    .replace(/^sc-domain:/, '')
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '')
    .replace(/\/$/, '')
    .toLowerCase()
}

function normalizeGscPropertyKey(url: string | null | undefined): string {
  const value = url || ''
  if (!value)
    return ''
  if (value.startsWith('sc-domain:'))
    return `domain:${normalizeLifecycleUrl(value)}`
  if (!/^https?:\/\//.test(value))
    return ''
  return `url:${normalizeLifecycleUrl(value)}`
}

export function analyticsStatusToSyncStatus(status: PartnerLifecycleSite['analytics']['status']): GscdumpUserSite['syncStatus'] {
  switch (status) {
    case 'ready':
    case 'queryable_live':
    case 'queryable_partial':
      return 'synced'
    case 'syncing':
    case 'preparing':
      return 'syncing'
    case 'failed':
      return 'error'
    case 'not_registered':
    case 'queued':
    default:
      return 'pending'
  }
}

export function lifecycleSiteToUserSite(site: PartnerLifecycleSite): GscdumpUserSite {
  const syncStatus = analyticsStatusToSyncStatus(site.analytics.status)
  return {
    siteId: site.siteId,
    siteUrl: site.gscPropertyUrl || site.requestedUrl,
    analyticsSyncStatus: syncStatus,
    analyticsSyncProgress: site.analytics.progress,
    syncStatus,
    syncProgress: site.analytics.progress,
    indexingEligible: site.indexing.eligible,
    indexingIneligibleReason: site.indexing.reason as GscdumpUserSite['indexingIneligibleReason'],
    indexingPermissionLevel: site.permissionLevel,
    indexingStatus: site.indexing.status === 'ready' ? 'complete' : site.indexing.status === 'not_requested' ? 'not_started' : 'indexing',
    indexingProgress: site.indexing.progress,
    lastSyncAt: site.updatedAt ? Date.parse(site.updatedAt) : null,
    newestDateSynced: site.analytics.syncedRange.newest,
    oldestDateSynced: site.analytics.syncedRange.oldest,
  }
}

export function lifecycleSiteToSyncStatus(site: PartnerLifecycleSite): GscdumpSyncStatusResponse {
  const syncStatus = analyticsStatusToSyncStatus(site.analytics.status) as GscdumpSyncStatusResponse['syncStatus']
  const completed = site.analytics.progress.completed
  const failed = site.analytics.progress.failed
  const total = site.analytics.progress.total
  const queued = Math.max(total - completed - failed, 0)
  return {
    siteUrl: site.gscPropertyUrl || site.requestedUrl,
    syncStatus,
    oldestDateAvailable: site.analytics.syncedRange.oldest,
    oldestDateSynced: site.analytics.syncedRange.oldest,
    newestDateSynced: site.analytics.syncedRange.newest,
    lastSyncAt: site.updatedAt ? Date.parse(site.updatedAt) : null,
    lastError: site.latestError?.message ?? null,
    jobs: {
      queued,
      processing: ['queued', 'preparing', 'syncing'].includes(site.analytics.status) ? 1 : 0,
      completed,
      failed,
    },
    progress: site.analytics.progress.percent,
    jobProgress: site.analytics.progress.percent,
    daysSynced: completed,
    daysAvailable: total,
    isSyncing: ['queued', 'preparing', 'syncing'].includes(site.analytics.status),
    hasData: site.analytics.queryable,
    isComplete: site.analytics.queryable && site.analytics.status === 'ready',
    tables: {},
  }
}

export function findLifecycleSite(lifecycle: PartnerLifecycleResponse, siteIdOrPropertyUrl: string): PartnerLifecycleSite | null {
  const normalized = normalizeLifecycleUrl(siteIdOrPropertyUrl)
  const propertyKey = normalizeGscPropertyKey(siteIdOrPropertyUrl)
  return lifecycle.sites.find(site =>
    site.siteId === siteIdOrPropertyUrl
    || site.externalSiteId === siteIdOrPropertyUrl
    || (!!propertyKey && normalizeGscPropertyKey(site.gscPropertyUrl) === propertyKey)
    || (!site.gscPropertyUrl && normalizeLifecycleUrl(site.requestedUrl) === normalized)
    || (!propertyKey && normalizeLifecycleUrl(site.requestedUrl) === normalized),
  ) ?? null
}

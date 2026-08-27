// Lifecycle adapters: map gscdump.com's partner lifecycle wire shape into
// the user-facing site/sync shapes hosts typically render. These live in the
// SDK so hosts don't reinvent the mapping per app.

import type { GscdumpSyncStatusResponse, GscdumpUserSite, PartnerLifecycleSite } from '@gscdump/contracts'

/**
 * Stable lifecycle fields shared by the legacy partner response and public v1.
 * Keeping the adapters structural lets consumers migrate to v1 without
 * re-introducing legacy-only fields such as `intId` or `lifecycleRevision`.
 */
export type LifecycleSiteLike = Pick<PartnerLifecycleSite, | 'siteId'
  | 'externalSiteId'
  | 'requestedUrl'
  | 'gscPropertyUrl'
  | 'permissionLevel'
  | 'analytics'
  | 'indexing'
  | 'latestError'
  | 'updatedAt'>

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

export function analyticsStatusToSyncStatus(status: LifecycleSiteLike['analytics']['status']): GscdumpUserSite['syncStatus'] {
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

export function lifecycleSiteToSyncStatus(site: LifecycleSiteLike): GscdumpSyncStatusResponse {
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

export function findLifecycleSite<TSite extends LifecycleSiteLike>(
  lifecycle: { sites: readonly TSite[] },
  siteIdOrPropertyUrl: string,
): TSite | null {
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

// Lifecycle adapters: map gscdump.com's partner lifecycle wire shape into
// the user-facing site/sync shapes hosts typically render. These live in the
// SDK so hosts don't reinvent the mapping per app.

import type { GscdumpSyncStatusResponse, LifecycleProgress, PartnerLifecycleSite, SiteHoldReason } from '@gscdump/contracts'

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

/**
 * A Site's Backfill, read from the lifecycle. Only `Ready` says the record
 * serves reads: gscdump.com reports `ready` only once the Team catalog serves
 * them.
 *
 * `analytics.queryable` never decides it. That flag is also true for
 * `queryable_live`, where a partner reads Google live while the record holds
 * 0 days, so a status-only mapping called a Site connected a second ago synced.
 *
 * - `Starting`: registered, and no Sync job has finished yet.
 * - `Running`: Sync jobs are open.
 * - `PreparingRecord`: the Backfill finished, and the record does not serve reads yet.
 * - `Ready`: the record serves reads.
 * - `NoRows`: every Sync job finished and none failed, but the host has no
 *   Search Console rows, so the record never gets a synced range and the
 *   lifecycle stays `queryable_live`.
 * - `Partial`: some days failed to sync.
 * - `Held`: no Backfill starts until the user acts. `size_pending` is still
 *   measuring, so it reads as `Starting`.
 * - `Failed`: the Backfill stopped.
 */
export type LifecycleBackfill
  = | { _tag: 'Starting' }
    | { _tag: 'Running' }
    | { _tag: 'PreparingRecord' }
    | { _tag: 'Ready' }
    | { _tag: 'NoRows' }
    | { _tag: 'Partial' }
    | { _tag: 'Held', hold: Exclude<SiteHoldReason, 'size_pending'> }
    | { _tag: 'Failed' }

/** The lifecycle fields the Backfill reader needs. A host older than contracts 4.7.0 sends no `hold`. */
export interface LifecycleBackfillInput {
  analytics: Pick<LifecycleSiteLike['analytics'], 'status'> & { progress: Pick<LifecycleProgress, 'completed' | 'failed' | 'total'> }
  hold?: SiteHoldReason | null
}

export function resolveLifecycleBackfill(site: LifecycleBackfillInput): LifecycleBackfill {
  const { status, progress } = site.analytics
  const open = progress.total > 0 && progress.completed + progress.failed < progress.total
  const hold = site.hold && site.hold !== 'size_pending' ? site.hold : null
  switch (status) {
    case 'ready':
      return { _tag: 'Ready' }
    case 'failed':
      return { _tag: 'Failed' }
    case 'syncing':
      return { _tag: 'Running' }
    case 'preparing':
      return { _tag: 'PreparingRecord' }
    case 'queryable_live':
      if (open)
        return { _tag: 'Running' }
      if (progress.failed > 0)
        return { _tag: 'Partial' }
      // A Site registered a second ago has no job yet. Only a finished job set
      // tells it apart from a host with no rows.
      if (progress.total > 0 && progress.completed >= progress.total)
        return { _tag: 'NoRows' }
      return hold ? { _tag: 'Held', hold } : { _tag: 'Starting' }
    case 'queryable_partial':
      if (open)
        return { _tag: 'Running' }
      // With no failed day, gscdump.com has not marked the record synced yet.
      return progress.failed > 0 ? { _tag: 'Partial' } : { _tag: 'Running' }
    case 'not_registered':
    case 'queued':
    default:
      // A status newer than this contract pin never reads as done.
      return hold ? { _tag: 'Held', hold } : { _tag: 'Starting' }
  }
}

/** Whether the first Backfill is done: the record serves reads, or the host has no rows to read. */
export function isLifecycleBackfillComplete(backfill: LifecycleBackfill): boolean {
  return backfill._tag === 'Ready' || backfill._tag === 'NoRows'
}

/** `synced` means the Backfill is complete, nothing less. */
function backfillSyncStatus(backfill: LifecycleBackfill): GscdumpSyncStatusResponse['syncStatus'] {
  switch (backfill._tag) {
    case 'Starting':
    case 'Held':
      return 'pending'
    case 'Running':
    case 'PreparingRecord':
      return 'syncing'
    case 'Ready':
    case 'NoRows':
      return 'synced'
    case 'Partial':
    case 'Failed':
      return 'error'
  }
}

export function lifecycleSiteToSyncStatus(site: LifecycleSiteLike & Pick<LifecycleBackfillInput, 'hold'>): GscdumpSyncStatusResponse {
  const backfill = resolveLifecycleBackfill(site)
  const isSyncing = backfill._tag === 'Starting' || backfill._tag === 'Running' || backfill._tag === 'PreparingRecord'
  const completed = site.analytics.progress.completed
  const failed = site.analytics.progress.failed
  const total = site.analytics.progress.total
  const queued = Math.max(total - completed - failed, 0)
  return {
    siteUrl: site.gscPropertyUrl || site.requestedUrl,
    syncStatus: backfillSyncStatus(backfill),
    oldestDateAvailable: site.analytics.syncedRange.oldest,
    oldestDateSynced: site.analytics.syncedRange.oldest,
    newestDateSynced: site.analytics.syncedRange.newest,
    lastSyncAt: site.updatedAt ? Date.parse(site.updatedAt) : null,
    lastError: site.latestError?.message ?? null,
    jobs: {
      queued,
      processing: isSyncing ? 1 : 0,
      completed,
      failed,
    },
    progress: site.analytics.progress.percent,
    jobProgress: site.analytics.progress.percent,
    daysSynced: completed,
    daysAvailable: total,
    isSyncing,
    hasData: site.analytics.queryable,
    isComplete: isLifecycleBackfillComplete(backfill),
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

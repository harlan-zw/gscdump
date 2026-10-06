import type { AnalyticsStatus, LifecycleProgress, SiteHoldReason } from '@gscdump/contracts'
import type { LifecycleSiteLike } from '../src/lifecycle'
import { lifecycleSiteToSyncStatus, resolveLifecycleBackfill } from '../src/lifecycle'

function site(status: AnalyticsStatus, progress: Partial<LifecycleProgress> = {}, hold: SiteHoldReason | null = null): LifecycleSiteLike & { hold: SiteHoldReason | null } {
  const counts = { completed: 0, failed: 0, total: 0, ...progress }
  return {
    siteId: 's_1',
    externalSiteId: null,
    requestedUrl: 'https://example.com/',
    gscPropertyUrl: 'sc-domain:example.com',
    permissionLevel: 'siteOwner',
    analytics: {
      status,
      progress: { ...counts, percent: counts.total ? Math.floor((counts.completed / counts.total) * 100) : 0 },
      queryable: status === 'ready' || status === 'queryable_live' || status === 'queryable_partial',
      sourceMode: 'r2',
      syncedRange: { oldest: null, newest: null },
      nextAction: 'none',
    },
    indexing: {
      status: 'not_requested',
      eligible: false,
      reason: null,
      progress: { completed: 0, failed: 0, total: 0, percent: 0 },
      nextAction: 'none',
    },
    hold,
    latestError: null,
    updatedAt: '2026-10-06T00:00:00.000Z',
  } as LifecycleSiteLike & { hold: SiteHoldReason | null }
}

describe('lifecycleSiteToSyncStatus', () => {
  // A Site connected a second ago reads `queryable_live`: a partner can query
  // Google live, while the record holds 0 days. The SDK called it synced, so a
  // host showed a finished Backfill before one started.
  it('never reads a Site with no finished job as synced', () => {
    const status = lifecycleSiteToSyncStatus(site('queryable_live'))
    expect(status.syncStatus).toBe('pending')
    expect(status.isComplete).toBe(false)
  })

  it('reads open Sync jobs on a live-queryable Site as syncing', () => {
    const status = lifecycleSiteToSyncStatus(site('queryable_live', { completed: 3, total: 10 }))
    expect(status.syncStatus).toBe('syncing')
    expect(status.isSyncing).toBe(true)
  })

  it('reads a partial record with no failed day as still syncing', () => {
    expect(lifecycleSiteToSyncStatus(site('queryable_partial', { completed: 10, total: 10 })).syncStatus).toBe('syncing')
  })

  it('reads a partial record with failed days as an error', () => {
    expect(lifecycleSiteToSyncStatus(site('queryable_partial', { completed: 8, failed: 2, total: 10 })).syncStatus).toBe('error')
  })

  it.each([
    ['a readable record', site('ready', { completed: 10, total: 10 })],
    ['a host with no Search Console rows', site('queryable_live', { completed: 10, total: 10 })],
  ])('reads %s as a complete Backfill', (_label, input) => {
    const status = lifecycleSiteToSyncStatus(input)
    expect(status.syncStatus).toBe('synced')
    expect(status.isComplete).toBe(true)
    expect(status.isSyncing).toBe(false)
  })

  it('reads a held Site as pending, with nothing syncing', () => {
    const status = lifecycleSiteToSyncStatus(site('queued', {}, 'size_limit'))
    expect(status.syncStatus).toBe('pending')
    expect(status.isSyncing).toBe(false)
  })
})

describe('resolveLifecycleBackfill', () => {
  it('reads a Site still measuring its size as starting, not held', () => {
    expect(resolveLifecycleBackfill(site('queued', {}, 'size_pending'))).toEqual({ _tag: 'Starting' })
  })

  it('names the hold that stops the Backfill', () => {
    expect(resolveLifecycleBackfill(site('queued', {}, 'size_limit'))).toEqual({ _tag: 'Held', hold: 'size_limit' })
  })
})

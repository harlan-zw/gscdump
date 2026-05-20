// Detects `meta.backfillRequired` from tool/analysis responses, kicks off an
// on-demand backfill request, polls sync-progress, and invokes a refetch once
// the requested range is synced.

import { useGscFetch } from '../utils/gsc-fetch'
import { useGscAnalyticsClient } from './useGscAnalyticsClient'

interface BackfillRange {
  startDate: string
  endDate: string
}

interface SyncProgressResponse {
  sites?: Array<{
    id: string
    oldestDateSynced?: string | null
    newestDateSynced?: string | null
    syncStatus?: string
    backfill?: { percent?: number }
  }>
}

export interface GscBackfillState {
  pending: Ref<boolean>
  range: Ref<BackfillRange | null>
  percent: Ref<number>
  error: Ref<string | null>
}

const POLL_INTERVAL_MS = 4000
const POLL_MAX_MS = 15 * 60 * 1000

export function useGscBackfill(): GscBackfillState & {
  request: (siteId: string, req: BackfillRange, refetch: () => Promise<unknown> | unknown) => Promise<void>
  maybeTrigger: (meta: unknown, siteId: string, refetch: () => Promise<unknown> | unknown) => boolean
  reset: () => void
} {
  const pending = ref(false)
  const range = ref<BackfillRange | null>(null)
  const percent = ref(0)
  const error = ref<string | null>(null)
  // Track ranges we've already attempted in this session so a failed/timed-out
  // backfill doesn't retrigger on every refetch.
  const attemptedKeys = new Set<string>()

  function rangeKey(siteId: string, r: BackfillRange): string {
    return `${siteId}:${r.startDate}:${r.endDate}`
  }

  async function isRangeCovered(siteId: string, req: BackfillRange): Promise<boolean> {
    const progress = await useGscFetch()<SyncProgressResponse>('/api/sync-progress').catch(() => null)
    const site = progress?.sites?.find(s => s.id === siteId)
    if (!site?.oldestDateSynced || !site?.newestDateSynced)
      return false
    percent.value = site.backfill?.percent ?? percent.value
    return req.startDate >= site.oldestDateSynced && req.endDate <= site.newestDateSynced
  }

  async function request(siteId: string, req: BackfillRange, refetch: () => Promise<unknown> | unknown): Promise<void> {
    pending.value = true
    range.value = req
    percent.value = 0
    error.value = null
    attemptedKeys.add(rangeKey(siteId, req))

    await useGscAnalyticsClient().requestBackfill(siteId, req).catch((err) => {
      error.value = (err as { data?: { message?: string }, message?: string })?.data?.message
        || (err as Error)?.message
        || 'Failed to queue backfill'
    })

    if (error.value) {
      pending.value = false
      return
    }

    const started = Date.now()
    let covered = false
    while (Date.now() - started < POLL_MAX_MS) {
      await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL_MS))
      covered = await isRangeCovered(siteId, req)
      if (covered)
        break
    }

    if (!covered)
      error.value = 'Backfill did not complete within the expected window. Try again later.'

    if (covered)
      await refetch()
    pending.value = false
    range.value = null
  }

  function maybeTrigger(meta: unknown, siteId: string, refetch: () => Promise<unknown> | unknown): boolean {
    const backfillRequired = (meta as { backfillRequired?: BackfillRange })?.backfillRequired
    if (!backfillRequired || pending.value)
      return false
    if (attemptedKeys.has(rangeKey(siteId, backfillRequired)))
      return false
    request(siteId, backfillRequired, refetch)
    return true
  }

  function reset(): void {
    attemptedKeys.clear()
    error.value = null
  }

  return { pending, range, percent, error, request, maybeTrigger, reset }
}

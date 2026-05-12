// Fetches the snapshot timeline for a single sitemap (by feedpath hash)
// from the site's history store. Oldest → newest.

import type { SitemapHistoryRecord, SitemapHistoryResponse } from '@gscdump/contracts'
import type { ComputedRef, Ref } from '@vue/runtime-core'
import type { GscResourceStatus } from './_useGscResource'
import { useGscResource } from './_useGscResource'
import { useGscAnalyticsClient } from './useGscAnalyticsClient'

export interface UseGscSitemapHistoryReturn {
  response: Readonly<Ref<SitemapHistoryResponse | null>>
  snapshots: ComputedRef<SitemapHistoryRecord[]>
  path: ComputedRef<string | null>
  loading: ComputedRef<boolean>
  status: Ref<GscResourceStatus>
  error: Ref<Error | null>
  refresh: () => Promise<void>
}

export function useGscSitemapHistory(
  siteId: MaybeRefOrGetter<string | null | undefined>,
  feedpathHash: MaybeRefOrGetter<string | null | undefined>,
): UseGscSitemapHistoryReturn {
  const { data, status, loading, error, refresh } = useGscResource({
    keys: [siteId, feedpathHash] as const,
    fetcher: (id: string, hash: string) => useGscAnalyticsClient().getSitemapHistory(id, hash),
  })

  const snapshots = computed(() => data.value?.snapshots ?? [])
  const path = computed(() => data.value?.path ?? null)

  return {
    response: data as Readonly<Ref<SitemapHistoryResponse | null>>,
    snapshots,
    path,
    loading,
    status,
    error,
    refresh,
  }
}

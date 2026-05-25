// Fetches the snapshot timeline for a single sitemap (by feedpath hash)
// from the site's history store. Oldest → newest.

import type { SitemapHistoryRecord, SitemapHistoryResponse } from '@gscdump/contracts'
import type { ComputedRef, Ref } from '@vue/runtime-core'
import type { GscResourceStatus } from './_useGscResource'
import { gscQueries } from '../queries/gsc'
import { useGscResource } from './_useGscResource'

export interface UseGscSitemapHistoryReturn {
  response: Readonly<Ref<SitemapHistoryResponse | null>>
  snapshots: ComputedRef<SitemapHistoryRecord[]>
  path: ComputedRef<string | null>
  loading: ComputedRef<boolean>
  status: Readonly<Ref<GscResourceStatus>>
  error: Readonly<Ref<Error | null>>
  refresh: () => Promise<void>
}

export function useGscSitemapHistory(
  siteId: MaybeRefOrGetter<string | null | undefined>,
  feedpathHash: MaybeRefOrGetter<string | null | undefined>,
): UseGscSitemapHistoryReturn {
  const { data, status, loading, error, refresh } = useGscResource<[string, string], SitemapHistoryResponse>({
    keys: [siteId, feedpathHash] as const,
    operation: (id, hash) => gscQueries.sitemapHistory(id, hash),
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

// Fetches the snapshot timeline for a single sitemap (by feedpath hash)
// from the site's history store. Oldest → newest.

import type { SitemapHistoryRecord, SitemapHistoryResponse } from '@gscdump/contracts'
import { useGscAnalyticsClient } from './useGscAnalyticsClient'

export interface UseGscSitemapHistoryReturn {
  response: Readonly<Ref<SitemapHistoryResponse | null>>
  snapshots: ComputedRef<SitemapHistoryRecord[]>
  path: ComputedRef<string | null>
  loading: Readonly<Ref<boolean>>
  refresh: () => Promise<void>
}

export function useGscSitemapHistory(
  siteId: MaybeRefOrGetter<string | null | undefined>,
  feedpathHash: MaybeRefOrGetter<string | null | undefined>,
): UseGscSitemapHistoryReturn {
  const response = ref<SitemapHistoryResponse | null>(null)
  const loading = ref(false)

  async function refresh(): Promise<void> {
    const id = toValue(siteId)
    const hash = toValue(feedpathHash)
    if (!id || !hash) {
      response.value = null
      return
    }
    loading.value = true
    response.value = await useGscAnalyticsClient().getSitemapHistory(id, hash).catch(() => null)
    loading.value = false
  }

  watch(() => [toValue(siteId), toValue(feedpathHash)], refresh, { immediate: true })

  const snapshots = computed(() => response.value?.snapshots ?? [])
  const path = computed(() => response.value?.path ?? null)

  return {
    response: response as Readonly<typeof response>,
    snapshots,
    path,
    loading: loading as Readonly<Ref<boolean>>,
    refresh,
  }
}

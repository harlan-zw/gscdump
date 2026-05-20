// Fetches the sitemap entity index for a site. Records are sorted by
// `lastDownloaded` desc. Split from the previous `useEntity(kind)` discriminated
// API so each entity stays its own typed hook.

import type { SitemapHistoryRecord, SitemapIndex } from '@gscdump/contracts'
import type { ComputedRef, Ref } from '@vue/runtime-core'
import type { GscResourceStatus } from './_useGscResource'
import { useGscResource } from './_useGscResource'
import { useGscAnalyticsClient } from './useGscAnalyticsClient'

export interface UseGscSitemapsReturn {
  index: Readonly<Ref<SitemapIndex | null>>
  records: ComputedRef<SitemapHistoryRecord[]>
  loading: ComputedRef<boolean>
  status: Ref<GscResourceStatus>
  error: Ref<Error | null>
  refresh: () => Promise<void>
}

export function useGscSitemaps(siteId: MaybeRefOrGetter<string | null | undefined>): UseGscSitemapsReturn {
  const { data, status, loading, error, refresh } = useGscResource({
    keys: [siteId] as const,
    fetcher: (id: string) => useGscAnalyticsClient().getSitemaps(id),
  })

  const records = computed<SitemapHistoryRecord[]>(() => {
    if (!data.value)
      return []
    const list = Object.values(data.value.records) as SitemapHistoryRecord[]
    return list.sort((a, b) => {
      const ad = a.lastDownloaded ?? ''
      const bd = b.lastDownloaded ?? ''
      return bd.localeCompare(ad)
    })
  })

  return {
    index: data as Readonly<Ref<SitemapIndex | null>>,
    records,
    loading,
    status,
    error,
    refresh,
  }
}

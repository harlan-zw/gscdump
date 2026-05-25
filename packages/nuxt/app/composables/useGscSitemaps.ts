// Fetches the sitemap entity index for a site. Records are sorted by
// `lastDownloaded` desc. Split from the previous `useEntity(kind)` discriminated
// API so each entity stays its own typed hook.

import type { SitemapHistoryRecord, SitemapIndex } from '@gscdump/contracts'
import type { ComputedRef, Ref } from '@vue/runtime-core'
import type { GscResourceStatus } from './_useGscResource'
import { gscQueries } from '../queries/gsc'
import { useGscResource } from './_useGscResource'

export interface UseGscSitemapsReturn {
  index: Readonly<Ref<SitemapIndex | null>>
  records: ComputedRef<SitemapHistoryRecord[]>
  loading: ComputedRef<boolean>
  status: Readonly<Ref<GscResourceStatus>>
  error: Readonly<Ref<Error | null>>
  refresh: () => Promise<void>
}

export function useGscSitemaps(siteId: MaybeRefOrGetter<string | null | undefined>): UseGscSitemapsReturn {
  const { data, status, loading, error, refresh } = useGscResource<[string], SitemapIndex>({
    keys: [siteId] as const,
    operation: (id: string) => gscQueries.sitemaps(id),
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

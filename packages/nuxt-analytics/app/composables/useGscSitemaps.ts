// Fetches the sitemap entity index for a site. Records are sorted by
// `lastDownloaded` desc. Split from the previous `useEntity(kind)` discriminated
// API so each entity stays its own typed hook.

import type { SitemapHistoryRecord, SitemapIndex } from '@gscdump/contracts'
import { useGscAnalyticsClient } from './useGscAnalyticsClient'

export interface UseGscSitemapsReturn {
  index: Readonly<Ref<SitemapIndex | null>>
  records: ComputedRef<SitemapHistoryRecord[]>
  loading: Readonly<Ref<boolean>>
  refresh: () => Promise<void>
}

export function useGscSitemaps(siteId: MaybeRefOrGetter<string | null | undefined>): UseGscSitemapsReturn {
  const index = ref<SitemapIndex | null>(null)
  const loading = ref(false)

  async function refresh(): Promise<void> {
    const id = toValue(siteId)
    if (!id) {
      index.value = null
      return
    }
    loading.value = true
    index.value = await useGscAnalyticsClient().getSitemaps(id).catch(() => null)
    loading.value = false
  }

  watch(() => toValue(siteId), refresh, { immediate: true })

  const records = computed<SitemapHistoryRecord[]>(() => {
    if (!index.value)
      return []
    const records = Object.values(index.value.records) as SitemapHistoryRecord[]
    return records.sort((a, b) => {
      const ad = a.lastDownloaded ?? ''
      const bd = b.lastDownloaded ?? ''
      return bd.localeCompare(ad)
    })
  })

  return {
    index: index as Readonly<typeof index>,
    records,
    loading: loading as Readonly<Ref<boolean>>,
    refresh,
  }
}

// Fetches the inspection timeline for a single URL (by hash) from the
// site's history shards. Oldest → newest. 404 / empty history is a normal
// state on the first dashboard visit before a second snapshot runs.

import type { InspectionHistoryRecord, InspectionHistoryResponse } from '@gscdump/contracts'
import { useGscAnalyticsClient } from './useGscAnalyticsClient'

export interface UseGscInspectionHistoryReturn {
  response: Readonly<Ref<InspectionHistoryResponse | null>>
  records: ComputedRef<InspectionHistoryRecord[]>
  url: ComputedRef<string | null>
  loading: Readonly<Ref<boolean>>
  refresh: () => Promise<void>
}

export function useGscInspectionHistory(
  siteId: MaybeRefOrGetter<string | null | undefined>,
  urlHash: MaybeRefOrGetter<string | null | undefined>,
): UseGscInspectionHistoryReturn {
  const response = ref<InspectionHistoryResponse | null>(null)
  const loading = ref(false)

  async function refresh(): Promise<void> {
    const id = toValue(siteId)
    const hash = toValue(urlHash)
    if (!id || !hash) {
      response.value = null
      return
    }
    loading.value = true
    response.value = await useGscAnalyticsClient().getInspectionHistory(id, hash).catch(() => null)
    loading.value = false
  }

  watch(() => [toValue(siteId), toValue(urlHash)], refresh, { immediate: true })

  const records = computed(() => response.value?.records ?? [])
  const url = computed(() => response.value?.url ?? null)

  return {
    response: response as Readonly<typeof response>,
    records,
    url,
    loading: loading as Readonly<Ref<boolean>>,
    refresh,
  }
}

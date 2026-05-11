// Fetches the URL-inspection entity index for a site, with PASS/NEUTRAL/FAIL
// counts derived from the records. Split from the previous `useEntity(kind)`
// discriminated API so each entity stays its own typed hook.

import type { InspectionHistoryRecord, InspectionIndex } from '@gscdump/contracts'
import { useGscAnalyticsClient } from './useGscAnalyticsClient'

export interface UseGscInspectionsReturn {
  index: Readonly<Ref<InspectionIndex | null>>
  records: ComputedRef<InspectionHistoryRecord[]>
  statusCounts: ComputedRef<{ PASS: number, NEUTRAL: number, FAIL: number, unknown: number }>
  loading: Readonly<Ref<boolean>>
  refresh: () => Promise<void>
}

export function useGscInspections(siteId: MaybeRefOrGetter<string | null | undefined>): UseGscInspectionsReturn {
  const index = ref<InspectionIndex | null>(null)
  const loading = ref(false)

  async function refresh(): Promise<void> {
    const id = toValue(siteId)
    if (!id) {
      index.value = null
      return
    }
    loading.value = true
    index.value = await useGscAnalyticsClient().getInspections(id).catch(() => null)
    loading.value = false
  }

  watch(() => toValue(siteId), refresh, { immediate: true })

  const records = computed<InspectionHistoryRecord[]>(() => {
    if (!index.value)
      return []
    return Object.values(index.value.records)
  })

  const statusCounts = computed(() => {
    const counts = { PASS: 0, NEUTRAL: 0, FAIL: 0, unknown: 0 }
    for (const r of records.value) {
      const key = r.indexStatus as keyof typeof counts | undefined
      if (key && key in counts)
        counts[key]++
      else
        counts.unknown++
    }
    return counts
  })

  return {
    index: index as Readonly<typeof index>,
    records,
    statusCounts,
    loading: loading as Readonly<Ref<boolean>>,
    refresh,
  }
}

// Fetches the URL-inspection entity index for a site, with PASS/NEUTRAL/FAIL
// counts derived from the records. Split from the previous `useEntity(kind)`
// discriminated API so each entity stays its own typed hook.

import type { InspectionHistoryRecord, InspectionIndex } from '@gscdump/contracts'
import type { ComputedRef, Ref } from '@vue/runtime-core'
import type { GscResourceStatus } from './_useGscResource'
import { gscQueries } from '../queries/gsc'
import { useGscResource } from './_useGscResource'

export interface UseGscInspectionsReturn {
  index: Readonly<Ref<InspectionIndex | null>>
  records: ComputedRef<InspectionHistoryRecord[]>
  statusCounts: ComputedRef<{ PASS: number, NEUTRAL: number, FAIL: number, unknown: number }>
  loading: ComputedRef<boolean>
  status: Readonly<Ref<GscResourceStatus>>
  error: Readonly<Ref<Error | null>>
  refresh: () => Promise<void>
}

export function useGscInspections(siteId: MaybeRefOrGetter<string | null | undefined>): UseGscInspectionsReturn {
  const { data, status, loading, error, refresh } = useGscResource<[string], InspectionIndex>({
    keys: [siteId] as const,
    operation: (id: string) => gscQueries.inspections(id),
  })

  const records = computed<InspectionHistoryRecord[]>(() =>
    data.value ? Object.values(data.value.records) : [],
  )

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
    index: data as Readonly<Ref<InspectionIndex | null>>,
    records,
    statusCounts,
    loading,
    status,
    error,
    refresh,
  }
}

// Fetches the inspection timeline for a single URL (by hash) from the
// site's history shards. Oldest → newest. 404 / empty history is a normal
// state on the first dashboard visit before a second snapshot runs.

import type { InspectionHistoryRecord, InspectionHistoryResponse } from '@gscdump/contracts'
import type { ComputedRef, Ref } from '@vue/runtime-core'
import type { GscResourceStatus } from './_useGscResource'
import { gscQueries } from '../queries/gsc'
import { useGscResource } from './_useGscResource'

export interface UseGscInspectionHistoryReturn {
  response: Readonly<Ref<InspectionHistoryResponse | null>>
  records: ComputedRef<InspectionHistoryRecord[]>
  url: ComputedRef<string | null>
  loading: ComputedRef<boolean>
  status: Readonly<Ref<GscResourceStatus>>
  error: Readonly<Ref<Error | null>>
  refresh: () => Promise<void>
}

export function useGscInspectionHistory(
  siteId: MaybeRefOrGetter<string | null | undefined>,
  urlHash: MaybeRefOrGetter<string | null | undefined>,
): UseGscInspectionHistoryReturn {
  const { data, status, loading, error, refresh } = useGscResource<[string, string], InspectionHistoryResponse>({
    keys: [siteId, urlHash] as const,
    operation: (id, hash) => gscQueries.inspectionHistory(id, hash),
  })

  const records = computed(() => data.value?.records ?? [])
  const url = computed(() => data.value?.url ?? null)

  return {
    response: data as Readonly<Ref<InspectionHistoryResponse | null>>,
    records,
    url,
    loading,
    status,
    error,
    refresh,
  }
}

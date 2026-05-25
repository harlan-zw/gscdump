// Fetches the inspection timeline for a single URL (by hash) from the
// site's history shards. Oldest → newest. 404 / empty history is a normal
// state on the first dashboard visit before a second snapshot runs.

import type { InspectionHistoryRecord, InspectionHistoryResponse } from '@gscdump/contracts'
import type { ComputedRef, Ref } from '@vue/runtime-core'
import type { GscResourceStatus } from './_useGscResource'
import { useGscResource } from './_useGscResource'
import { useGscAnalyticsClient } from './useGscAnalyticsClient'

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
  const client = useGscAnalyticsClient()
  const { data, status, loading, error, refresh } = useGscResource<[string, string], InspectionHistoryResponse>({
    namespace: 'gsc-inspection-history',
    keys: [siteId, urlHash] as const,
    fetcher: (id: string, hash: string) => client.getInspectionHistory(id, hash),
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

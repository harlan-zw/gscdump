// Fetches per-search-appearance facet performance (AMP, rich results, videos, …)
// for a site over a date window. Server dispatches tier-aware: free → GSC API
// live, pro → engine parquet. Uniform row shape regardless of backend.

import type { GscApiRange, SearchAppearanceResponse, SearchAppearanceRow } from '@gscdump/contracts'
import type { ComputedRef, Ref } from '@vue/runtime-core'
import type { GscResourceStatus } from './_useGscResource'
import { useGscResource } from './_useGscResource'
import { useGscAnalyticsClient } from './useGscAnalyticsClient'

export interface UseGscSearchAppearanceReturn {
  response: Readonly<Ref<SearchAppearanceResponse | null>>
  rows: ComputedRef<SearchAppearanceRow[]>
  range: ComputedRef<GscApiRange | null>
  source: ComputedRef<SearchAppearanceResponse['source'] | null>
  loading: ComputedRef<boolean>
  status: Ref<GscResourceStatus>
  error: Ref<Error | null>
  refresh: () => Promise<void>
}

export function useGscSearchAppearance(
  siteId: MaybeRefOrGetter<string | null | undefined>,
  range: MaybeRefOrGetter<{ start: string, end: string } | null | undefined>,
): UseGscSearchAppearanceReturn {
  const { data, status, loading, error, refresh } = useGscResource({
    keys: [
      siteId,
      () => toValue(range)?.start,
      () => toValue(range)?.end,
    ] as const,
    fetcher: (id: string, start: string, end: string) =>
      useGscAnalyticsClient().getSearchAppearance(id, { start, end }),
    isEmpty: r => r.rows.length === 0,
  })

  return {
    response: data as Readonly<Ref<SearchAppearanceResponse | null>>,
    rows: computed(() => data.value?.rows ?? []),
    range: computed(() => data.value?.range ?? null),
    source: computed(() => data.value?.source ?? null),
    loading,
    status,
    error,
    refresh,
  }
}

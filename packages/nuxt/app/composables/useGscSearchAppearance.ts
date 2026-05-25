// Fetches per-search-appearance facet performance (AMP, rich results, videos, …)
// for a site over a date window. Server dispatches tier-aware: free → GSC API
// live, pro → engine parquet. Uniform row shape regardless of backend.

import type { GscApiRange, SearchAppearanceResponse, SearchAppearanceRow } from '@gscdump/contracts'
import type { ComputedRef, Ref } from '@vue/runtime-core'
import type { GscResourceStatus } from './_useGscResource'
import { gscQueries } from '../queries/gsc'
import { useGscResource } from './_useGscResource'

export interface UseGscSearchAppearanceReturn {
  response: Readonly<Ref<SearchAppearanceResponse | null>>
  rows: ComputedRef<SearchAppearanceRow[]>
  range: ComputedRef<GscApiRange | null>
  source: ComputedRef<SearchAppearanceResponse['source'] | null>
  loading: ComputedRef<boolean>
  status: Readonly<Ref<GscResourceStatus>>
  error: Readonly<Ref<Error | null>>
  refresh: () => Promise<void>
}

export function useGscSearchAppearance(
  siteId: MaybeRefOrGetter<string | null | undefined>,
  range: MaybeRefOrGetter<{ start: string, end: string } | null | undefined>,
): UseGscSearchAppearanceReturn {
  const { data, status, loading, error, refresh } = useGscResource<[string, string, string], SearchAppearanceResponse>({
    keys: [
      siteId,
      () => toValue(range)?.start,
      () => toValue(range)?.end,
    ] as const,
    operation: (id, start, end) => gscQueries.searchAppearance(id, { start, end }),
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

// Fetches per-country search performance for a site over a date window.
// Server dispatches tier-aware: free → GSC API live, pro → engine parquet.
// The page sees a uniform row shape regardless of which backend served it.

import type { CountriesResponse, CountryRow, GscApiRange } from '@gscdump/contracts'
import type { ComputedRef, Ref } from '@vue/runtime-core'
import type { GscResourceStatus } from './_useGscResource'
import { useGscResource } from './_useGscResource'
import { useGscAnalyticsClient } from './useGscAnalyticsClient'

export interface UseGscCountriesReturn {
  response: Readonly<Ref<CountriesResponse | null>>
  rows: ComputedRef<CountryRow[]>
  range: ComputedRef<GscApiRange | null>
  source: ComputedRef<CountriesResponse['source'] | null>
  loading: ComputedRef<boolean>
  status: Ref<GscResourceStatus>
  error: Ref<Error | null>
  refresh: () => Promise<void>
}

export function useGscCountries(
  siteId: MaybeRefOrGetter<string | null | undefined>,
  range: MaybeRefOrGetter<{ start: string, end: string } | null | undefined>,
): UseGscCountriesReturn {
  const { data, status, loading, error, refresh } = useGscResource({
    keys: [
      siteId,
      () => toValue(range)?.start,
      () => toValue(range)?.end,
    ] as const,
    fetcher: (id: string, start: string, end: string) =>
      useGscAnalyticsClient().getCountries(id, { start, end }),
    isEmpty: r => r.rows.length === 0,
  })

  return {
    response: data as Readonly<Ref<CountriesResponse | null>>,
    rows: computed(() => data.value?.rows ?? []),
    range: computed(() => data.value?.range ?? null),
    source: computed(() => data.value?.source ?? null),
    loading,
    status,
    error,
    refresh,
  }
}

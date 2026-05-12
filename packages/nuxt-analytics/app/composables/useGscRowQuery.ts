// Thin client wrapper over POST /api/__gsc/sites/[siteId]/rows. Takes a
// BuilderState (or a typed query builder) and returns reactive rows with
// auto-refetch when the state / site changes.
//
// Use for row-level page needs (country breakdowns, top-N with custom
// filters, per-page drilldowns, …). For analyzer-style transforms, use
// `useGscQuery` which dispatches via /analyze.

import type { QueryRow } from '@gscdump/analysis'
import type { GscRowQueryMeta, GscRowQueryResponse } from '@gscdump/contracts'
import type { ComputedRef, Ref } from '@vue/runtime-core'
import type { BuilderState } from 'gscdump/query'
import { useGscResource } from './_useGscResource'
import { useGscAnalyticsClient } from './useGscAnalyticsClient'

export type { GscRowQueryMeta, GscRowQueryResponse } from '@gscdump/contracts'

export interface UseGscRowQueryOptions {
  site: MaybeRefOrGetter<string | null | undefined>
  state: MaybeRefOrGetter<BuilderState | null | undefined>
  /** Gate the query; when `false` stays idle (useful for lazy tabs). */
  enabled?: MaybeRefOrGetter<boolean>
}

export interface UseGscRowQueryReturn<T> {
  rows: ComputedRef<T[]>
  meta: ComputedRef<GscRowQueryMeta | null>
  loading: Ref<boolean>
  error: Ref<Error | null>
  refresh: () => Promise<void>
}

export function useGscRowQuery<T = QueryRow>(
  opts: UseGscRowQueryOptions,
): UseGscRowQueryReturn<T> {
  const resource = useGscResource<[string, BuilderState], GscRowQueryResponse<T>>({
    keys: [
      () => (opts.enabled === undefined || toValue(opts.enabled) ? toValue(opts.site) : null),
      // BuilderState is structural; stringify so keys[]-watch picks up shape changes.
      () => {
        const s = toValue(opts.state)
        return s ? JSON.stringify(s) as unknown as BuilderState : null
      },
    ],
    fetcher: site => useGscAnalyticsClient().queryRows<T>(site, toValue(opts.state) as BuilderState),
    isEmpty: r => r.rows.length === 0,
  })

  return {
    rows: computed(() => resource.data.value?.rows ?? []),
    meta: computed(() => resource.data.value?.meta ?? null),
    loading: resource.loading as unknown as Ref<boolean>,
    error: resource.error,
    refresh: resource.refresh,
  }
}

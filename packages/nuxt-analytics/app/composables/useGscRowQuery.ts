// Thin client wrapper over POST /api/__gsc/sites/[siteId]/rows. Takes a
// BuilderState (or a typed query builder) and returns reactive rows with
// auto-refetch when the state / site changes.
//
// Use for row-level page needs (country breakdowns, top-N with custom
// filters, per-page drilldowns, …). For analyzer-style transforms, use
// `useGscQuery` which dispatches via /analyze.

import type { QueryRow } from '@gscdump/analysis'
import type { BuilderState } from 'gscdump/query'
import { useGscFetch } from '../utils/gsc-fetch'

export interface GscRowQueryMeta {
  sourceName: string
  sourceKind: 'row' | 'sql'
  queryMs: number
}

export interface GscRowQueryResponse<T = QueryRow> {
  rows: T[]
  meta: GscRowQueryMeta
}

export interface UseGscRowQueryOptions {
  site: MaybeRefOrGetter<string | null | undefined>
  state: MaybeRefOrGetter<BuilderState | null | undefined>
  /** Gate the query; when `false` stays idle (useful for lazy tabs). */
  enabled?: MaybeRefOrGetter<boolean>
}

export interface UseGscRowQueryReturn<T> {
  rows: Ref<T[]>
  meta: Ref<GscRowQueryMeta | null>
  loading: Ref<boolean>
  error: Ref<Error | null>
  refresh: () => Promise<void>
}

export function useGscRowQuery<T = QueryRow>(
  opts: UseGscRowQueryOptions,
): UseGscRowQueryReturn<T> {
  const rows = ref<T[]>([]) as Ref<T[]>
  const meta = ref<GscRowQueryMeta | null>(null)
  const loading = ref(false)
  const error = ref<Error | null>(null)

  let inFlight: AbortController | null = null

  async function refresh(): Promise<void> {
    const site = toValue(opts.site)
    const state = toValue(opts.state)
    const enabled = opts.enabled ? toValue(opts.enabled) : true
    if (!site || !state || !enabled) {
      inFlight?.abort()
      inFlight = null
      rows.value = []
      meta.value = null
      return
    }

    inFlight?.abort()
    const ctrl = new AbortController()
    inFlight = ctrl
    loading.value = true
    error.value = null
    try {
      const res = await useGscFetch()<GscRowQueryResponse<T>>(
        `/api/__gsc/sites/${encodeURIComponent(site)}/rows`,
        { method: 'POST', body: state, signal: ctrl.signal },
      )
      if (ctrl.signal.aborted)
        return
      rows.value = res.rows
      meta.value = res.meta
    }
    catch (err: unknown) {
      if ((err as { name?: string } | null)?.name === 'AbortError')
        return
      error.value = err instanceof Error ? err : new Error(String(err))
    }
    finally {
      if (inFlight === ctrl)
        inFlight = null
      loading.value = false
    }
  }

  watch(
    () => [toValue(opts.site), JSON.stringify(toValue(opts.state) ?? null), opts.enabled ? toValue(opts.enabled) : true],
    refresh,
    { immediate: true },
  )

  return { rows, meta, loading, error, refresh }
}

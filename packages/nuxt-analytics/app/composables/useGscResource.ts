// Site-keyed async resource composable. Owns key-watch, stale-token discard,
// status classification, refresh, and dispose for every read-only `/api/__gsc/*`
// fetcher in the layer. Resource composables (useGscSitemaps,
// useGscIndexingDiagnostics, …) are thin adapters that wire reactive keys to
// `useGscAnalyticsClient().getX(...)` plus optional derived computeds.
//
// Stale-token (not AbortController) because `@gscdump/sdk`'s AnalyticsClient
// doesn't accept a signal. Late-arriving promises from a superseded run are
// dropped on `data`/`status` writes; the in-flight fetch still runs to
// completion, which is acceptable for read-only GETs.

import type { ComputedRef, Ref, WatchSource } from 'vue'
import type { GscErrorStatus } from '../utils/gsc-error'
import { classifyGscError } from '../utils/gsc-error'

export type GscResourceStatus = 'idle' | 'pending' | 'success' | 'empty' | GscErrorStatus

export interface UseGscResourceOptions<TArgs extends readonly unknown[], TData> {
  /** Reactive args passed to the fetcher. Resource stays idle while any required key is null/undefined. */
  keys: { [I in keyof TArgs]: MaybeRefOrGetter<TArgs[I] | null | undefined> }
  /** Async fetcher invoked with the resolved keys. */
  fetcher: (...args: TArgs) => Promise<TData | null>
  /** Predicate for the `empty` status — defaults to checking `null`/`[]`/typical container fields. */
  isEmpty?: (data: TData) => boolean
  /** Extra reactive sources that should retrigger a fetch. */
  watchSources?: WatchSource[]
}

export interface UseGscResourceReturn<TData> {
  data: Ref<TData | null>
  status: Ref<GscResourceStatus>
  loading: ComputedRef<boolean>
  error: Ref<Error | null>
  refresh: () => Promise<void>
}

function defaultIsEmpty(v: unknown): boolean {
  if (v == null)
    return true
  if (Array.isArray(v))
    return v.length === 0
  if (typeof v === 'object') {
    const rec = v as Record<string, unknown>
    for (const key of ['rows', 'records', 'snapshots', 'items', 'results']) {
      const arr = rec[key]
      if (Array.isArray(arr))
        return arr.length === 0
    }
  }
  return false
}

export function useGscResource<TArgs extends readonly unknown[], TData>(
  opts: UseGscResourceOptions<TArgs, TData>,
): UseGscResourceReturn<TData> {
  const data = shallowRef<TData | null>(null)
  const status = ref<GscResourceStatus>('idle')
  const error = ref<Error | null>(null)
  const loading = computed(() => status.value === 'pending')

  let runToken = 0

  function resolveKeys(): TArgs | null {
    const out: unknown[] = []
    for (const k of opts.keys) {
      const v = toValue(k)
      if (v == null || v === '')
        return null
      out.push(v)
    }
    return out as unknown as TArgs
  }

  async function refresh(): Promise<void> {
    const args = resolveKeys()
    const token = ++runToken
    if (!args) {
      data.value = null
      status.value = 'idle'
      error.value = null
      return
    }
    status.value = 'pending'
    error.value = null
    try {
      const out = await opts.fetcher(...args)
      if (token !== runToken)
        return
      data.value = out
      const empty = out == null || (opts.isEmpty ?? defaultIsEmpty)(out)
      status.value = empty ? 'empty' : 'success'
    }
    catch (e) {
      if (token !== runToken)
        return
      const classified = classifyGscError(e)
      error.value = e instanceof Error ? e : new Error(String(e))
      status.value = classified.status
      data.value = null
    }
  }

  watch(
    [...opts.keys.map(k => () => toValue(k)), ...(opts.watchSources ?? [])],
    refresh,
    { immediate: true },
  )

  onScopeDispose(() => {
    runToken++
  })

  return { data, status, loading, error, refresh }
}

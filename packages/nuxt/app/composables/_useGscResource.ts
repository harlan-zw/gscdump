// Site-keyed async resource composable. Owns key-watch, status classification,
// refresh, and cache policy for every read-only `/api/__gsc/*` operation in
// the layer. Resource composables stay thin adapters that wire reactive keys to
// `gscQueries.*(...)` operations plus optional derived computeds.

import type { ComputedRef, Ref, WatchSource } from '@vue/runtime-core'
import type { NuxtRpcQueryOperation } from 'nuxt-use-query/rpc'
import type { GscErrorStatus } from '../utils/gsc-error'
import { serializeNuxtRpcKey } from 'nuxt-use-query/rpc'
import { classifyGscError } from '../utils/gsc-error'
import { useGscFetch } from '../utils/gsc-fetch'

export type GscResourceStatus = 'idle' | 'pending' | 'success' | 'empty' | GscErrorStatus

export interface UseGscResourceOptions<TArgs extends readonly unknown[], TData> {
  /** Reactive args passed to the fetcher. Resource stays idle while any required key is null/undefined. */
  keys: { [I in keyof TArgs]: MaybeRefOrGetter<TArgs[I] | null | undefined> }
  /** RPC query operation invoked with the resolved keys. */
  operation?: (...args: TArgs) => NuxtRpcQueryOperation<any, any>
  /** Composite async fetcher invoked with the resolved keys. Underlying API calls should still use query operations. */
  fetcher?: (...args: TArgs) => Promise<TData | null>
  /** Predicate for the `empty` status — defaults to checking `null`/`[]`/typical container fields. */
  isEmpty?: (data: TData) => boolean
  /** Extra reactive sources that should retrigger a fetch. */
  watchSources?: WatchSource[]
  /** Optional namespace for the Nuxt query key. Defaults to `gsc-resource`. */
  namespace?: string
  /** Milliseconds before cached data is considered stale. Defaults to `nuxt-use-query`'s 60s. */
  staleTime?: number
  /** Evict cached payload after the last consumer unmounts. Defaults to `nuxt-use-query`'s 5 min. */
  gcTime?: number
}

export interface UseGscResourceReturn<TData> {
  data: Readonly<Ref<TData | null>>
  status: Readonly<Ref<GscResourceStatus>>
  loading: ComputedRef<boolean>
  error: Readonly<Ref<Error | null>>
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
  const namespace = opts.namespace ?? 'gsc-resource'
  const resolvedArgs = computed<TArgs | null>(() => {
    const out: unknown[] = []
    for (const k of opts.keys) {
      const v = toValue(k)
      if (v == null || v === '')
        return null
      out.push(v)
    }
    return out as unknown as TArgs
  })

  const queryKey = computed(() => {
    const args = resolvedArgs.value
    return args ? `${namespace}:${JSON.stringify(args)}` : `${namespace}:idle`
  })

  const enabled = computed(() => resolvedArgs.value != null)
  const operation = computed<NuxtRpcQueryOperation<any, any> | null>(() => {
    const args = resolvedArgs.value
    return args && opts.operation ? opts.operation(...args) : null
  })

  const gscFetch = useGscFetch()
  const fetchResource = (async (request: unknown, options?: unknown) => {
    if (operation.value)
      return await gscFetch(request as Parameters<typeof gscFetch>[0], options as Parameters<typeof gscFetch>[1])
    const args = resolvedArgs.value
    if (!args)
      return null
    if (opts.fetcher)
      return await opts.fetcher(...args)
    throw new Error('useGscResource: no operation or fetcher configured')
  }) as unknown as typeof $fetch

  const query = useNuxtQuery<TData | null, Error>(() => operation.value?.path ?? queryKey.value, {
    key: () => operation.value ? serializeNuxtRpcKey(operation.value.key) : queryKey.value,
    enabled,
    query: computed(() => operation.value?.query),
    transform: (payload: unknown) => operation.value ? operation.value.response.parse(payload) : payload as TData | null,
    watch: opts.watchSources,
    staleTime: opts.staleTime,
    gcTime: opts.gcTime,
    $fetch: fetchResource,
  })

  const data = computed<TData | null>(() => {
    if (!enabled.value)
      return null
    return (query.displayData.value ?? null) as TData | null
  })

  const error = computed<Error | null>(() => {
    if (!enabled.value)
      return null
    const e = query.error.value
    return e == null ? null : e instanceof Error ? e : new Error(String(e))
  })

  const status = computed<GscResourceStatus>(() => {
    if (!enabled.value)
      return 'idle'
    if (query.status.value === 'pending')
      return 'pending'
    if (query.status.value === 'error') {
      const classified = classifyGscError(error.value)
      return classified.status
    }
    const out = data.value
    if (query.status.value === 'success')
      return out == null || (opts.isEmpty ?? defaultIsEmpty)(out) ? 'empty' : 'success'
    return 'idle'
  })

  const loading = computed(() => status.value === 'pending')

  async function refresh(): Promise<void> {
    if (!enabled.value)
      return
    await query.refresh()
  }

  return { data, status, loading, error, refresh }
}

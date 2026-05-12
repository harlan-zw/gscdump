// Per-site shared resource bag. Consolidates the bind/unbind/refcount pattern
// that useGscAnalyzer and useGscAnalyticsSourceInfo each reinvented.
//
// Two modes via `onDispose`:
//   - omitted     → entry persists forever (cheap, share-only; e.g. /source-info)
//   - provided    → refcounted; runs onDispose + drops the entry at refs=0
//
// Returns a `bound` computed that tracks the entry for the current siteId. The
// caller wraps it in `computed(() => bound.value?.field ?? default)` to expose
// reactive fields — same shape as the two prior hand-rolled adapters.

import type { ComputedRef } from '@vue/runtime-core'
import { useGscAnalyticsContext } from './useGscAnalytics'

interface CacheEntry<T> {
  entry: T
  refs: number
}

export interface UseSharedSiteResourceOptions<T> {
  /** Build the entry on first acquire for a site. */
  factory: (siteId: string) => T
  /** When set, refcount the entry and run on the last release (deletes from cache). */
  onDispose?: (entry: T) => Promise<void> | void
}

export interface UseSharedSiteResourceReturn<T> {
  bound: ComputedRef<T | null>
  currentSiteId: Ref<string | null>
}

interface SharedResources {
  get: (namespace: string) => Map<string, CacheEntry<unknown>>
}

function getResourcesBag(ctx: ReturnType<typeof useGscAnalyticsContext>): SharedResources {
  // `_sharedResources` is declared on GscAnalyticsContext; cast preserves the
  // generic per-namespace value type at the call site.
  const bag = ctx._sharedResources as Map<string, Map<string, CacheEntry<unknown>>>
  return {
    get(namespace) {
      let m = bag.get(namespace)
      if (!m) {
        m = new Map()
        bag.set(namespace, m)
      }
      return m
    },
  }
}

export function useGscSharedSiteResource<T>(
  namespace: string,
  siteId: MaybeRefOrGetter<string | null | undefined>,
  opts: UseSharedSiteResourceOptions<T>,
): UseSharedSiteResourceReturn<T> {
  const ctx = useGscAnalyticsContext()
  const resources = getResourcesBag(ctx)
  const cache = resources.get(namespace) as Map<string, CacheEntry<T>>

  const boundRef = shallowRef<T | null>(null)
  const currentSiteId = ref<string | null>(null)

  function bind(id: string): void {
    unbind()
    let inst = cache.get(id)
    if (!inst) {
      inst = { entry: opts.factory(id), refs: 0 }
      cache.set(id, inst)
    }
    inst.refs++
    boundRef.value = inst.entry
    currentSiteId.value = id
  }

  function unbind(): void {
    const id = currentSiteId.value
    if (!id) {
      boundRef.value = null
      return
    }
    const inst = cache.get(id)
    boundRef.value = null
    currentSiteId.value = null
    if (!inst)
      return
    inst.refs--
    if (inst.refs <= 0 && opts.onDispose) {
      cache.delete(id)
      void Promise.resolve(opts.onDispose(inst.entry)).catch(() => {})
    }
  }

  watch(
    () => toValue(siteId),
    (id: string | null | undefined) => {
      if (!id) {
        unbind()
        return
      }
      if (import.meta.client)
        bind(id)
    },
    { immediate: true },
  )

  onScopeDispose(unbind)

  return {
    bound: computed(() => boundRef.value) as ComputedRef<T | null>,
    currentSiteId,
  }
}

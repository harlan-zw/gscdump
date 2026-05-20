// Per-site shared resource bag. Consolidates the bind/unbind/refcount pattern
// that useGscAnalyzer and useGscAnalyticsSourceInfo each reinvented.
//
// Two entry points share one underlying bag (a module-scope WeakMap keyed by
// the NuxtApp instance, so each app gets isolated state and SSR is safe):
//   - useGscSharedSiteResource → composable, refcounted, scope-disposed.
//   - acquireSharedEntry       → non-composable acquire for boot-time / non-
//                                setup callers (e.g. analyzer createInstance).
//
// Refcounting via `onDispose` is opt-in:
//   - omitted     → entry persists forever (cheap, share-only; e.g. /source-info)
//   - provided    → refcounted; runs onDispose + drops the entry at refs=0
//
// Returns a `bound` computed that tracks the entry for the current siteId. The
// caller wraps it in `computed(() => bound.value?.field ?? default)` to expose
// reactive fields.

import type { ComputedRef } from '@vue/runtime-core'
import type { NuxtApp } from 'nuxt/app'

interface CacheEntry<T> {
  entry: T
  refs: number
}

type NamespaceBag = Map<string, Map<string, CacheEntry<unknown>>>

const bags = new WeakMap<NuxtApp, NamespaceBag>()

function namespaceMap(namespace: string): Map<string, CacheEntry<unknown>> {
  const app = useNuxtApp()
  let bag = bags.get(app)
  if (!bag) {
    bag = new Map()
    bags.set(app, bag)
  }
  let m = bag.get(namespace)
  if (!m) {
    m = new Map()
    bag.set(namespace, m)
  }
  return m
}

/**
 * Non-composable acquire — returns (and lazily creates) the shared entry for
 * `(namespace, siteId)`. No refcount, no scope dispose. Intended for callers
 * outside a Vue setup scope (analyzer boot IIFE, one-shot loaders) that still
 * need to share state with the reactive `useGscSharedSiteResource` consumers.
 */
export function acquireSharedEntry<T>(
  namespace: string,
  siteId: string,
  factory: (siteId: string) => T,
): T {
  const cache = namespaceMap(namespace) as Map<string, CacheEntry<T>>
  let inst = cache.get(siteId)
  if (!inst) {
    inst = { entry: factory(siteId), refs: 0 }
    cache.set(siteId, inst)
  }
  return inst.entry
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

export function useGscSharedSiteResource<T>(
  namespace: string,
  siteId: MaybeRefOrGetter<string | null | undefined>,
  opts: UseSharedSiteResourceOptions<T>,
): UseSharedSiteResourceReturn<T> {
  const cache = namespaceMap(namespace) as Map<string, CacheEntry<T>>

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

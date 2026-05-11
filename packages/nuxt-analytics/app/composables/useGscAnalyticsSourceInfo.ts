// Per-site reactive probe of what the server-resolved AnalysisQuerySource
// can do. The layer exposes source shape (kind + analyzer set); tier logic
// lives in the host.
//
// Use this to render locked/ghost UI upfront without issuing a doomed
// analyze() call for each panel.

import type { SourceCapabilities } from '@gscdump/analysis'
import { _useGscAnalyticsContext } from './useGscAnalytics'
import { useGscAnalyticsClient } from './useGscAnalyticsClient'

export interface GscAnalyticsSourceInfo {
  /** Source implementation name — e.g. "gsc-api", "engine", "browser". */
  name: string
  /** `row` = GSC API / in-memory; `sql` = DuckDB/SQLite-backed. */
  kind: 'row' | 'sql'
  capabilities: SourceCapabilities
  /** Analyzer ids runnable against this source, from the default registry. */
  supportedAnalyzerIds: string[]
  /** Host declared attach hint — client should boot DuckDB-WASM and attach parquets. */
  browserAttachEligible: boolean
  /**
   * Host-controlled identity attrs echoed back for debug/display (e.g.
   * `{ tier: 'free' | 'pro' }`). Layer treats as opaque — never use these
   * for gating on the client, the source provider is the gate.
   */
  identityAttrs?: Record<string, unknown> | null
}

interface GscAnalyticsSourceInfoState {
  info: Ref<GscAnalyticsSourceInfo | null>
  loading: Ref<boolean>
  error: Ref<Error | null>
  refresh: () => Promise<void>
  /** Convenience predicate for panel gating: true when the analyzer id is in `supportedAnalyzerIds`. */
  supports: (analyzerId: MaybeRefOrGetter<string>) => ComputedRef<boolean>
}

interface CachedEntry {
  info: Ref<GscAnalyticsSourceInfo | null>
  loading: Ref<boolean>
  error: Ref<Error | null>
  pending: Promise<void> | null
}

const CACHE_KEY = Symbol('gsc-analytics-source-info')

function getCache(ctx: ReturnType<typeof _useGscAnalyticsContext>): Map<string, CachedEntry> {
  const bag = ctx as unknown as Record<PropertyKey, unknown>
  let cache = bag[CACHE_KEY] as Map<string, CachedEntry> | undefined
  if (!cache) {
    cache = new Map()
    bag[CACHE_KEY] = cache
  }
  return cache
}

export function useGscAnalyticsSourceInfo(
  siteId: MaybeRefOrGetter<string | null | undefined>,
): GscAnalyticsSourceInfoState {
  const ctx = _useGscAnalyticsContext()
  const cache = getCache(ctx)

  const info = ref<GscAnalyticsSourceInfo | null>(null)
  const loading = ref(false)
  const error = ref<Error | null>(null)

  let stop: (() => void) | null = null

  function bind(id: string): void {
    stop?.()
    let entry = cache.get(id)
    if (!entry) {
      entry = {
        info: ref(null),
        loading: ref(false),
        error: ref(null),
        pending: null,
      }
      cache.set(id, entry)
    }
    const bound = entry
    const stops = [
      watch(bound.info, v => (info.value = v), { immediate: true }),
      watch(bound.loading, v => (loading.value = v), { immediate: true }),
      watch(bound.error, v => (error.value = v), { immediate: true }),
    ]
    stop = () => stops.forEach(fn => fn())

    if (!bound.info.value && !bound.pending && import.meta.client)
      void fetchInto(id, bound)
  }

  async function fetchInto(id: string, entry: CachedEntry): Promise<void> {
    entry.loading.value = true
    entry.error.value = null
    entry.pending = (useGscAnalyticsClient().getSourceInfo(id) as Promise<GscAnalyticsSourceInfo>)
      .then((data) => {
        entry.info.value = data
      })
      .catch((err: unknown) => {
        entry.error.value = err instanceof Error ? err : new Error(String(err))
      })
      .finally(() => {
        entry.loading.value = false
        entry.pending = null
      })
    await entry.pending
  }

  watch(
    () => toValue(siteId),
    (id) => {
      if (!id) {
        stop?.()
        stop = null
        info.value = null
        loading.value = false
        error.value = null
        return
      }
      bind(id)
    },
    { immediate: true },
  )

  onScopeDispose(() => stop?.())

  async function refresh(): Promise<void> {
    const id = toValue(siteId)
    if (!id)
      return
    const entry = cache.get(id)
    if (!entry)
      return
    await fetchInto(id, entry)
  }

  function supports(analyzerId: MaybeRefOrGetter<string>): ComputedRef<boolean> {
    return computed(() => {
      const list = info.value?.supportedAnalyzerIds
      if (!list)
        return false
      return list.includes(toValue(analyzerId))
    })
  }

  return { info, loading, error, refresh, supports }
}

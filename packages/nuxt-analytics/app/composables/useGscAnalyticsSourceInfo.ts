// Per-site reactive probe of what the server-resolved AnalysisQuerySource
// can do. The layer exposes source shape (kind + analyzer set); tier logic
// lives in the host.
//
// Use this to render locked/ghost UI upfront without issuing a doomed
// analyze() call for each panel.

import type { SourceCapabilities } from '@gscdump/analysis'
import { useGscSharedSiteResource } from './_useGscSharedSiteResource'
import { useGscAnalyticsContext } from './useGscAnalytics'
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

interface SourceInfoEntry {
  info: Ref<GscAnalyticsSourceInfo | null>
  loading: Ref<boolean>
  error: Ref<Error | null>
  pending: Ref<Promise<void> | null>
  siteId: string
}

function createEntry(siteId: string): SourceInfoEntry {
  return {
    info: ref<GscAnalyticsSourceInfo | null>(null),
    loading: ref(false),
    error: ref<Error | null>(null),
    pending: shallowRef<Promise<void> | null>(null),
    siteId,
  }
}

async function fetchInto(entry: SourceInfoEntry): Promise<void> {
  entry.loading.value = true
  entry.error.value = null
  const p = (useGscAnalyticsClient().getSourceInfo(entry.siteId) as Promise<GscAnalyticsSourceInfo>)
    .then((data) => {
      entry.info.value = data
    })
    .catch((err: unknown) => {
      entry.error.value = err instanceof Error ? err : new Error(String(err))
    })
    .finally(() => {
      entry.loading.value = false
      entry.pending.value = null
    })
  entry.pending.value = p
  await p
}

const SOURCE_INFO_NAMESPACE = 'source-info'

function acquireSourceInfoEntry(siteId: string): SourceInfoEntry {
  const ctx = useGscAnalyticsContext()
  const bag = ctx._sharedResources as Map<string, Map<string, { entry: SourceInfoEntry, refs: number }>>
  let cache = bag.get(SOURCE_INFO_NAMESPACE)
  if (!cache) {
    cache = new Map()
    bag.set(SOURCE_INFO_NAMESPACE, cache)
  }
  let cached = cache.get(siteId)
  if (!cached) {
    cached = { entry: createEntry(siteId), refs: 0 }
    cache.set(siteId, cached)
  }
  return cached.entry
}

/**
 * Non-reactive source-info loader for callers outside a Vue scope (e.g. the
 * analyzer's boot IIFE in `useGscAnalyzer.createInstance`). Shares the same
 * per-site cache `useGscAnalyticsSourceInfo` consumes, so the gating UI and
 * the analyzer mode probe collapse to one network read per site per session.
 *
 * If a fetch is already in flight (kicked off by `useGscAnalyticsSourceInfo`'s
 * reactive watcher), this awaits it instead of issuing a duplicate request.
 */
export async function loadSourceInfoFor(siteId: string): Promise<GscAnalyticsSourceInfo> {
  const entry = acquireSourceInfoEntry(siteId)
  if (entry.info.value)
    return entry.info.value
  if (entry.pending.value) {
    await entry.pending.value
  }
  else {
    await fetchInto(entry)
  }
  if (entry.error.value)
    throw entry.error.value
  if (!entry.info.value)
    throw new Error(`loadSourceInfoFor(${siteId}): no info after fetch`)
  return entry.info.value
}

export function useGscAnalyticsSourceInfo(
  siteId: MaybeRefOrGetter<string | null | undefined>,
): GscAnalyticsSourceInfoState {
  const { bound } = useGscSharedSiteResource<SourceInfoEntry>('source-info', siteId, {
    factory: id => createEntry(id),
    // No onDispose: source-info is cheap and persistent across the session.
  })

  if (import.meta.client) {
    watch(bound, (entry: SourceInfoEntry | null) => {
      if (entry && entry.info.value == null && entry.pending.value == null && entry.error.value == null)
        void fetchInto(entry)
    }, { immediate: true })
  }

  const info = computed(() => bound.value?.info.value ?? null) as unknown as Ref<GscAnalyticsSourceInfo | null>
  const loading = computed(() => bound.value?.loading.value ?? false) as unknown as Ref<boolean>
  const error = computed(() => bound.value?.error.value ?? null) as unknown as Ref<Error | null>

  async function refresh(): Promise<void> {
    const entry = bound.value
    if (!entry)
      return
    await fetchInto(entry)
  }

  function supports(analyzerId: MaybeRefOrGetter<string>): ComputedRef<boolean> {
    return computed(() => {
      const list = bound.value?.info.value?.supportedAnalyzerIds
      if (!list)
        return false
      return list.includes(toValue(analyzerId))
    })
  }

  return { info, loading, error, refresh, supports }
}

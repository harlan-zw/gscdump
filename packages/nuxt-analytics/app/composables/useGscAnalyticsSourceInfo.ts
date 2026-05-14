// Per-site reactive probe of what the server-resolved AnalysisQuerySource
// can do. The layer exposes source shape (kind + analyzer set); tier logic
// lives in the host.
//
// Use this to render locked/ghost UI upfront without issuing a doomed
// analyze() call for each panel.
//
// The reactive composable and the non-reactive `loadSourceInfoFor` (used by
// `useGscAnalyzer.createInstance`) share one entry per site via the shared
// site-resource seam, so they collapse to one network read per session.

import type { SourceCapabilities } from '@gscdump/analysis'
import { acquireSharedEntry, useGscSharedSiteResource } from './_useGscSharedSiteResource'
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
}

const SOURCE_INFO_NAMESPACE = 'source-info'

function createEntry(): SourceInfoEntry {
  return {
    info: ref<GscAnalyticsSourceInfo | null>(null),
    loading: ref(false),
    error: ref<Error | null>(null),
    pending: shallowRef<Promise<void> | null>(null),
  }
}

function fetchInto(entry: SourceInfoEntry, siteId: string): Promise<void> {
  if (entry.pending.value)
    return entry.pending.value
  entry.loading.value = true
  entry.error.value = null
  const p = (useGscAnalyticsClient().getSourceInfo(siteId) as Promise<GscAnalyticsSourceInfo>)
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
  return p
}

/**
 * Non-reactive source-info loader for callers outside a Vue scope (e.g. the
 * analyzer's boot IIFE in `useGscAnalyzer.createInstance`). Shares the same
 * per-site cache `useGscAnalyticsSourceInfo` consumes via the shared
 * site-resource seam, so gating UI and the analyzer mode probe collapse to
 * one network read per site per session.
 */
export async function loadSourceInfoFor(siteId: string): Promise<GscAnalyticsSourceInfo> {
  const entry = acquireSharedEntry(SOURCE_INFO_NAMESPACE, siteId, createEntry)
  if (entry.info.value)
    return entry.info.value
  await fetchInto(entry, siteId)
  if (entry.error.value)
    throw entry.error.value
  if (!entry.info.value)
    throw new Error(`loadSourceInfoFor(${siteId}): no info after fetch`)
  return entry.info.value
}

export function useGscAnalyticsSourceInfo(
  siteId: MaybeRefOrGetter<string | null | undefined>,
): GscAnalyticsSourceInfoState {
  const { bound } = useGscSharedSiteResource<SourceInfoEntry>(SOURCE_INFO_NAMESPACE, siteId, {
    factory: () => createEntry(),
    // No onDispose: source-info is cheap and persistent across the session.
  })

  if (import.meta.client) {
    watch(bound, (entry: SourceInfoEntry | null) => {
      if (!entry)
        return
      const id = toValue(siteId)
      if (!id)
        return
      if (entry.info.value == null && entry.pending.value == null && entry.error.value == null)
        void fetchInto(entry, id)
    }, { immediate: true })
  }

  const info = computed(() => bound.value?.info.value ?? null) as unknown as Ref<GscAnalyticsSourceInfo | null>
  const loading = computed(() => bound.value?.loading.value ?? false) as unknown as Ref<boolean>
  const error = computed(() => bound.value?.error.value ?? null) as unknown as Ref<Error | null>

  async function refresh(): Promise<void> {
    const entry = bound.value
    const id = toValue(siteId)
    if (!entry || !id)
      return
    entry.info.value = null
    await fetchInto(entry, id)
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

// Multi-site fanout over `useGscSiteAnalyzer`.
//
// Pattern: a dashboard page wants the same DuckDB-WASM query (or analyzer
// preset) run against N sites in parallel. Each site is its own
// `useGscSiteAnalyzer` instance — the underlying singleton cache means the
// shared boot, OPFS handles, and per-table attach are reused across the
// fanout for free.
//
// This composable owns the per-site bookkeeping and the aggregated state:
//
//   - `analyzers` is a `Record<siteId, UseGscSiteAnalyzerReturn>` so callers
//     can run their own `query`/`analyze`/`runQuery` per site.
//   - `loading` flips to `false` once every site is `ready` OR `error`.
//   - `progress.completed` increments as sites individually finish.
//   - `error` surfaces the first site error encountered without stopping the
//     other sites.
//
// Adding/removing sites between renders is a cheap diff: existing per-site
// scopes stay live, only new ids get new scopes, removed ids get disposed.
// Changing `range` is wholesale — every per-site analyzer rebinds to the
// new (siteId, range) cache key.

import type { MaybeRefOrGetter, Ref } from 'vue'
import type { UseGscSiteAnalyzerReturn } from './useGscSiteAnalyzer'
import { computed, effectScope, onScopeDispose, ref, toValue, watch, watchEffect } from 'vue'
import { useGscSiteAnalyzer } from './useGscSiteAnalyzer'

type SearchType = 'web' | 'image' | 'video' | 'news' | 'discover' | 'googleNews'

interface SiteIdLike { id: string }

export interface UseGscSiteAnalyzerFanoutReturn {
  /** Per-site analyzer handles, keyed by site id. Each is the same shape as `useGscSiteAnalyzer` returns. */
  analyzers: Readonly<Ref<Record<string, UseGscSiteAnalyzerReturn>>>
  /** True while at least one per-site analyzer is still working (neither ready nor errored). */
  loading: Readonly<Ref<boolean>>
  /** Coarse counter — `completed` is the number of sites that finished (ready or error). */
  progress: Readonly<Ref<{ completed: number, total: number }>>
  /** First per-site error encountered. Other sites continue regardless. */
  error: Readonly<Ref<Error | null>>
}

export interface UseGscSiteAnalyzerFanoutOptions {
  searchType?: SearchType
  useOpfsCache?: boolean
}

export function useGscSiteAnalyzerFanout(
  sites: MaybeRefOrGetter<readonly SiteIdLike[] | null | undefined>,
  range: MaybeRefOrGetter<{ start: string, end: string } | null | undefined>,
  options: UseGscSiteAnalyzerFanoutOptions = {},
): UseGscSiteAnalyzerFanoutReturn {
  // Per-site state: the analyzer return + the scope owning it. Scopes are
  // disposed individually when a site leaves the input set.
  interface Entry {
    analyzer: UseGscSiteAnalyzerReturn
    scope: ReturnType<typeof effectScope>
  }
  const entries = ref<Record<string, Entry>>({})
  const error = ref<Error | null>(null)

  function disposeEntry(id: string): void {
    const e = entries.value[id]
    if (!e)
      return
    e.scope.stop()
    const { [id]: _, ...rest } = entries.value
    void _
    entries.value = rest
  }

  function ensureEntry(id: string): void {
    if (entries.value[id])
      return
    const scope = effectScope()
    let analyzer!: UseGscSiteAnalyzerReturn
    scope.run(() => {
      analyzer = useGscSiteAnalyzer(
        () => id,
        () => toValue(range) ?? null,
        {
          searchType: options.searchType,
          useOpfsCache: options.useOpfsCache,
        },
      )
      // Surface the first site error globally without short-circuiting.
      watchEffect(() => {
        if (analyzer.error.value && !error.value)
          error.value = analyzer.error.value
      })
    })
    entries.value = { ...entries.value, [id]: { analyzer, scope } }
  }

  // Diff the input list against current entries on every change.
  watch(
    () => (toValue(sites) ?? []).map(s => s.id).filter(Boolean),
    (ids) => {
      // Reset surfaced error when the set of sites changes so a stale message
      // doesn't shadow the new run.
      error.value = null
      const wanted = new Set(ids)
      for (const id of Object.keys(entries.value)) {
        if (!wanted.has(id))
          disposeEntry(id)
      }
      for (const id of ids)
        ensureEntry(id)
    },
    { immediate: true },
  )

  onScopeDispose(() => {
    for (const id of Object.keys(entries.value))
      disposeEntry(id)
  })

  const analyzers = computed(() => {
    const out: Record<string, UseGscSiteAnalyzerReturn> = {}
    for (const [id, e] of Object.entries(entries.value))
      out[id] = e.analyzer
    return out
  })

  // A site is "done" once it reports `ready` OR `error`. Loading is true
  // while any site is still resolving/attaching. Empty input → not loading.
  const progress = computed(() => {
    const list = Object.values(entries.value)
    const total = list.length
    let completed = 0
    for (const e of list) {
      if (e.analyzer.ready.value || e.analyzer.error.value)
        completed++
    }
    return { completed, total }
  })
  const loading = computed(() => {
    const p = progress.value
    return p.total > 0 && p.completed < p.total
  })

  return {
    analyzers: analyzers as Readonly<Ref<Record<string, UseGscSiteAnalyzerReturn>>>,
    loading: loading as Readonly<Ref<boolean>>,
    progress: progress as Readonly<Ref<{ completed: number, total: number }>>,
    error: error as Readonly<Ref<Error | null>>,
  }
}

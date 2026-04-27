// Analytics context: sites list + shared boot-progress map + per-site analyzer
// cache. One `provideGscAnalytics()` at the app/layout root. Pages reach in via
// narrower hooks (`useGscSites`, `useGscSite`, `useGscAnalyzer`,
// `useGscBootProgress`) — no global mutable `currentSite`, no leaked progress
// writers.

import type { InjectionKey } from 'vue'
import type { SiteListItem } from '../../types'
import { useGscFetch } from '../utils/gsc-fetch'

export type { SiteListItem }

export type ReadBackend = 'd1' | 'r2'

export interface SiteRecord extends SiteListItem {
  /** Canonical GSC site URL. Alias of `label` for back-compat. */
  siteUrl: string
  /**
   * Which backend serves analysis for this site. Carried through from the
   * sites endpoint; when omitted the value defaults to `'r2'` so legacy
   * consumers keep working. Browser-attach eligibility is ultimately
   * decided by the server's source provider via `browserAttachEligible`
   * on `/api/__gsc/sites/:siteId/source-info`, not by this field.
   */
  readBackend: ReadBackend
  syncStatus?: string | null
}

export type SiteLoadStage = 'idle' | 'wasm' | 'manifest' | 'attach' | 'ready' | 'error'

export interface SiteLoadProgress {
  siteId: string
  stage: SiteLoadStage
  /** Sub-units (parquet files, rollup JSONs) completed. */
  filesAttached: number
  /** Sub-units expected; 0 while unknown. */
  filesTotal: number
  startedAt: number
  endedAt?: number
  error?: string
  source?: 'duckdb' | 'rollup' | string
}

export interface GscAnalyticsContext {
  sites: Ref<SiteListItem[] | null>
  sitesLoading: Readonly<Ref<boolean>>
  sitesError: Readonly<Ref<Error | null>>
  refreshSites: () => Promise<void>
  progress: Readonly<Ref<Record<string, SiteLoadProgress>>>
  /** Escape hatch for demos/tests — write raw progress entries. */
  patchProgress: (siteId: string, patch: Partial<SiteLoadProgress>) => void
  /** Escape hatch for demos/tests — clear progress map (all or one site). */
  clearProgress: (siteId?: string) => void
  // @internal per-site analyzer instance cache; used by useGscAnalyzer.
  _analyzers: Map<string, unknown>
}

export const GSC_ANALYTICS_KEY = Symbol('gsc-analytics') as InjectionKey<GscAnalyticsContext>

// Factory exposed so the layer's Nuxt plugin can provide a single app-wide
// context via `nuxtApp.vueApp.provide(GSC_ANALYTICS_KEY, createGscAnalyticsContext())`.
// Prefer the plugin-driven path over calling provide() from a layout.
export function createGscAnalyticsContext(): GscAnalyticsContext {
  return createContext()
}

/**
 * Legacy scoped provide. Called inside a component setup, establishes the
 * context for that subtree. New apps should rely on the layer's plugin,
 * which provides at the Nuxt app root — this remains for consumers that
 * want to override per-layout.
 */
export function provideGscAnalytics(): GscAnalyticsContext {
  const existing = inject(GSC_ANALYTICS_KEY, null)
  if (existing)
    return existing
  const ctx = createContext()
  provide(GSC_ANALYTICS_KEY, ctx)
  return ctx
}

// Internal: resolve the shared context. Throws if no provider is upstream —
// should never happen once the layer's plugin runs, since that provides at
// `nuxtApp.vueApp` which is upstream of every component.
export function _useGscAnalyticsContext(): GscAnalyticsContext {
  const ctx = inject(GSC_ANALYTICS_KEY, null)
  if (!ctx)
    throw new Error('[nuxt-analytics] provideGscAnalytics() must be called upstream (layout or app root).')
  return ctx
}

/** Read-only sites list + refresh. */
export function useGscSites(): {
  sites: Ref<SiteListItem[] | null>
  loading: Readonly<Ref<boolean>>
  error: Readonly<Ref<Error | null>>
  refresh: () => Promise<void>
} {
  const { sites, sitesLoading, sitesError, refreshSites } = _useGscAnalyticsContext()
  return { sites, loading: sitesLoading, error: sitesError, refresh: refreshSites }
}

/** Derived site record for a given id. Non-mutating; returns `null` until the list resolves. */
export function useGscSite(siteId: MaybeRefOrGetter<string | null | undefined>): Ref<SiteRecord | null> {
  const { sites } = _useGscAnalyticsContext()
  return computed(() => {
    const id = toValue(siteId)
    if (!id)
      return null
    const found = sites.value?.find((s: SiteListItem) => s.id === id)
    if (found)
      return toSiteRecord(found)
    // List not yet loaded — stamp a minimal record so downstream queries can
    // dispatch against the id. Gets upgraded when sites resolves.
    return {
      id,
      label: id,
      hostname: id,
      propertyType: 'url-prefix',
      siteUrl: id,
      readBackend: 'r2',
    }
  })
}

function toSiteRecord(s: SiteListItem): SiteRecord {
  return {
    ...s,
    siteUrl: s.label,
    readBackend: s.readBackend ?? 'r2',
  }
}

/** Read-only boot-progress map for UI indicators. */
export function useGscBootProgress(): {
  progress: Readonly<Ref<Record<string, SiteLoadProgress>>>
  entries: ComputedRef<SiteLoadProgress[]>
  allReady: ComputedRef<boolean>
  anyActive: ComputedRef<boolean>
} {
  const { progress } = _useGscAnalyticsContext()
  const entries = computed<SiteLoadProgress[]>(() => {
    const all = Object.values(progress.value) as SiteLoadProgress[]
    return all.sort((a, b) => a.startedAt - b.startedAt)
  })
  const allReady = computed(() =>
    entries.value.length > 0 && entries.value.every((s: SiteLoadProgress) => s.stage === 'ready'),
  )
  const anyActive = computed(() =>
    entries.value.some((s: SiteLoadProgress) => s.stage !== 'ready' && s.stage !== 'idle' && s.stage !== 'error'),
  )
  return { progress, entries, allReady, anyActive }
}

function createContext(): GscAnalyticsContext {
  const sites = ref<SiteListItem[] | null>(null)
  const sitesLoading = ref(false)
  const sitesError = ref<Error | null>(null)
  const progress = ref<Record<string, SiteLoadProgress>>({})

  async function refreshSites(): Promise<void> {
    sitesLoading.value = true
    sitesError.value = null
    sites.value = await useGscFetch()<SiteListItem[]>('/api/__gsc/sites').catch((err) => {
      sitesError.value = err instanceof Error ? err : new Error(String(err))
      return null
    })
    sitesLoading.value = false
  }

  function patchProgress(siteId: string, patch: Partial<SiteLoadProgress>): void {
    const prev = progress.value[siteId]
    progress.value = {
      ...progress.value,
      [siteId]: {
        siteId,
        stage: 'idle',
        filesAttached: 0,
        filesTotal: 0,
        startedAt: prev?.startedAt ?? Date.now(),
        ...prev,
        ...patch,
      },
    }
  }

  function clearProgress(siteId?: string): void {
    if (!siteId) {
      progress.value = {}
      return
    }
    const next = { ...progress.value }
    delete next[siteId]
    progress.value = next
  }

  // Lazy-load: defer refreshSites until something actually reads `sites`.
  // Eager kick-off used to race host plugins that set auth headers
  // (`setGscFetchHeaders`) — first call would 401 and the rest of the
  // session would silently degrade. Triggering on first read defers the
  // request to a microtask after plugin setup, so headers are in place.
  let kickedOff = false
  function maybeKickOff(): void {
    if (kickedOff || !import.meta.client)
      return
    kickedOff = true
    refreshSites()
  }
  const lazySites = computed<SiteListItem[] | null>(() => {
    maybeKickOff()
    return sites.value
  })

  return {
    sites: lazySites as Readonly<Ref<SiteListItem[] | null>> as unknown as Ref<SiteListItem[] | null>,
    sitesLoading: sitesLoading as Readonly<Ref<boolean>>,
    sitesError: sitesError as Readonly<Ref<Error | null>>,
    refreshSites,
    progress: progress as Readonly<Ref<Record<string, SiteLoadProgress>>>,
    patchProgress,
    clearProgress,
    _analyzers: new Map(),
  }
}

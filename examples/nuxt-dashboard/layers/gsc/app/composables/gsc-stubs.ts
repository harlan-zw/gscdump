// Auto-imported composable stubs for `examples/nuxt-dashboard`. Each function
// returns the shape templates consume; behaviour is intentionally inert so the
// example builds without bringing in the full nuxtseo.com layer.
// TODO: port from nuxtseo.com

import type {
  GscAnalyzerCapability,
  GscAnalyzerDefinition,
  GscAnalyzerDefinitionWithCapability,
} from '../../types'
import { defineGscAnalyzer } from '../../types'

export { defineGscAnalyzer }
export type {
  GscAnalyzerAccent,
  GscAnalyzerCapability,
  GscAnalyzerDefinition,
  GscAnalyzerInsightCard,
  GscAnalyzerKind,
  GscAnalyzerPanelResult,
  GscAnalyzerPanelSpec,
  GscAnalyzerStatTile,
} from '../../types'

// --- Period ---------------------------------------------------------------

export interface GscDateRange {
  start: string
  end: string
  prevStart: string
  prevEnd: string
  yearStart: string
  yearEnd: string
}

export type GscCompareMode = 'none' | 'previous' | 'year'

function todayIso(): string {
  return new Date().toISOString().slice(0, 10)
}

function isoMinusDays(days: number): string {
  return new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10)
}

export function useGscPeriod() {
  const period = ref('28d')
  const compareMode = ref<GscCompareMode>('previous')
  const stableData = ref(true)
  const end = todayIso()
  const start = isoMinusDays(28)
  const range = ref<GscDateRange>({
    start,
    end,
    prevStart: isoMinusDays(56),
    prevEnd: isoMinusDays(29),
    yearStart: isoMinusDays(365 + 28),
    yearEnd: isoMinusDays(365),
  })
  const presets = ref<Array<{ id: string, label: string }>>([
    { id: '7d', label: 'Last 7 days' },
    { id: '28d', label: 'Last 28 days' },
    { id: '90d', label: 'Last 90 days' },
  ])
  const compareOptions = ref<Array<{ id: GscCompareMode, label: string }>>([
    { id: 'none', label: 'No comparison' },
    { id: 'previous', label: 'Previous period' },
    { id: 'year', label: 'Year over year' },
  ])
  return { period, compareMode, stableData, range, presets, compareOptions }
}

// --- Current site ---------------------------------------------------------

export interface GscCurrentSite {
  id: string
  hostname: string
  propertyType: 'domain' | 'url-prefix'
  url?: string
}

export function useGscCurrentSite() {
  const route = useRoute()
  const siteId = computed(() => String(route.params.id ?? ''))
  const site = ref<GscCurrentSite | null>(null)
  return { siteId, site }
}

// --- Sites list -----------------------------------------------------------

export function useGscSites() {
  const sites = ref<GscCurrentSite[]>([])
  const loading = ref(false)
  const error = ref<Error | null>(null)
  return { sites, loading, error }
}

// --- Analytics config/context --------------------------------------------

export function useGscAnalyticsConfig() {
  const cfg = useRuntimeConfig().public.analytics
  return {
    apiBase: cfg?.apiBase ?? '',
    duckdbBundleBase: cfg?.duckdbBundleBase ?? '',
    timezone: cfg?.timezone ?? '',
    toastErrors: cfg?.toastErrors ?? false,
    defaultEngine: cfg?.defaultEngine ?? 'auto',
    mode: cfg?.mode ?? 'local',
  }
}

export interface GscBootProgressEntry {
  stage: 'idle' | 'resolving' | 'downloading' | 'attaching' | 'ready' | 'error'
  filesAttached: number
  filesTotal: number
  error?: string
}

export function useGscAnalyticsContext() {
  const progress = ref<Record<string, GscBootProgressEntry>>({})
  function patchProgress(siteId: string, patch: Partial<GscBootProgressEntry>): void {
    progress.value = {
      ...progress.value,
      [siteId]: {
        ...(progress.value[siteId] ?? { stage: 'idle', filesAttached: 0, filesTotal: 0 }),
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
  return { progress, patchProgress, clearProgress }
}

export function useGscBootProgress() {
  const { progress } = useGscAnalyticsContext()
  return { progress }
}

export function useGscAnalyticsSourceInfo(_siteId: unknown) {
  const info = ref<Record<string, unknown> | null>(null)
  const supports = ref<Record<string, boolean>>({})
  return { info, supports }
}

// --- Analyzer registry ---------------------------------------------------

export function useGscAnalyzerDefs(): GscAnalyzerDefinition[] {
  const app = useNuxtApp()
  return (app.$gscAnalyzers as GscAnalyzerDefinition[] | undefined) ?? []
}

export function useGscAnalyzerDefsWithCapability<K extends GscAnalyzerCapability>(
  capability: K,
): GscAnalyzerDefinitionWithCapability<K>[] {
  return useGscAnalyzerDefs().filter(
    (d): d is GscAnalyzerDefinitionWithCapability<K> => d.capabilities?.[capability] != null,
  )
}

// --- Analyzer runtime -----------------------------------------------------

export function useGscAnalyzer(_siteId: unknown) {
  const ready = ref(false)
  const error = ref<Error | null>(null)
  return { ready, error }
}

export function useGscQuery() {
  return { run: async () => ({ rows: [] as Record<string, unknown>[], queryMs: 0 }) }
}

export function useGscAnalyzerBatch() {
  const results = ref<Record<string, unknown>>({})
  const loading = ref(false)
  return { results, loading }
}

export function useGscAnalyzerQuery(_siteId: unknown, _range?: unknown) {
  const ready = ref(false)
  const error = ref<Error | null>(null)
  const tables = ref({} as Record<string, GscBootProgressEntry>)
  return {
    ready,
    error,
    tables,
    analyze: async () => ({ results: [], meta: {}, queryMs: 0 }),
    runQuery: async <T = Record<string, unknown>>(_sql: string, _params?: readonly unknown[]) => ({ rows: [] as T[], queryMs: 0 }),
    query: async <T = Record<string, unknown>>(_opts: { sql: string, needs: readonly unknown[], params?: readonly unknown[] }) => [] as T[],
  }
}

// --- Panel runner ---------------------------------------------------------

export function useGscPanelRunner() {
  const ready = ref(false)
  const runner = ref<Record<string, unknown>>({})
  return { runner, ready }
}

// --- Data sources --------------------------------------------------------

export function useGscCountries(_siteId: unknown, _range?: unknown) {
  return { data: ref<unknown[]>([]), loading: ref(false), error: ref<Error | null>(null) }
}

export function useGscSearchAppearance(_siteId: unknown, _range?: unknown) {
  return { data: ref<unknown[]>([]), loading: ref(false), error: ref<Error | null>(null) }
}

export function useGscSitemaps(_siteId: unknown) {
  const records = ref<unknown[]>([])
  const loading = ref(false)
  return { records, loading }
}

export function useGscSitemapHistory(_siteId: unknown, _feedpathHash: unknown) {
  const snapshots = ref<unknown[]>([])
  const path = ref<string | null>(null)
  const loading = ref(false)
  return { snapshots, path, loading }
}

export function useGscInspections(_siteId: unknown) {
  const records = ref<unknown[]>([])
  const statusCounts = ref<Record<string, number>>({})
  const loading = ref(false)
  return { records, statusCounts, loading }
}

export function useGscInspectionHistory(_siteId: unknown, _urlHash: unknown) {
  const records = ref<unknown[]>([])
  const url = ref<string | null>(null)
  const loading = ref(false)
  return { records, url, loading }
}

export function useGscRollup<T = unknown>(_siteId: unknown, _name?: unknown) {
  return { data: ref<T | null>(null), loading: ref(false), error: ref<Error | null>(null) }
}

export function useGscTableState() {
  const state = ref({ sort: null as string | null, filter: '' })
  return state
}

// --- RPC -----------------------------------------------------------------

export function useGscRpc() {
  return {
    analysisSources: async () => ({ files: [] as unknown[] }),
    sourceInfo: async () => ({}),
    sites: async () => [] as unknown[],
  }
}

// --- Auth ----------------------------------------------------------------

export interface GscAuthInput {
  accessToken?: string
  refreshToken?: string
  apiKey?: string
}

export function setGscAuth(_auth: GscAuthInput | null): void {
  // No-op stub; real layer wires headers onto `$gscFetch`/`$gscAnalyticsClient`.
}

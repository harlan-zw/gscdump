// Auto-imported composable stubs for `examples/nuxt-dashboard`. Each function
// returns the shape templates consume; behaviour is intentionally inert so the
// example builds without bringing in the full nuxtseo.com layer.
// TODO: port from nuxtseo.com

import type { ComputedRef, Ref } from 'vue'
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

interface GscPeriodReturn {
  period: Ref<string>
  compareMode: Ref<GscCompareMode>
  stableData: Ref<boolean>
  range: Ref<GscDateRange>
  presets: Ref<Array<{ id: string, label: string }>>
  compareOptions: Ref<Array<{ id: GscCompareMode, label: string }>>
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10)
}

function isoMinusDays(days: number): string {
  return new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10)
}

export function useGscPeriod(): GscPeriodReturn {
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

interface GscCurrentSiteReturn {
  siteId: ComputedRef<string>
  site: Ref<GscCurrentSite | null>
}

export function useGscCurrentSite(): GscCurrentSiteReturn {
  const route = useRoute()
  const siteId = computed(() => String(route.params.id ?? ''))
  const site = ref<GscCurrentSite | null>(null)
  return { siteId, site }
}

// --- Sites list -----------------------------------------------------------

interface GscSitesReturn {
  sites: Ref<GscCurrentSite[]>
  loading: Ref<boolean>
  error: Ref<Error | null>
}

export function useGscSites(): GscSitesReturn {
  const sites = ref<GscCurrentSite[]>([])
  const loading = ref(false)
  const error = ref<Error | null>(null)
  return { sites, loading, error }
}

// --- Analytics config/context --------------------------------------------

interface GscAnalyticsConfig {
  apiBase: string
  duckdbBundleBase: string
  timezone: string
  toastErrors: boolean
  defaultEngine: string
  mode: string
}

export function useGscAnalyticsConfig(): GscAnalyticsConfig {
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

interface GscAnalyticsContextReturn {
  progress: Ref<Record<string, GscBootProgressEntry>>
  patchProgress: (siteId: string, patch: Partial<GscBootProgressEntry>) => void
  clearProgress: (siteId?: string) => void
}

export function useGscAnalyticsContext(): GscAnalyticsContextReturn {
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

export function useGscBootProgress(): Pick<GscAnalyticsContextReturn, 'progress'> {
  const { progress } = useGscAnalyticsContext()
  return { progress }
}

interface GscAnalyticsSourceInfoReturn {
  info: Ref<Record<string, unknown> | null>
  supports: Ref<Record<string, boolean>>
}

export function useGscAnalyticsSourceInfo(_siteId: unknown): GscAnalyticsSourceInfoReturn {
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

interface GscAnalyzerReturn {
  ready: Ref<boolean>
  error: Ref<Error | null>
}

export function useGscAnalyzer(_siteId: unknown): GscAnalyzerReturn {
  const ready = ref(false)
  const error = ref<Error | null>(null)
  return { ready, error }
}

interface GscQueryReturn {
  run: () => Promise<{ rows: Record<string, unknown>[], queryMs: number }>
}

export function useGscQuery(): GscQueryReturn {
  return { run: async () => ({ rows: [] as Record<string, unknown>[], queryMs: 0 }) }
}

interface GscAnalyzerBatchReturn {
  results: Ref<Record<string, unknown>>
  loading: Ref<boolean>
}

export function useGscAnalyzerBatch(): GscAnalyzerBatchReturn {
  const results = ref<Record<string, unknown>>({})
  const loading = ref(false)
  return { results, loading }
}

interface GscAnalyzerQueryReturn {
  ready: Ref<boolean>
  error: Ref<Error | null>
  tables: Ref<Record<string, GscBootProgressEntry>>
  analyze: () => Promise<{ results: unknown[], meta: Record<string, unknown>, queryMs: number }>
  runQuery: <T = Record<string, unknown>>(_sql: string, _params?: readonly unknown[]) => Promise<{ rows: T[], queryMs: number }>
  query: <T = Record<string, unknown>>(_opts: { sql: string, needs: readonly unknown[], params?: readonly unknown[] }) => Promise<T[]>
}

export function useGscAnalyzerQuery(_siteId: unknown, _range?: unknown): GscAnalyzerQueryReturn {
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

interface GscPanelRunnerReturn {
  runner: Ref<Record<string, unknown>>
  ready: Ref<boolean>
}

export function useGscPanelRunner(): GscPanelRunnerReturn {
  const ready = ref(false)
  const runner = ref<Record<string, unknown>>({})
  return { runner, ready }
}

// --- Data sources --------------------------------------------------------

interface GscCollectionReturn<T = unknown> {
  data: Ref<T[]>
  loading: Ref<boolean>
  error: Ref<Error | null>
}

export function useGscCountries(_siteId: unknown, _range?: unknown): GscCollectionReturn {
  return { data: ref<unknown[]>([]), loading: ref(false), error: ref<Error | null>(null) }
}

export function useGscSearchAppearance(_siteId: unknown, _range?: unknown): GscCollectionReturn {
  return { data: ref<unknown[]>([]), loading: ref(false), error: ref<Error | null>(null) }
}

interface GscRecordsReturn<T = unknown> {
  records: Ref<T[]>
  loading: Ref<boolean>
}

export function useGscSitemaps(_siteId: unknown): GscRecordsReturn {
  const records = ref<unknown[]>([])
  const loading = ref(false)
  return { records, loading }
}

interface GscPathHistoryReturn<T = unknown> extends GscRecordsReturn<T> {
  path: Ref<string | null>
}

export function useGscSitemapHistory(_siteId: unknown, _feedpathHash: unknown): GscPathHistoryReturn {
  const snapshots = ref<unknown[]>([])
  const path = ref<string | null>(null)
  const loading = ref(false)
  return { snapshots, path, loading }
}

interface GscInspectionsReturn<T = unknown> extends GscRecordsReturn<T> {
  statusCounts: Ref<Record<string, number>>
}

export function useGscInspections(_siteId: unknown): GscInspectionsReturn {
  const records = ref<unknown[]>([])
  const statusCounts = ref<Record<string, number>>({})
  const loading = ref(false)
  return { records, statusCounts, loading }
}

export function useGscInspectionHistory(_siteId: unknown, _urlHash: unknown): GscPathHistoryReturn {
  const records = ref<unknown[]>([])
  const url = ref<string | null>(null)
  const loading = ref(false)
  return { records, url, loading }
}

interface GscRollupReturn<T> {
  data: Ref<T | null>
  loading: Ref<boolean>
  error: Ref<Error | null>
}

export function useGscRollup<T = unknown>(_siteId: unknown, _name?: unknown): GscRollupReturn<T> {
  return { data: ref<T | null>(null), loading: ref(false), error: ref<Error | null>(null) }
}

export function useGscTableState(): Ref<{ sort: string | null, filter: string }> {
  const state = ref({ sort: null as string | null, filter: '' })
  return state
}

// --- RPC -----------------------------------------------------------------

interface GscRpcReturn {
  analysisSources: () => Promise<{ files: unknown[] }>
  sourceInfo: () => Promise<Record<string, never>>
  sites: () => Promise<unknown[]>
}

export function useGscRpc(): GscRpcReturn {
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

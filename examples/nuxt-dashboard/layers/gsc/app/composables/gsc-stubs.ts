// Auto-imported composable stubs for `examples/nuxt-dashboard`. Each function
// returns the shape templates consume; behaviour is intentionally inert so the
// example builds without bringing in the full nuxtseo.com layer.
// TODO: port from nuxtseo.com

import type { AnalysisParams, AnalysisResult } from '@gscdump/analysis'
import type { InspectionRecord, SitemapRecord } from '@gscdump/engine/entities'
import type { ComputedRef, InjectionKey, Ref, ShallowRef } from 'vue'
import type {
  GscAnalyzerCapability,
  GscAnalyzerDefinition,
  GscAnalyzerDefinitionWithCapability,
} from '../../types'
import { computed, customRef, inject, provide, ref, shallowRef } from 'vue'
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
export type CompareMode = GscCompareMode
export type Period = string

interface GscPeriodReturn {
  period: Ref<Period>
  compareMode: Ref<GscCompareMode>
  stableData: Ref<boolean>
  range: Ref<GscDateRange>
  presets: Ref<Array<{ value: Period, label: string }>>
  compareOptions: Ref<Array<{ value: GscCompareMode, label: string }>>
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
  const presets = ref<Array<{ value: Period, label: string }>>([
    { value: '7d', label: 'Last 7 days' },
    { value: '28d', label: 'Last 28 days' },
    { value: '90d', label: 'Last 90 days' },
  ])
  const compareOptions = ref<Array<{ value: GscCompareMode, label: string }>>([
    { value: 'none', label: 'No comparison' },
    { value: 'previous', label: 'Previous period' },
    { value: 'year', label: 'Year over year' },
  ])
  return { period, compareMode, stableData, range, presets, compareOptions }
}

// --- Current site ---------------------------------------------------------

export interface GscCurrentSite {
  id: string
  hostname: string
  label: string
  propertyType: 'domain' | 'url-prefix'
  url?: string
}

interface GscCurrentSiteReturn {
  siteId: ComputedRef<string>
  site: Ref<GscCurrentSite | null>
}

type GscCurrentSiteIdSource = string | Ref<string> | ComputedRef<string>

const gscCurrentSiteIdKey: InjectionKey<GscCurrentSiteIdSource> = Symbol('gsc-current-site-id')

export function provideGscCurrentSite(siteId: GscCurrentSiteIdSource): void {
  provide(gscCurrentSiteIdKey, siteId)
}

export function useGscCurrentSite(): GscCurrentSiteReturn {
  const route = useRoute()
  const providedSiteId = inject(gscCurrentSiteIdKey, null)
  const siteId = computed(() => {
    if (typeof providedSiteId === 'string')
      return providedSiteId
    if (providedSiteId)
      return providedSiteId.value
    return String(route.params.id ?? '')
  })
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
  stage: 'idle' | 'manifest' | 'resolving' | 'wasm' | 'downloading' | 'attach' | 'attaching' | 'ready' | 'error'
  filesAttached: number
  filesTotal: number
  source?: string | undefined
  startedAt?: number | undefined
  endedAt?: number | undefined
  error?: string | undefined
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

interface GscAnalyticsSourceInfo {
  browserAttachEligible?: boolean
  capabilities: {
    attachedTables?: boolean
    analyzers?: Record<string, boolean>
    [key: string]: unknown
  }
  [key: string]: unknown
}

interface GscAnalyticsSourceInfoReturn {
  info: Ref<GscAnalyticsSourceInfo | null>
  supports: (id: string) => ComputedRef<boolean>
}

export function useGscAnalyticsSourceInfo(_siteId: unknown): GscAnalyticsSourceInfoReturn {
  const info = ref<GscAnalyticsSourceInfo | null>(null)
  const supports = (id: string): ComputedRef<boolean> => computed(() => info.value?.capabilities.analyzers?.[id] ?? true)
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

type GscAnalyzerBatchState<T>
  = | { status: 'idle' | 'pending' | 'running' | 'skipped' }
    | { status: 'done', result: T }
    | { status: 'error', error: Error }

interface GscAnalyzerBatchReturn<T> {
  states: Ref<Record<string, GscAnalyzerBatchState<T>>>
  run: () => Promise<void>
}

export function useGscAnalyzerBatch<T = { results: unknown[], meta: Record<string, unknown> }>(
  runner?: { analyze: (params: AnalysisParams) => Promise<T> },
  ids: readonly string[] = [],
  _range?: unknown,
  options: { concurrency?: number, filter?: (id: string) => boolean } = {},
): GscAnalyzerBatchReturn<T> {
  const states = ref<Record<string, GscAnalyzerBatchState<T>>>(
    Object.fromEntries(ids.map(id => [id, { status: 'idle' as const }])),
  )

  async function run(): Promise<void> {
    if (!runner)
      return
    for (const id of ids) {
      if (options.filter && !options.filter(id)) {
        states.value = { ...states.value, [id]: { status: 'skipped' } }
        continue
      }
      states.value = { ...states.value, [id]: { status: 'running' } }
      try {
        const result = await runner.analyze({ type: id as AnalysisParams['type'] })
        states.value = { ...states.value, [id]: { status: 'done', result } }
      }
      catch (err) {
        states.value = { ...states.value, [id]: { status: 'error', error: err instanceof Error ? err : new Error(String(err)) } }
      }
    }
  }

  return { states, run }
}

interface GscAnalyzerQueryReturn {
  ready: Ref<boolean>
  error: Ref<Error | null>
  tables: Ref<Record<string, GscBootProgressEntry>>
  analyze: (params: AnalysisParams, opts?: { signal?: AbortSignal }) => Promise<AnalysisResult & { queryMs: number }>
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

export interface GscPanelRunner {
  query: (sql: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[], queryMs: number }>
  analyze: (params: AnalysisParams) => Promise<AnalysisResult & { queryMs?: number }>
}

interface GscPanelRunnerReturn {
  runner: ComputedRef<GscPanelRunner>
  ready: ComputedRef<boolean>
}

export const gscPanelRunnerKey: InjectionKey<{ runner: GscPanelRunner, ready: Ref<boolean> | ComputedRef<boolean> }> = Symbol('gsc-panel-runner')

const emptyPanelRunner: GscPanelRunner = {
  query: async () => ({ rows: [], queryMs: 0 }),
  analyze: async () => ({ results: [], meta: {}, queryMs: 0 }),
}

export function useGscPanelRunner(): GscPanelRunnerReturn {
  const injected = inject(gscPanelRunnerKey, null)
  const runner = computed(() => injected?.runner ?? emptyPanelRunner)
  const ready = computed(() => injected?.ready.value ?? false)
  return { runner, ready }
}

// --- Data sources --------------------------------------------------------

export interface MetricRow {
  clicks: number
  impressions: number
  sum_position: number
}

export interface CountryRow extends MetricRow {
  country: string
}

export interface SearchAppearanceRow extends MetricRow {
  searchAppearance: string
}

interface GscCollectionReturn<T> {
  data: Ref<T[]>
  rows: Ref<T[]>
  loading: Ref<boolean>
  error: Ref<Error | null>
}

export function useGscCountries(_siteId: unknown, _range?: unknown): GscCollectionReturn<CountryRow> {
  const rows = ref<CountryRow[]>([])
  return { data: rows, rows, loading: ref(false), error: ref<Error | null>(null) }
}

export function useGscSearchAppearance(_siteId: unknown, _range?: unknown): GscCollectionReturn<SearchAppearanceRow> {
  const rows = ref<SearchAppearanceRow[]>([])
  return { data: rows, rows, loading: ref(false), error: ref<Error | null>(null) }
}

interface GscRecordsReturn<T = unknown> {
  records: Ref<T[]>
  loading: Ref<boolean>
}

export function useGscSitemaps(_siteId: unknown): GscRecordsReturn<SitemapRecord> {
  const records = ref<SitemapRecord[]>([])
  const loading = ref(false)
  return { records, loading }
}

interface GscSitemapHistoryReturn extends GscRecordsReturn<SitemapRecord> {
  snapshots: Ref<SitemapRecord[]>
  path: Ref<string | null>
}

export function useGscSitemapHistory(_siteId: unknown, _feedpathHash: unknown): GscSitemapHistoryReturn {
  const snapshots = ref<SitemapRecord[]>([])
  const path = ref<string | null>(null)
  const loading = ref(false)
  return { records: snapshots, snapshots, path, loading }
}

interface GscInspectionsReturn extends GscRecordsReturn<InspectionRecord> {
  statusCounts: Ref<Record<string, number>>
}

export function useGscInspections(_siteId: unknown): GscInspectionsReturn {
  const records = ref<InspectionRecord[]>([])
  const statusCounts = ref<Record<string, number>>({})
  const loading = ref(false)
  return { records, statusCounts, loading }
}

interface GscInspectionHistoryReturn extends GscRecordsReturn<InspectionRecord> {
  url: Ref<string | null>
}

export function useGscInspectionHistory(_siteId: unknown, _urlHash: unknown): GscInspectionHistoryReturn {
  const records = ref<InspectionRecord[]>([])
  const url = ref<string | null>(null)
  const loading = ref(false)
  return { records, url, loading }
}

interface GscRollupEnvelope<T> {
  version?: number
  id?: string
  builtAt?: number
  windowDays?: number | null
  payload: T
}

interface GscRollupReturn<T> {
  data: ComputedRef<T | null>
  envelope: ShallowRef<GscRollupEnvelope<T> | null>
  loading: Ref<boolean>
  error: Ref<Error | null>
}

export function useGscRollup<T = unknown>(_siteId: unknown, _name?: unknown): GscRollupReturn<T> {
  const envelope = shallowRef<GscRollupEnvelope<T> | null>(null)
  const data = computed<T | null>(() => envelope.value?.payload ?? null)
  return { data, envelope, loading: ref(false), error: ref<Error | null>(null) }
}

export function useGscTableState<TFilter extends Record<string, unknown> = Record<string, never>>(
  options: { defaultFilter?: TFilter } = {},
): { q: Ref<string>, filter: Ref<TFilter>, sort: Ref<string | null> } {
  const q = ref('')
  let filterValue = (options.defaultFilter ?? {}) as TFilter
  const filter = customRef<TFilter>((track, trigger) => ({
    get() {
      track()
      return filterValue
    },
    set(next) {
      filterValue = next
      trigger()
    },
  }))
  const sort = ref<string | null>(null)
  return { q, filter, sort }
}

// --- RPC -----------------------------------------------------------------

interface GscRpcReturn {
  query: <T = unknown>(_query: unknown, _options?: unknown) => Promise<T>
  analysisSources: () => Promise<{ files: unknown[] }>
  sourceInfo: () => Promise<Record<string, never>>
  sites: () => Promise<unknown[]>
}

export function useGscRpc(): GscRpcReturn {
  return {
    query: async <T = unknown>() => ({} as T),
    analysisSources: async () => ({ files: [] as unknown[] }),
    sourceInfo: async () => ({}),
    sites: async () => [] as unknown[],
  }
}

// --- Auth ----------------------------------------------------------------

export interface GscAuthInput {
  accessToken?: string
  refreshToken?: string
  apiKey?: string | null
  apiBase?: string
  browserAnalyzerEnabled?: boolean
  userId?: string | null
}

export function setGscAuth(_auth: GscAuthInput | (() => GscAuthInput) | null): void {
  // No-op stub; real layer wires headers onto `$gscFetch`/`$gscAnalyticsClient`.
}

// Per-site analyzer. Two modes, picked from `/source-info`:
//
//  - `browser-attached` — server source is SQL-capable and advertises
//    `attachedTables`; we boot DuckDB-WASM in the browser and attach parquets
//    for local querying. Fastest path for large dashboards.
//  - `server` — everything else (GSC API live row source, engine sources
//    without attach support, etc.). `analyze()` proxies to the server POST
//    endpoint; `query()` throws since there's no local SQL engine.
//
// Cached per-site so navigation between panels on the same site doesn't
// re-boot. Writes progress to the shared map so <GscBootProgress> lights up
// on boot regardless of mode.

import type { AnalysisParams, AnalysisResult } from '@gscdump/analysis'
import type { AnalysisSourcesResponse, SourceInfoResponse } from '@gscdump/contracts'
import type { AttachedTablesHandle, BrowserAnalysisRuntime, DuckDBWasmBootResult, QueryResult } from '@gscdump/engine-duckdb-wasm'
import type { SiteLoadProgress } from './useGscAnalytics'
import { defaultAnalyzerRegistry } from '@gscdump/analysis'
import { coerceRow } from '@gscdump/engine'
import { useGscSharedSiteResource } from './_useGscSharedSiteResource'
import { useGscAnalyticsContext } from './useGscAnalytics'
import { useGscAnalyticsClient } from './useGscAnalyticsClient'
import { useGscAnalyticsConfig } from './useGscAnalyticsConfig'
import { loadSourceInfoFor } from './useGscAnalyticsSourceInfo'
import { readGscAuth, resolveGscAuthHeaders } from './useGscAuth'

export interface GscAnalyzerTimings {
  bootMs: number
  manifestMs: number
  attachMs: number
}

export interface GscAnalyzerInstance {
  ready: Ref<boolean>
  initializing: Ref<boolean>
  error: Ref<Error | null>
  attachedTables: Ref<string[]>
  timings: Ref<GscAnalyzerTimings | null>
  /** Server-reported manifest version of the currently-attached snapshot. */
  manifestVersion: Ref<string | undefined>
  query: (sql: string, params?: unknown[]) => Promise<QueryResult>
  analyze: (params: AnalysisParams, opts?: { signal?: AbortSignal }) => Promise<AnalysisResult & { queryMs: number }>
  /**
   * Re-probe `analysis-sources`; if the manifest version changed since the
   * last attach, detach views and re-attach against the fresher parquet
   * partitions in place. No-op for `server`-mode analyzers and when the
   * version matches. Resolves to true if the runtime re-attached.
   */
  refresh: () => Promise<boolean>
  dispose: () => Promise<void>
}

const EMPTY_TABLES: readonly string[] = Object.freeze([])

/**
 * Get (or create) an analyzer for a site. Per-site cached across the app so
 * pages sharing a site reuse the boot. Refcounted — auto-disposes when the
 * last consumer unmounts. The returned refs are `computed` over the currently
 * bound cached instance; switching `siteId` rebinds and the computeds track
 * the new instance with no manual mirroring.
 */
export function useGscAnalyzer(siteId: MaybeRefOrGetter<string | null | undefined>): GscAnalyzerInstance & { currentSiteId: Ref<string | null> } {
  const ctx = useGscAnalyticsContext()
  const { bound, currentSiteId } = useGscSharedSiteResource<GscAnalyzerInstance>('analyzer', siteId, {
    factory: id => createInstance(id, ctx.patchProgress, () => loadSourceInfoFor(id) as Promise<SourceInfoResponse>),
    onDispose: inst => inst.dispose(),
  })

  // Computed views over the bound instance. Reactive on both site switch
  // (bound changes) and inner ref updates on the cached instance.
  const ready = computed(() => bound.value?.ready.value ?? false) as unknown as Ref<boolean>
  const initializing = computed(() => bound.value?.initializing.value ?? false) as unknown as Ref<boolean>
  const error = computed(() => bound.value?.error.value ?? null) as unknown as Ref<Error | null>
  const attachedTables = computed(() => bound.value?.attachedTables.value ?? (EMPTY_TABLES as string[])) as unknown as Ref<string[]>
  const timings = computed(() => bound.value?.timings.value ?? null) as unknown as Ref<GscAnalyzerTimings | null>
  const manifestVersion = computed(() => bound.value?.manifestVersion.value) as unknown as Ref<string | undefined>

  async function query(sql: string, params?: unknown[]): Promise<QueryResult> {
    const inst = bound.value
    if (!inst)
      throw new Error('useGscAnalyzer: no site bound')
    return inst.query(sql, params)
  }

  async function analyze(params: AnalysisParams, opts?: { signal?: AbortSignal }): Promise<AnalysisResult & { queryMs: number }> {
    const inst = bound.value
    if (!inst)
      throw new Error('useGscAnalyzer: no site bound')
    return inst.analyze(params, opts)
  }

  async function refresh(): Promise<boolean> {
    const inst = bound.value
    if (!inst)
      return false
    return inst.refresh()
  }

  return {
    ready,
    initializing,
    error,
    attachedTables,
    timings,
    manifestVersion,
    refresh,
    currentSiteId,
    query,
    analyze,
    // No-op: lifecycle is owned by the shared bag's onScopeDispose hook.
    // Kept for API compat with consumers that opportunistically call dispose().
    dispose: async (): Promise<void> => {},
  }
}

function createInstance(
  siteId: string,
  patchProgress: (id: string, p: Partial<SiteLoadProgress>) => void,
  sourceInfoLoader: () => Promise<SourceInfoResponse>,
): GscAnalyzerInstance {
  const ready = ref(false)
  const initializing = ref(true)
  const error = ref<Error | null>(null)
  const attachedTables = ref<string[]>([])
  const timings = ref<GscAnalyzerTimings | null>(null)
  const manifestVersion = ref<string | undefined>(undefined)

  function patch(p: Partial<SiteLoadProgress>): void {
    patchProgress(siteId, { source: 'duckdb', ...p })
  }

  let runtime: BrowserAnalysisRuntime | null = null
  let bootedDb: DuckDBWasmBootResult | null = null
  let attachedHandle: AttachedTablesHandle | null = null
  let mode: 'browser-attached' | 'server' = 'server'
  const inFlight = new Map<string, Promise<AnalysisResult & { queryMs: number }>>()

  // Cross-origin: if the host returns relative parquet URLs (`/api/r2-data/…`)
  // and `apiBase` is set, prefix them so DuckDB-WASM hits the data origin
  // rather than the consumer's own host. Same-origin / absolute URLs pass
  // through unchanged.
  function rewriteParquetUrl(url: string): string {
    const apiBase = useGscAnalyticsConfig().apiBase
    if (!apiBase || !url.startsWith('/'))
      return url
    return `${apiBase.replace(/\/+$/, '')}${url}`
  }

  async function attachFromSources(sources: AnalysisSourcesResponse): Promise<{ attached: number, total: number }> {
    if (!bootedDb)
      throw new Error('useGscAnalyzer: attachFromSources called before DuckDB boot')

    const tables = Object.entries(sources.tables)
      .filter(([, urls]) => Array.isArray(urls) && urls.length > 0)
      .map(([table, urls]) => ({ table, urls: urls.map(rewriteParquetUrl) }))

    const total = tables.reduce((n, t) => n + t.urls.length, 0)
    patch({ stage: 'attach', filesTotal: total, filesAttached: 0 })

    // Cross-origin parquet GETs need the host-supplied auth header (same one
    // useGscFetch attaches to /api/__gsc/* calls). DuckDB-WASM runs raw fetch
    // under the hood, so we pass the header through fetchInit. Cookies aren't
    // useful here — the parquet origin (gscdump.com) and the host page sit in
    // different session realms when the consumer mode is active.
    const extraHeaders = resolveGscAuthHeaders()
    const hasExtra = Object.keys(extraHeaders).length > 0
    let attached = 0
    const { attachParquetUrlTables } = await import('@gscdump/engine-duckdb-wasm')
    const handle = await attachParquetUrlTables({
      db: bootedDb.db,
      conn: bootedDb.conn,
      tables,
      version: sources.manifestVersion,
      fetchInit: hasExtra
        ? { credentials: 'omit', headers: extraHeaders }
        : { credentials: 'same-origin' },
      onFileAttached: () => {
        attached++
        patch({ filesAttached: attached })
      },
    })
    attachedHandle = handle
    // `handle.tables` reflects what *actually* attached — `attachParquetUrlTables`
    // drops tables on fetch failure, so the requested list can over-report.
    // Use the authoritative list so downstream pre-checks (e.g. the engine's
    // AttachedTableMissingError fast-fail) get an accurate view.
    attachedTables.value = handle.tables
    manifestVersion.value = sources.manifestVersion
    return { attached, total }
  }

  const boot = (async () => {
    patch({ stage: 'manifest', startedAt: Date.now(), filesAttached: 0, filesTotal: 0, error: undefined, endedAt: undefined })
    // Probe the server-resolved source first. Its kind + attachedTables bit
    // decides whether we boot DuckDB-WASM (expensive) or proxy to the server.
    const info = await sourceInfoLoader()
    mode = info.browserAttachEligible ? 'browser-attached' : 'server'

    if (mode === 'server') {
      // No local runtime; analyze() posts to the server. Mark ready so the
      // shared progress UI stops spinning.
      timings.value = { bootMs: 0, manifestMs: 0, attachMs: 0 }
      ready.value = true
      patch({ stage: 'ready', endedAt: Date.now() })
      return null
    }

    const cfg = useGscAnalyticsConfig().duckdbBundleBase
    patch({ stage: 'wasm' })
    const t0 = performance.now()
    // Dynamic import so server/consumer-mode hosts (no browser SQL) never pull
    // the wasm engine into their client bundle. The static type-only import at
    // top of the file keeps the type signatures available without an emit.
    const { bootDuckDBWasm, createBrowserAnalysisRuntime } = await import('@gscdump/engine-duckdb-wasm')
    bootedDb = await bootDuckDBWasm(cfg
      ? {
          bundles: {
            mvp: { mainModule: `${cfg}/duckdb-mvp.wasm`, mainWorker: `${cfg}/duckdb-browser-mvp.worker.js` },
            eh: { mainModule: `${cfg}/duckdb-eh.wasm`, mainWorker: `${cfg}/duckdb-browser-eh.worker.js` },
          },
        }
      : undefined)
    const bootMs = performance.now() - t0

    patch({ stage: 'manifest' })
    const t1 = performance.now()
    const sources = await useGscAnalyticsClient().getAnalysisSources(siteId) as AnalysisSourcesResponse
    const manifestMs = performance.now() - t1

    const t2 = performance.now()
    const { total } = await attachFromSources(sources)
    const attachMs = performance.now() - t2

    runtime = createBrowserAnalysisRuntime(bootedDb, { schema: 'main', attachedTables: attachedTables.value })
    runtime.setVersion(sources.manifestVersion)
    timings.value = { bootMs, manifestMs, attachMs }
    ready.value = true
    patch({ stage: 'ready', filesAttached: total, endedAt: Date.now() })
    return runtime
  })()
    .catch((e) => {
      const err = e instanceof Error ? e : new Error(String(e))
      error.value = err
      patch({ stage: 'error', error: err.message, endedAt: Date.now() })
      throw err
    })
    .finally(() => {
      initializing.value = false
    })

  // Don't let the boot promise crash the runtime — error.value surfaces it.
  boot.catch(() => {})

  async function query(sql: string, params?: unknown[]): Promise<QueryResult> {
    const rt = await boot
    if (!rt)
      throw new Error('useGscAnalyzer: query() requires a SQL-capable source with attachedTables; current source routes through the server')
    return rt.query(sql, params)
  }

  async function runServerAnalyze(params: AnalysisParams, signal?: AbortSignal): Promise<AnalysisResult & { queryMs: number }> {
    const out = await useGscAnalyticsClient().analyze<AnalysisResult & { queryMs?: number }>(siteId, params)
    return {
      results: coerceResults(out.results) as AnalysisResult['results'],
      meta: out.meta as AnalysisResult['meta'],
      queryMs: out.queryMs ?? 0,
    }
  }

  async function analyze(params: AnalysisParams, opts?: { signal?: AbortSignal }): Promise<AnalysisResult & { queryMs: number }> {
    const rt = await boot
    opts?.signal?.throwIfAborted?.()

    const key = JSON.stringify(params)
    const existing = inFlight.get(key)
    if (existing)
      return opts?.signal ? raceSignal(existing, opts.signal) : existing

    const p = (async () => {
      if (!rt)
        return runServerAnalyze(params, opts?.signal)
      const out = await rt.analyze(params as never, defaultAnalyzerRegistry)
      opts?.signal?.throwIfAborted?.()
      return {
        results: coerceResults(out.results) as AnalysisResult['results'],
        meta: out.meta as AnalysisResult['meta'],
        queryMs: out.queryMs,
      }
    })()
    inFlight.set(key, p)
    p.finally(() => {
      if (inFlight.get(key) === p)
        inFlight.delete(key)
    })
    return opts?.signal ? raceSignal(p, opts.signal) : p
  }

  async function refresh(): Promise<boolean> {
    await boot
    if (mode !== 'browser-attached' || !runtime || !bootedDb)
      return false
    const sources = await useGscAnalyticsClient().getAnalysisSources(siteId) as AnalysisSourcesResponse
    if (!runtime.isStale(sources.manifestVersion))
      return false
    // Drop the stale views before swapping in the new partitions. The runtime
    // (db + conn) stays alive — we're swapping the data, not the engine.
    await attachedHandle?.detach().catch((e) => {
      console.warn('[analyzer] detach during refresh failed', e)
    })
    attachedHandle = null
    await attachFromSources(sources)
    runtime.setVersion(sources.manifestVersion)
    runtime.setAttachedTables(attachedTables.value)
    return true
  }

  async function dispose(): Promise<void> {
    await runtime?.close().catch((e) => {
      console.error('[analyzer] runtime.close failed', e)
    })
    runtime = null
    bootedDb = null
    attachedHandle = null
    ready.value = false
    attachedTables.value = []
    manifestVersion.value = undefined
    inFlight.clear()
  }

  return { ready, initializing, error, attachedTables, timings, manifestVersion, query, analyze, refresh, dispose }
}

function coerceResults(results: unknown): unknown {
  if (!Array.isArray(results))
    return results
  let changed = false
  const out: unknown[] = Array.from({ length: results.length })
  for (let i = 0; i < results.length; i++) {
    const r = results[i]
    if (r && typeof r === 'object') {
      const c = coerceRow(r as Record<string, unknown>)
      if (c !== r)
        changed = true
      out[i] = c
    }
    else {
      out[i] = r
    }
  }
  return changed ? out : results
}

function abortError(): DOMException {
  return new DOMException('aborted', 'AbortError')
}

function raceSignal<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted)
    return Promise.reject(abortError())
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(abortError())
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(
      (v) => {
        signal.removeEventListener('abort', onAbort)
        resolve(v)
      },
      (e) => {
        signal.removeEventListener('abort', onAbort)
        reject(e)
      },
    )
  })
}

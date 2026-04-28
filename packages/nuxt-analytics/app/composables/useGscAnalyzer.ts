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
import type { AttachedTablesHandle, BrowserAnalysisRuntime, DuckDBWasmBootResult, QueryResult } from '@gscdump/engine-duckdb-wasm'
import type { SiteLoadProgress } from './useGscAnalytics'
import { defaultAnalyzerRegistry } from '@gscdump/analysis'
import { attachParquetUrlTables, bootDuckDBWasm, createBrowserAnalysisRuntime } from '@gscdump/engine-duckdb-wasm'
import { getGscFetchHeaders, useGscFetch } from '../utils/gsc-fetch'
import { _useGscAnalyticsContext } from './useGscAnalytics'

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

interface CachedAnalyzer extends GscAnalyzerInstance {
  refs: number
}

interface AnalysisSourcesResponse {
  tables: Record<string, string[]>
  generatedAt: string
  manifestVersion: string
}

interface SourceInfoResponse {
  name: string
  kind: 'row' | 'sql'
  capabilities: { attachedTables?: boolean, [k: string]: unknown }
  supportedAnalyzerIds: string[]
  browserAttachEligible: boolean
}

/**
 * Get (or create) an analyzer for a site. Per-site cached across the app so
 * pages sharing a site reuse the boot. Refcounted — auto-disposes when the
 * last consumer unmounts. Returns a reactive proxy whose refs track the
 * currently-bound site's instance; switching `siteId` rebinds.
 */
export function useGscAnalyzer(siteId: MaybeRefOrGetter<string | null | undefined>): GscAnalyzerInstance & { currentSiteId: Ref<string | null> } {
  const ctx = _useGscAnalyticsContext()
  const cache = ctx._analyzers as Map<string, CachedAnalyzer>

  const currentSiteId = ref<string | null>(null)
  const emptyRef = <T>(v: T): Ref<T> => ref(v) as Ref<T>

  // Fallback empty refs when no site is bound. Replaced on bind with the
  // cached instance's refs via `readonly` re-export.
  const ready = emptyRef(false)
  const initializing = emptyRef(false)
  const error = emptyRef<Error | null>(null)
  const attachedTables = emptyRef<string[]>([])
  const timings = emptyRef<GscAnalyzerTimings | null>(null)
  const manifestVersion = emptyRef<string | undefined>(undefined)

  let bound: CachedAnalyzer | null = null
  let stopSync: (() => void) | null = null

  function bind(id: string): void {
    unbind()
    let inst = cache.get(id)
    if (!inst) {
      inst = createInstance(id, ctx.patchProgress)
      cache.set(id, inst)
    }
    inst.refs++
    bound = inst
    currentSiteId.value = id

    const stops = [
      watch(inst.ready, (v: boolean) => (ready.value = v), { immediate: true }),
      watch(inst.initializing, (v: boolean) => (initializing.value = v), { immediate: true }),
      watch(inst.error, (v: Error | null) => (error.value = v), { immediate: true }),
      watch(inst.attachedTables, (v: string[]) => (attachedTables.value = v), { immediate: true, deep: true }),
      watch(inst.timings, (v: GscAnalyzerTimings | null) => (timings.value = v), { immediate: true }),
      watch(inst.manifestVersion, (v: string | undefined) => (manifestVersion.value = v), { immediate: true }),
    ]
    stopSync = () => stops.forEach(fn => fn())
  }

  function unbind(): void {
    stopSync?.()
    stopSync = null
    if (bound) {
      bound.refs--
      if (bound.refs <= 0) {
        const id = currentSiteId.value
        if (id)
          cache.delete(id)
        void bound.dispose()
      }
      bound = null
    }
    ready.value = false
    initializing.value = false
    error.value = null
    attachedTables.value = []
    timings.value = null
    manifestVersion.value = undefined
  }

  watch(
    () => toValue(siteId),
    (id: string | null | undefined) => {
      if (!id) {
        unbind()
        currentSiteId.value = null
        return
      }
      if (import.meta.client)
        bind(id)
    },
    { immediate: true },
  )

  onScopeDispose(unbind)

  async function query(sql: string, params?: unknown[]): Promise<QueryResult> {
    if (!bound)
      throw new Error('useGscAnalyzer: no site bound')
    return bound.query(sql, params)
  }

  async function analyze(params: AnalysisParams, opts?: { signal?: AbortSignal }): Promise<AnalysisResult & { queryMs: number }> {
    if (!bound)
      throw new Error('useGscAnalyzer: no site bound')
    return bound.analyze(params, opts)
  }

  async function refresh(): Promise<boolean> {
    if (!bound)
      return false
    return bound.refresh()
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
    dispose: async (): Promise<void> => {
      unbind()
    },
  }
}

function createInstance(
  siteId: string,
  patchProgress: (id: string, p: Partial<SiteLoadProgress>) => void,
): CachedAnalyzer {
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
    const apiBase = (useRuntimeConfig().public.analytics as { apiBase?: string } | undefined)?.apiBase ?? ''
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
    const extraHeaders = getGscFetchHeaders()
    const hasExtra = Object.keys(extraHeaders).length > 0
    let attached = 0
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
    const info = await useGscFetch()<SourceInfoResponse>(
      `/api/__gsc/sites/${encodeURIComponent(siteId)}/source-info`,
      { headers: { 'cache-control': 'no-cache' } },
    )
    mode = info.browserAttachEligible ? 'browser-attached' : 'server'

    if (mode === 'server') {
      // No local runtime; analyze() posts to the server. Mark ready so the
      // shared progress UI stops spinning.
      timings.value = { bootMs: 0, manifestMs: 0, attachMs: 0 }
      ready.value = true
      patch({ stage: 'ready', endedAt: Date.now() })
      return null
    }

    const cfg = useRuntimeConfig().public.duckdbBundleBase as string
    patch({ stage: 'wasm' })
    const t0 = performance.now()
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
    const sources = await useGscFetch()<AnalysisSourcesResponse>(
      `/api/__gsc/sites/${encodeURIComponent(siteId)}/analysis-sources`,
      { headers: { 'cache-control': 'no-cache' } },
    )
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
    const out = await useGscFetch()<AnalysisResult & { queryMs?: number }>(
      `/api/__gsc/sites/${encodeURIComponent(siteId)}/analyze`,
      { method: 'POST', body: params, signal },
    )
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
    const sources = await useGscFetch()<AnalysisSourcesResponse>(
      `/api/__gsc/sites/${encodeURIComponent(siteId)}/analysis-sources`,
      { headers: { 'cache-control': 'no-cache' } },
    )
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

  return { ready, initializing, error, attachedTables, timings, manifestVersion, query, analyze, refresh, dispose, refs: 0 }
}

function coerceRow(row: Record<string, unknown>): Record<string, unknown> {
  let mutated: Record<string, unknown> | null = null
  for (const [k, v] of Object.entries(row)) {
    if (typeof v === 'bigint') {
      if (!mutated)
        mutated = { ...row }
      mutated[k] = Number(v)
    }
  }
  return mutated ?? row
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

/**
 * useGscSnapshotAnalyzer — the single consolidated GSC analyzer composable.
 *
 * Replaces `useGscAnalyzer.ts` (pkg) and `useBrowserAnalyzer.ts` (app). One
 * OPFS-backed, attach-once, browser-eligibility-aware analyzer.
 *
 * Implements the frozen contract in `useGscSnapshotAnalyzer.contract.ts`.
 *
 * Flow per `(site, searchType, range)`:
 *  1. RESOLVE — call the file-resolution endpoint (`/analysis-sources`). It
 *     returns per-table `mode: browser | server` and, for browser tables, the
 *     compacted Iceberg parquet files (content hash + signed URL).
 *  2. BOOT — DuckDB-WASM boots once.
 *  3. DOWNLOAD + ATTACH — browser-mode files download into OPFS (content-hash
 *     verified) and attach as views. ATTACH-ONCE: filter / range changes
 *     inside the attached span re-query, never re-attach.
 *  4. QUERY — `query(archetype)` routes per-table: browser-mode tables run
 *     locally against OPFS; server-mode tables POST to the server tail.
 *     Identical queries replay from an in-memory LRU keyed by
 *     `snapshotVersion + queryHash`.
 *
 * Quota: a `QuotaExceededError` during OPFS download degrades the affected
 * table to the server tail (`storage.degraded = true`); it never crashes.
 *
 * The instance is cached + refcounted per `(site, searchType, range)` at module
 * scope (keyed by NuxtApp) so panels on the same site share one DuckDB-WASM
 * boot and one OPFS attach.
 */

import type { OpfsFileProgress } from '@gscdump/engine-duckdb-wasm'
import type {
  ArchetypeQuery,
  ArchetypeResult,
  ArchetypeResultRow,
  ArchetypeResultSource,
  FileResolutionResponse,
  GscSearchType,
  ResolvedTable,
} from '@gscdump/sdk'
import type { NuxtApp } from 'nuxt/app'
import type {
  AnalyzerProgress,
  AnalyzerRange,
  AnalyzerStorageState,
  AnalyzerTableRouting,
  GscSnapshotAnalyzer,
  GscSnapshotAnalyzerOptions,
  UseGscSnapshotAnalyzer,
} from './useGscSnapshotAnalyzer.contract'
import { createResultLru, resultCacheKey, routeArchetype } from './useGscSnapshotAnalyzer.routing'

const DEFAULT_SEARCH_TYPE: GscSearchType = 'web'
const DEFAULT_RESULT_CACHE_SIZE = 64
const DEFAULT_ATTACH_FETCH_CONCURRENCY = 2

const IDLE_PROGRESS: AnalyzerProgress = Object.freeze({
  phase: 'idle',
  filesReady: 0,
  filesTotal: 0,
  bytesReady: 0,
  bytesTotal: 0,
})

const IDLE_STORAGE: AnalyzerStorageState = Object.freeze({
  persisted: false,
  degraded: false,
})

// ── instance cache (per NuxtApp, refcounted) ────────────────────────────────

interface CacheEntry {
  instance: GscSnapshotAnalyzer
  refs: number
}
const instanceBags = new WeakMap<NuxtApp, Map<string, CacheEntry>>()

function instanceCacheFor(app: NuxtApp): Map<string, CacheEntry> {
  let bag = instanceBags.get(app)
  if (!bag) {
    bag = new Map()
    instanceBags.set(app, bag)
  }
  return bag
}

function instanceKey(siteId: string, searchType: GscSearchType, range: AnalyzerRange | null): string {
  return JSON.stringify([siteId, searchType, range?.start ?? null, range?.end ?? null])
}

function normalizeRange(range: AnalyzerRange | null | undefined): AnalyzerRange | null {
  return range?.start && range?.end ? { start: range.start, end: range.end } : null
}

// ── the composable ──────────────────────────────────────────────────────────

export const useGscSnapshotAnalyzer: UseGscSnapshotAnalyzer = (
  siteId,
  searchType,
  range,
  options,
) => {
  const app = useNuxtApp()
  const cache = instanceCacheFor(app)

  const key = computed(() => {
    const id = toValue(siteId)
    if (!id)
      return null
    return instanceKey(
      id,
      toValue(searchType) ?? DEFAULT_SEARCH_TYPE,
      normalizeRange(toValue(range)),
    )
  })

  /** Acquire (or create) + refcount the cached instance for the current key. */
  function acquire(k: string): GscSnapshotAnalyzer {
    let entry = cache.get(k)
    if (!entry) {
      const [id, st, start, end] = JSON.parse(k) as [string, GscSearchType, string | null, string | null]
      entry = {
        instance: createSnapshotAnalyzerInstance(
          id,
          st,
          start && end ? { start, end } : null,
          options ?? {},
        ),
        refs: 0,
      }
      cache.set(k, entry)
    }
    entry.refs++
    return entry.instance
  }

  function release(k: string): void {
    const entry = cache.get(k)
    if (!entry)
      return
    entry.refs--
    if (entry.refs <= 0) {
      cache.delete(k)
      entry.instance.dispose().catch((e) => {
        console.error('[useGscSnapshotAnalyzer] dispose failed', e)
      })
    }
  }

  // Bind to the current key; rebind (release old, acquire new) on change.
  let boundKey: string | null = null
  const bound = shallowRef<GscSnapshotAnalyzer | null>(null)

  watch(key, (next, prev) => {
    if (next === prev)
      return
    if (boundKey)
      release(boundKey)
    boundKey = next
    bound.value = next ? acquire(next) : null
  }, { immediate: true })

  tryOnScopeDispose(() => {
    if (boundKey)
      release(boundKey)
    boundKey = null
  })

  // Reactive views over the bound instance — track both site switch and inner
  // ref updates. A null-bound analyzer reports a safe idle state.
  const ready = computed(() => bound.value?.ready.value ?? false) as Ref<boolean>
  const initializing = computed(() => bound.value?.initializing.value ?? false) as Ref<boolean>
  const error = computed(() => bound.value?.error.value ?? null) as Ref<Error | null>
  const progress = computed<AnalyzerProgress>(() => bound.value?.progress.value ?? IDLE_PROGRESS) as Ref<AnalyzerProgress>
  const storage = computed<AnalyzerStorageState>(() => bound.value?.storage.value ?? IDLE_STORAGE) as Ref<AnalyzerStorageState>
  const routing = computed<AnalyzerTableRouting>(() => bound.value?.routing.value ?? {}) as Ref<AnalyzerTableRouting>
  const snapshotVersion = computed(() => bound.value?.snapshotVersion.value) as Ref<string | undefined>
  const currentSiteId = computed(() => bound.value?.currentSiteId.value ?? null) as Ref<string | null>

  return {
    ready,
    initializing,
    error,
    progress,
    storage,
    routing,
    snapshotVersion,
    currentSiteId,
    query: async <R extends ArchetypeResultRow = ArchetypeResultRow>(
      q: ArchetypeQuery,
      opts?: { signal?: AbortSignal },
    ): Promise<ArchetypeResult<R>> => {
      const inst = bound.value
      if (!inst)
        throw new Error('useGscSnapshotAnalyzer: no site bound')
      return inst.query<R>(q, opts)
    },
    refresh: () => bound.value?.refresh() ?? Promise.resolve(false),
    clearCache: () => bound.value?.clearCache(),
    // Lifecycle owned by the refcounted cache; kept for API compatibility.
    dispose: async () => {},
  }
}

// ── the per-instance implementation ─────────────────────────────────────────

function createSnapshotAnalyzerInstance(
  siteId: string,
  searchType: GscSearchType,
  range: AnalyzerRange | null,
  options: GscSnapshotAnalyzerOptions,
): GscSnapshotAnalyzer {
  const ready = ref(false)
  const initializing = ref(true)
  const error = ref<Error | null>(null)
  const progress = ref<AnalyzerProgress>({ ...IDLE_PROGRESS })
  const storage = ref<AnalyzerStorageState>({ ...IDLE_STORAGE })
  const routing = ref<AnalyzerTableRouting>({})
  const snapshotVersion = ref<string | undefined>(undefined)
  const currentSiteId = ref<string | null>(siteId)

  const resultLru = createResultLru<ArchetypeResult>(
    options.resultCacheSize ?? DEFAULT_RESULT_CACHE_SIZE,
  )

  const lifetime = new AbortController()

  // DuckDB-WASM runtime + OPFS handle — populated by `boot`. Typed loosely
  // because the runtime types come from a dynamically-imported package.
  let db: { conn: unknown, db: unknown } | null = null
  let conn: any = null
  let attachedHandle: { detach: () => Promise<void>, tables: string[] } | null = null
  // The server-tail directive endpoint, when any table routed server-side.
  let serverEndpoint: string | null = null

  function patchProgress(p: Partial<AnalyzerProgress>): void {
    progress.value = { ...progress.value, ...p }
  }

  /** Call the file-resolution endpoint. */
  async function resolveFiles(signal: AbortSignal): Promise<FileResolutionResponse> {
    patchProgress({ phase: 'resolving' })
    const qs = new URLSearchParams({ searchType })
    if (range) {
      qs.set('start', range.start)
      qs.set('end', range.end)
    }
    // Hit the `__gsc` layer surface (session-backed, credentialed) on the
    // gscdump data origin — not a bare relative path, which would resolve
    // against the embedding app's own origin and 404.
    const apiBase = (useGscAnalyticsConfig().apiBase ?? '').replace(/\/+$/, '')
    return $fetch<FileResolutionResponse>(`${apiBase}/api/__gsc/sites/${siteId}/analysis-sources?${qs}`, {
      headers: { 'cache-control': 'no-cache' },
      credentials: 'include',
      signal,
    })
  }

  /** Apply a resolution response to `routing` + return the browser tables. */
  function applyResolution(res: FileResolutionResponse): ResolvedTable[] {
    snapshotVersion.value = res.snapshotVersion
    serverEndpoint = res.serverTail?.endpoint ?? null
    const nextRouting: AnalyzerTableRouting = {}
    for (const t of res.tables)
      nextRouting[t.table] = t.mode
    routing.value = nextRouting
    return res.tables.filter(t => t.mode === 'browser' && t.files.length > 0)
  }

  const boot = (async () => {
    const signal = lifetime.signal
    patchProgress({ phase: 'resolving', startedAt: Date.now() })

    const resolution = await resolveFiles(signal)
    const browserTables = applyResolution(resolution)

    // Fully server-tail-routed site — nothing to attach. Mark ready; queries
    // proxy to the server.
    if (browserTables.length === 0) {
      patchProgress({ phase: 'ready', endedAt: Date.now() })
      ready.value = true
      return
    }

    // ---- boot DuckDB-WASM -------------------------------------------------
    patchProgress({ phase: 'booting' })
    const cfg = useGscAnalyticsConfig()
    const bundleBase = cfg.duckdbBundleBase as string | undefined
    const { bootDuckDBWasm } = await import('@gscdump/engine-duckdb-wasm')
    db = await bootDuckDBWasm(bundleBase
      ? {
          bundles: {
            mvp: { mainModule: `${bundleBase}/duckdb-mvp.wasm`, mainWorker: `${bundleBase}/duckdb-browser-mvp.worker.js` },
            eh: { mainModule: `${bundleBase}/duckdb-eh.wasm`, mainWorker: `${bundleBase}/duckdb-browser-eh.worker.js` },
          },
        }
      : undefined)
    conn = db.conn

    // ---- download + attach OPFS parquet ----------------------------------
    const { attachOpfsParquetTables, estimateOpfsStorage, requestPersistentStorage } = await import('@gscdump/engine-duckdb-wasm')

    const persisted = await requestPersistentStorage()
    const est = await estimateOpfsStorage()
    storage.value = { persisted, degraded: false, usageBytes: est.usageBytes, quotaBytes: est.quotaBytes }

    const opfsTables = browserTables.map(t => ({
      table: t.table,
      files: t.files.map(f => ({
        url: f.url,
        bytes: f.bytes,
        contentHash: f.contentHash,
        rowCount: f.rowCount,
      })),
    }))
    const filesTotal = opfsTables.reduce((n, t) => n + t.files.length, 0)
    const bytesTotal = browserTables.reduce((n, t) => n + t.totalBytes, 0)
    patchProgress({ phase: 'downloading', filesTotal, bytesTotal, filesReady: 0, bytesReady: 0 })

    let filesReady = 0
    let bytesReady = 0
    const handle = await attachOpfsParquetTables({
      db: db.db as any,
      conn: conn as any,
      tables: opfsTables,
      schema: 'main',
      version: resolution.snapshotVersion,
      fetchInit: { credentials: 'same-origin' },
      fetchConcurrency: DEFAULT_ATTACH_FETCH_CONCURRENCY,
      signal,
      onFileProgress: (info: OpfsFileProgress) => {
        filesReady++
        bytesReady += info.bytes
        patchProgress({ phase: 'downloading', filesReady, bytesReady })
      },
    })
    attachedHandle = { detach: handle.detach, tables: handle.tables }

    patchProgress({ phase: 'attaching' })

    // A table that hit a quota error degrades to the server tail. Flip its
    // routing + mark storage degraded so the UI can warn.
    if (handle.degradedTables.length > 0) {
      const next = { ...routing.value }
      for (const t of handle.degradedTables)
        next[t] = 'server'
      routing.value = next
      storage.value = { ...storage.value, degraded: true }
    }

    const estAfter = await estimateOpfsStorage()
    storage.value = { ...storage.value, usageBytes: estAfter.usageBytes, quotaBytes: estAfter.quotaBytes }

    patchProgress({ phase: 'ready', endedAt: Date.now(), filesReady, bytesReady })
    ready.value = true
  })()
    .catch((e) => {
      const err = e instanceof Error ? e : new Error(String(e))
      error.value = err
      patchProgress({ phase: 'error', error: err.message, endedAt: Date.now() })
      throw err
    })
    .finally(() => {
      initializing.value = false
    })
  boot.catch(() => {})

  // ---- query routing -----------------------------------------------------

  async function runBrowserQuery<R extends ArchetypeResultRow>(
    q: ArchetypeQuery,
    signal?: AbortSignal,
  ): Promise<ArchetypeResult<R>> {
    const { compileArchetypeSql } = await import('@gscdump/engine-duckdb-wasm')
    const compiled = compileArchetypeSql(q)
    const t0 = performance.now()
    signal?.throwIfAborted()
    // DuckDB-WASM connection is not concurrency-safe; the shared connection is
    // serialized by callers running queries one-at-a-time here.
    let result: any
    if (compiled.params.length === 0) {
      result = await conn.query(compiled.sql)
    }
    else {
      const stmt = await conn.prepare(compiled.sql)
      try {
        result = await stmt.query(...compiled.params)
      }
      finally {
        await stmt.close()
      }
    }
    signal?.throwIfAborted()
    const rows = arrowToRows<R>(result)
    return {
      archetype: q.archetype,
      rows,
      source: 'browser',
      meta: { rowCount: rows.length, queryMs: performance.now() - t0 },
    }
  }

  async function runServerQuery<R extends ArchetypeResultRow>(
    q: ArchetypeQuery,
    where: 'server' | 'cloud',
    signal?: AbortSignal,
  ): Promise<ArchetypeResult<R>> {
    const t0 = performance.now()
    // Server tail: POST the archetype to the directive endpoint, or fall back
    // to the conventional per-site analysis endpoint when no directive exists.
    const endpoint = where === 'cloud'
      ? `/api/sites/${siteId}/archetype-query`
      : (serverEndpoint ?? `/api/sites/${siteId}/archetype-query`)
    const res = await $fetch<ArchetypeResult<R>>(endpoint, {
      method: 'POST',
      body: { siteId, query: q },
      signal,
    })
    // Trust the server's `source` when present; otherwise tag from routing.
    const source: ArchetypeResultSource = res.source
      ?? (where === 'cloud' ? 'cloud' : 'server-r2-sql')
    return {
      ...res,
      source,
      meta: { rowCount: res.rows?.length ?? 0, queryMs: performance.now() - t0, ...res.meta },
    }
  }

  async function query<R extends ArchetypeResultRow = ArchetypeResultRow>(
    q: ArchetypeQuery,
    opts?: { signal?: AbortSignal },
  ): Promise<ArchetypeResult<R>> {
    await boot
    opts?.signal?.throwIfAborted()

    // ---- result LRU — keyed by snapshotVersion + queryHash ----------------
    const cacheKey = resultCacheKey(snapshotVersion.value, q)
    const cached = resultLru.get(cacheKey)
    if (cached)
      return cached as ArchetypeResult<R>

    const { tableForArchetype } = await import('@gscdump/engine-duckdb-wasm')
    const where = routeArchetype(q, routing.value, tableForArchetype)

    let result: ArchetypeResult<R>
    if (where === 'browser' && conn) {
      result = await runBrowserQuery<R>(q, opts?.signal)
    }
    else {
      result = await runServerQuery<R>(q, where === 'cloud' ? 'cloud' : 'server', opts?.signal)
    }

    resultLru.set(cacheKey, result as ArchetypeResult)
    return result
  }

  async function refresh(): Promise<boolean> {
    await boot.catch(() => {})
    if (!db)
      return false // fully server-tail-routed — nothing to re-attach.
    const resolution = await resolveFiles(lifetime.signal)
    if (resolution.snapshotVersion === snapshotVersion.value)
      return false
    // Snapshot moved — detach the stale views, re-attach the fresher parquet.
    // The DuckDB-WASM runtime (db + conn) stays alive.
    const browserTables = applyResolution(resolution)
    await attachedHandle?.detach().catch((e) => {
      console.warn('[useGscSnapshotAnalyzer] detach during refresh failed', e)
    })
    attachedHandle = null
    resultLru.clear()
    if (browserTables.length === 0)
      return true
    const { attachOpfsParquetTables } = await import('@gscdump/engine-duckdb-wasm')
    const handle = await attachOpfsParquetTables({
      db: (db as any).db,
      conn: conn as any,
      tables: browserTables.map(t => ({
        table: t.table,
        files: t.files.map(f => ({ url: f.url, bytes: f.bytes, contentHash: f.contentHash, rowCount: f.rowCount })),
      })),
      schema: 'main',
      version: resolution.snapshotVersion,
      fetchInit: { credentials: 'same-origin' },
      fetchConcurrency: DEFAULT_ATTACH_FETCH_CONCURRENCY,
      signal: lifetime.signal,
    })
    attachedHandle = { detach: handle.detach, tables: handle.tables }
    if (handle.degradedTables.length > 0) {
      const next = { ...routing.value }
      for (const t of handle.degradedTables)
        next[t] = 'server'
      routing.value = next
      storage.value = { ...storage.value, degraded: true }
    }
    return true
  }

  function clearCache(): void {
    resultLru.clear()
  }

  async function dispose(): Promise<void> {
    lifetime.abort()
    await attachedHandle?.detach().catch((e) => {
      console.error('[useGscSnapshotAnalyzer] detach on dispose failed', e)
    })
    if (conn) {
      await conn.close().catch(() => {})
    }
    if (db && (db.db as any)?.terminate) {
      await (db.db as any).terminate().catch(() => {})
    }
    attachedHandle = null
    conn = null
    db = null
    resultLru.clear()
    ready.value = false
    routing.value = {}
  }

  return {
    ready,
    initializing,
    error,
    progress,
    storage,
    routing,
    snapshotVersion,
    currentSiteId,
    query,
    refresh,
    clearCache,
    dispose,
  }
}

/**
 * Convert an Apache Arrow result (DuckDB-WASM `conn.query` return) to plain
 * row objects. Kept local so the composable has no Arrow type dependency.
 */
function arrowToRows<R extends ArchetypeResultRow>(result: unknown): R[] {
  if (!result || typeof result !== 'object')
    return []
  const table = result as { toArray?: () => unknown[] }
  if (typeof table.toArray !== 'function')
    return []
  return table.toArray().map((row) => {
    // Arrow rows expose `toJSON()`; fall back to a shallow copy.
    const r = row as { toJSON?: () => Record<string, unknown> }
    const obj = typeof r.toJSON === 'function' ? r.toJSON() : { ...(row as Record<string, unknown>) }
    // Normalise BigInt (DuckDB SUM returns BigInt) to number for JSON safety.
    for (const k of Object.keys(obj)) {
      const v = obj[k]
      if (typeof v === 'bigint')
        obj[k] = Number(v)
    }
    return obj as R
  })
}

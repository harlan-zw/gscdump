// Per-site DuckDB-WASM analyzer over the Iceberg fact tables.
//
// One analyzer instance per `(siteId, searchType, range)`, cached on the
// NuxtApp so every subpage under `/sites/[id]/*` shares the same DuckDB boot
// + attached parquet. The site overview pays the cold cost once; tabbing
// across Queries / Pages / Countries / etc is essentially free — DuckDB has
// the data resident in memory and each tab just runs a different SQL query.
//
// Tables are attached LAZILY: the first call that needs `queries` triggers
// the parquet fetch for that table; sibling tabs reuse the attach. This
// keeps cold-tab latency low and avoids attaching parquet for tables a
// session never touches (`countries` if the user only looks at Queries).
//
// All 5 Iceberg fact tables follow the same shape:
//   pages           — url, date, clicks, impressions, sum_position
//   queries         — query, query_canonical, date, …metrics
//   countries       — country, date, …metrics
//   dates           — date, …metrics + anonymized_impressions_pct + 9-col device pivot
//   page_queries    — url, query, query_canonical, date, …metrics

import type { AsyncDuckDB, AsyncDuckDBConnection } from '@duckdb/duckdb-wasm'
import type { FileResolutionResponse } from '@gscdump/contracts'
import type { OpfsAttachedHandle } from '@gscdump/engine-duckdb-wasm'
import { useGscFetch } from '#imports'

export type GscFactTable = 'pages' | 'queries' | 'countries' | 'dates' | 'page_queries'

export type GscTableStage = 'idle' | 'resolving' | 'downloading' | 'attaching' | 'ready' | 'error' | 'unavailable'

export interface GscTableStatus {
  stage: GscTableStage
  filesAttached: number
  filesTotal: number
  startedAt?: number
  endedAt?: number
  error?: string
}

export interface UseGscSiteAnalyzerReturn {
  /** Per-table stage + file counts. `<GscBootProgress />` reads from the layer-wide map (we mirror there); this is the local view for in-page hints. */
  tables: Readonly<Ref<Record<GscFactTable, GscTableStatus>>>
  /** True once DuckDB-WASM has booted. Queries can dispatch as soon as the table they need is in `'ready'`. */
  ready: Readonly<Ref<boolean>>
  /** First fatal error (boot or any table). Per-table errors land on `tables[<name>].error`. */
  error: Readonly<Ref<Error | null>>
  /**
   * Run SQL against the attached tables. Awaits the requested tables' attach,
   * triggering on-demand attach if they haven't been started yet.
   */
  query: <T = Record<string, unknown>>(opts: { sql: string, needs: readonly GscFactTable[], params?: readonly unknown[] }) => Promise<T[]>
}

interface BootedAnalyzer {
  /** Inert proxy used until the real DuckDB-WASM boots. */
  bootPromise: Promise<{ db: AsyncDuckDB, conn: AsyncDuckDBConnection }>
  /** Latched once attach has been started for a table; resolves when the table is queryable. */
  tablePromises: Map<GscFactTable, Promise<void>>
  /** Reactive per-table status (mirrored to the layer-wide progress map). */
  tables: Ref<Record<GscFactTable, GscTableStatus>>
  ready: Ref<boolean>
  error: Ref<Error | null>
  /** Held mutex around DuckDB DDL/query calls — WASM DuckDB is single-connection. */
  withDb: <T>(fn: (conn: AsyncDuckDBConnection) => Promise<T>) => Promise<T>
  /** Per-instance refcount — bumped on every consumer hookup, decremented on dispose. */
  refs: number
  /** Cleanup; called when refs hits 0. */
  dispose: () => Promise<void>
}

const ALL_TABLES: readonly GscFactTable[] = ['pages', 'queries', 'countries', 'dates', 'page_queries'] as const

function sqlIdent(s: string): string {
  return s.replace(/\W/g, '_')
}

function emptyStatus(): GscTableStatus {
  return { stage: 'idle', filesAttached: 0, filesTotal: 0 }
}

function emptyTables(): Record<GscFactTable, GscTableStatus> {
  return Object.fromEntries(ALL_TABLES.map(t => [t, emptyStatus()])) as Record<GscFactTable, GscTableStatus>
}

// Per-NuxtApp instance cache keyed by `siteId|searchType|start|end`. WeakMap
// against the NuxtApp so SSR isolation holds (each request gets its own cache)
// and client-side instances live as long as the app does.
const instanceCaches = new WeakMap<object, Map<string, BootedAnalyzer>>()

function getCache(): Map<string, BootedAnalyzer> {
  const app = useNuxtApp()
  let bag = instanceCaches.get(app)
  if (!bag) {
    bag = new Map()
    instanceCaches.set(app, bag)
  }
  return bag
}

function instanceKey(siteId: string, searchType: string, range: { start: string, end: string }): string {
  return `${siteId}|${searchType}|${range.start}|${range.end}`
}

export function useGscSiteAnalyzer(
  siteId: MaybeRefOrGetter<string | null | undefined>,
  range: MaybeRefOrGetter<{ start: string, end: string } | null | undefined>,
  options: { searchType?: 'web' | 'image' | 'video' | 'news' | 'discover' | 'googleNews', useOpfsCache?: boolean } = {},
): UseGscSiteAnalyzerReturn {
  const searchType = options.searchType ?? 'web'
  const useOpfsCache = options.useOpfsCache ?? true

  // The reactive return shape — proxies the currently-selected instance.
  // We rebind every time the key changes (e.g. range moves outside the
  // cached attach window).
  const tables = ref<Record<GscFactTable, GscTableStatus>>(emptyTables())
  const ready = ref(false)
  const error = ref<Error | null>(null)
  let active: BootedAnalyzer | null = null

  function bind(instance: BootedAnalyzer | null) {
    // Release the previous instance's refcount; pick up the new one. Skipping
    // shutdown on rebind means tab navigation never tears DuckDB down — the
    // instance lives until every consumer unmounts and the cache drops it.
    const prev = active
    active = instance
    if (instance) {
      instance.refs++
      tables.value = instance.tables.value
      ready.value = instance.ready.value
      error.value = instance.error.value
      // Re-link reactive refs to the live instance.
      watchEffect(() => { tables.value = instance.tables.value })
      watchEffect(() => { ready.value = instance.ready.value })
      watchEffect(() => { error.value = instance.error.value })
    }
    else {
      tables.value = emptyTables()
      ready.value = false
      error.value = null
    }
    if (prev) {
      prev.refs--
      if (prev.refs <= 0)
        prev.dispose().catch(() => {})
    }
  }

  function obtain(sid: string, r: { start: string, end: string }): BootedAnalyzer {
    const cache = getCache()
    const key = instanceKey(sid, searchType, r)
    const hit = cache.get(key)
    if (hit)
      return hit
    const created = createAnalyzer({ siteId: sid, searchType, range: r, useOpfsCache })
    cache.set(key, created)
    return created
  }

  watch(
    () => {
      const sid = toValue(siteId) ?? null
      const r = toValue(range) ?? null
      return sid && r?.start && r?.end ? { sid, r } : null
    },
    (val) => {
      if (!val || !import.meta.client) {
        bind(null)
        return
      }
      bind(obtain(val.sid, val.r))
    },
    { immediate: true },
  )

  onScopeDispose(() => bind(null))

  async function query<T = Record<string, unknown>>(opts: { sql: string, needs: readonly GscFactTable[], params?: readonly unknown[] }): Promise<T[]> {
    if (!active)
      throw new Error('useGscSiteAnalyzer: no active instance (site/range not set)')
    const instance = active
    await instance.bootPromise
    // Kick off (or join) per-table attaches for every table the query needs.
    await Promise.all(opts.needs.map(t => ensureTable(instance, t)))
    return instance.withDb(async (conn) => {
      const result = opts.params && opts.params.length > 0
        ? await (async () => {
            const stmt = await conn.prepare(opts.sql)
            try { return await stmt.query(...(opts.params as unknown[])) }
            finally { await stmt.close() }
          })()
        : await conn.query(opts.sql)
      // Apache Arrow returns `Proxy(StructRow)` rows — Vue's reactivity
      // can't make those reactive (the Arrow proxy's `isExtensible` trap
      // throws a TypeError when the reactive proxy probes it). Materialise
      // into plain objects at the seam so every consumer is free to assign
      // results directly into a `ref`/`reactive` without surprise.
      const arr = result.toArray() as unknown as Array<Record<string, unknown>>
      return arr.map(row => ({ ...row })) as unknown as T[]
    })
  }

  return {
    tables: tables as Readonly<Ref<Record<GscFactTable, GscTableStatus>>>,
    ready: ready as Readonly<Ref<boolean>>,
    error: error as Readonly<Ref<Error | null>>,
    query,
  }
}

// ── implementation ──────────────────────────────────────────────────────────

interface AnalyzerArgs {
  siteId: string
  searchType: string
  range: { start: string, end: string }
}

function createAnalyzer(args: AnalyzerArgs): BootedAnalyzer {
  const tables = ref<Record<GscFactTable, GscTableStatus>>(emptyTables())
  const ready = ref(false)
  const error = ref<Error | null>(null)
  const tablePromises = new Map<GscFactTable, Promise<void>>()

  // Pin the configured fetcher + analytics config at construction — these
  // need a NuxtApp context, which is available here (the composable's
  // setup) but not inside the async work spawned below.
  const $gscFetch = useGscFetch()
  const analyticsConfig = useGscAnalyticsConfig()
  const analyticsCtx = useGscAnalyticsContext()
  const apiBase = (analyticsConfig.apiBase ?? '').replace(/\/+$/, '')

  // Single resolve call — `analysis-sources` already returns all 5 tables
  // for a given site+range, so we hit it once and demux per-table later.
  let resolvePromise: Promise<FileResolutionResponse | null> | null = null
  function getResolution(): Promise<FileResolutionResponse | null> {
    if (resolvePromise)
      return resolvePromise
    const qs = `searchType=${args.searchType}&start=${args.range.start}&end=${args.range.end}`
    resolvePromise = $gscFetch<FileResolutionResponse | { canUseBrowser?: false }>(
      `${apiBase}/api/__gsc/sites/${args.siteId}/analysis-sources?${qs}`,
    )
      .then((res) => {
        if (!res || (res as { canUseBrowser?: boolean }).canUseBrowser === false)
          return null
        return res as FileResolutionResponse
      })
      .catch(() => null)
    return resolvePromise
  }

  // Boot DuckDB-WASM up front — the resolve and the WASM bundle download in
  // parallel, so by the time a query asks for a table, the DB is ready.
  const bootPromise: Promise<{ db: AsyncDuckDB, conn: AsyncDuckDBConnection }> = (async () => {
    const { bootDuckDBWasm } = await import('@gscdump/engine-duckdb-wasm')
    const bundleBase = (analyticsConfig as { duckdbBundleBase?: string }).duckdbBundleBase
    const boot = await bootDuckDBWasm({
      ...(bundleBase
        ? {
            bundles: {
              mvp: { mainModule: `${bundleBase}/duckdb-mvp.wasm`, mainWorker: `${bundleBase}/duckdb-browser-mvp.worker.js` },
              eh: { mainModule: `${bundleBase}/duckdb-eh.wasm`, mainWorker: `${bundleBase}/duckdb-browser-eh.worker.js` },
            },
          }
        : {}),
      // Same Workers-strips-Content-Length workaround as the home-page composable.
      config: { filesystem: { reliableHeadRequests: false, allowFullHTTPReads: true } },
    })
    ready.value = true
    return boot
  })()
  bootPromise.catch((err) => {
    error.value = err instanceof Error ? err : new Error(String(err))
  })

  // DuckDB-WASM single-connection mutex — DDL and queries serialise; downloads
  // run free in parallel outside the lock.
  let dbLock: Promise<unknown> = Promise.resolve()
  function withDb<T>(fn: (conn: AsyncDuckDBConnection) => Promise<T>): Promise<T> {
    const next = dbLock.then(async () => {
      const { conn } = await bootPromise
      return fn(conn)
    })
    dbLock = next.catch(() => {})
    return next
  }

  // Per-table attach kicker. Stores its promise so concurrent callers join
  // the same in-flight work; the layer-wide `patchProgress` map is updated
  // as each phase advances so `<GscBootProgress />` shows the site's table
  // load alongside other sites.
  function patchSelf(table: GscFactTable, patch: Partial<GscTableStatus>) {
    tables.value = { ...tables.value, [table]: { ...tables.value[table], ...patch } }
  }
  function patchLayer(table: GscFactTable, stage: GscTableStage, extras: Partial<GscTableStatus> = {}) {
    // Reuse the layer's SiteLoadProgress shape, namespacing by table so
    // multiple tables for the same site don't collide on the boot bar.
    const siteSlot = `${args.siteId}#${table}`
    const layerStage = stage === 'unavailable' ? 'ready' : stage === 'downloading' || stage === 'attaching' ? 'attach' : stage === 'resolving' ? 'manifest' : stage === 'ready' ? 'ready' : stage === 'error' ? 'error' : 'idle'
    analyticsCtx.patchProgress(siteSlot, {
      stage: layerStage as never,
      source: 'duckdb',
      filesAttached: extras.filesAttached ?? tables.value[table].filesAttached,
      filesTotal: extras.filesTotal ?? tables.value[table].filesTotal,
      startedAt: extras.startedAt ?? tables.value[table].startedAt ?? Date.now(),
      endedAt: extras.endedAt,
      error: extras.error,
    })
  }

  async function attachTable(table: GscFactTable): Promise<void> {
    const startedAt = Date.now()
    patchSelf(table, { stage: 'resolving', startedAt, endedAt: undefined, error: undefined })
    patchLayer(table, 'resolving', { startedAt })

    const full = await getResolution()
    if (!full) {
      patchSelf(table, { stage: 'unavailable', endedAt: Date.now() })
      patchLayer(table, 'unavailable', { endedAt: Date.now() })
      return
    }
    const tableEntry = full.tables.find(t => t.table === table)
    const urls = tableEntry?.mode === 'browser' ? tableEntry.files.map(f => f.url) : []
    if (urls.length === 0) {
      patchSelf(table, { stage: 'unavailable', endedAt: Date.now() })
      patchLayer(table, 'unavailable', { endedAt: Date.now() })
      return
    }

    patchSelf(table, { stage: 'downloading', filesTotal: urls.length })
    patchLayer(table, 'downloading', { filesTotal: urls.length })

    // Parallel fetches; tick on each completion so progress bars climb.
    let filesAttached = 0
    const buffers = await Promise.all(urls.map(async (url) => {
      const r = await fetch(url, { credentials: 'omit' })
      if (!r.ok)
        throw new Error(`GET ${url} failed: ${r.status}`)
      const buf = new Uint8Array(await r.arrayBuffer())
      filesAttached++
      patchSelf(table, { filesAttached })
      patchLayer(table, 'downloading', { filesAttached })
      return buf
    })).catch((err) => {
      patchSelf(table, { stage: 'error', error: err instanceof Error ? err.message : String(err), endedAt: Date.now() })
      patchLayer(table, 'error', { error: err instanceof Error ? err.message : String(err), endedAt: Date.now() })
      throw err
    })

    patchSelf(table, { stage: 'attaching' })
    patchLayer(table, 'attaching')

    const sid = sqlIdent(args.siteId)
    const tableIdent = sqlIdent(table)
    const fileNames = buffers.map((_, i) => `${tableIdent}_${sid}_${i}.parquet`)
    await withDb(async (conn) => {
      const { db } = await bootPromise
      for (let i = 0; i < buffers.length; i++)
        await db.registerFileBuffer(fileNames[i]!, buffers[i]!)
      const fileList = fileNames.map(n => `'${n.replace(/'/g, '\'\'')}'`).join(',')
      // Cast `date` to DATE at scan-time to canonicalise the legacy-VARCHAR /
      // new-DATE encodings (same as engine-duckdb-wasm's read_parquet view).
      await conn.query(`CREATE OR REPLACE VIEW ${tableIdent} AS SELECT * REPLACE (CAST(date AS DATE) AS date) FROM read_parquet([${fileList}], union_by_name = true)`)
    })

    patchSelf(table, { stage: 'ready', endedAt: Date.now() })
    patchLayer(table, 'ready', { endedAt: Date.now() })
  }

  function ensureTableInner(table: GscFactTable): Promise<void> {
    const existing = tablePromises.get(table)
    if (existing)
      return existing
    const p = attachTable(table)
    tablePromises.set(table, p)
    return p
  }

  // Expose `ensureTable` to the outer composable via a captured closure.
  // (Plain function refs would also work; this just keeps the public API in
  // one place by storing on the analyzer record.)
  ;(globalThis as { __gscEnsureTable?: typeof ensureTableInner }).__gscEnsureTable = ensureTableInner

  const instance: BootedAnalyzer = {
    bootPromise,
    tablePromises,
    tables,
    ready,
    error,
    withDb,
    refs: 0,
    dispose: async () => {
      // Pull the cache entry first so subsequent obtains create a fresh one
      // (we can't dispose mid-attach without leaking promises).
      const cache = instanceCaches.get(useNuxtApp())
      if (cache) {
        for (const [k, v] of cache.entries()) {
          if (v === instance) {
            cache.delete(k)
            break
          }
        }
      }
      try {
        const { db } = await bootPromise
        await db.terminate()
      }
      catch {
        // Boot failed — nothing to tear down.
      }
    },
  }
  // Attach the ensureTable closure to the instance so the outer composable
  // can reach it without a globalThis hack.
  ;(instance as BootedAnalyzer & { ensureTable: typeof ensureTableInner }).ensureTable = ensureTableInner
  return instance
}

async function ensureTable(instance: BootedAnalyzer, table: GscFactTable): Promise<void> {
  const ensure = (instance as BootedAnalyzer & { ensureTable: (t: GscFactTable) => Promise<void> }).ensureTable
  return ensure(table)
}

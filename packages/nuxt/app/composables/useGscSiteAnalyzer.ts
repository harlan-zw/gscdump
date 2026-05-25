// Per-site DuckDB-WASM analyzer over the hosted Iceberg fact tables.
//
// The module owns the browser runtime lifecycle: resolve analysis sources,
// boot shared DuckDB-WASM, attach parquet tables on demand, mirror progress
// into the layer-wide map, and materialise Arrow rows into plain objects.
// Callers keep ownership of SQL, presentation, and page-specific state.

import type { AsyncDuckDB, AsyncDuckDBConnection } from '@duckdb/duckdb-wasm'
import type { FileResolutionResponse } from '@gscdump/contracts'
import type { OpfsAttachedHandle } from '@gscdump/engine-duckdb-wasm'
import type { AnalysisParams, AnalysisResult } from '@gscdump/engine/analysis-types'
import { defaultAnalyzerRegistry } from '@gscdump/analysis'
import { runAnalyzerFromSource } from '@gscdump/engine/analyzer'
import { createAttachedTableSource } from '@gscdump/engine/source'
import { gscQueries } from '../queries/gsc'
import { attachParquetWithFallback, sharedGscDuckDBWasm } from '../utils/duckdb-wasm'
import { useGscRpc } from '../utils/gsc-rpc'

export type GscFactTable
  = | 'pages'
    | 'queries'
    | 'countries'
    | 'dates'
    | 'page_queries'
    | 'search_appearance'
    | 'search_appearance_pages'
    | 'search_appearance_queries'
    | 'search_appearance_page_queries'

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
  tables: Readonly<Ref<Record<GscFactTable, GscTableStatus>>>
  ready: Readonly<Ref<boolean>>
  error: Readonly<Ref<Error | null>>
  query: <T = Record<string, unknown>>(opts: {
    sql: string
    needs: readonly GscFactTable[]
    params?: readonly unknown[]
  }) => Promise<T[]>
  runQuery: <T = Record<string, unknown>>(sql: string, params?: readonly unknown[]) => Promise<{ rows: T[], queryMs: number }>
  analyze: (params: AnalysisParams, opts?: { signal?: AbortSignal }) => Promise<AnalysisResult & { queryMs: number }>
}

interface BootedAnalyzer {
  bootPromise: Promise<{ db: AsyncDuckDB, conn: AsyncDuckDBConnection }>
  tablePromises: Map<GscFactTable, Promise<void>>
  tables: Ref<Record<GscFactTable, GscTableStatus>>
  ready: Ref<boolean>
  error: Ref<Error | null>
  withDb: <T>(fn: (conn: AsyncDuckDBConnection) => Promise<T>) => Promise<T>
  refs: number
  dispose: () => Promise<void>
}

interface AnalyzerArgs {
  siteId: string
  searchType: string
  range: { start: string, end: string }
  useOpfsCache: boolean
}

const ALL_TABLES: readonly GscFactTable[] = [
  'pages',
  'queries',
  'countries',
  'dates',
  'page_queries',
  'search_appearance',
  'search_appearance_pages',
  'search_appearance_queries',
  'search_appearance_page_queries',
] as const

const FACT_TABLE_NAMES = ALL_TABLES.join('|')
const TABLE_RE = new RegExp(`\\b(?:FROM|JOIN)\\s+(?:main\\.)?(${FACT_TABLE_NAMES})\\b`, 'gi')
const instanceCaches = new WeakMap<object, Map<string, BootedAnalyzer>>()

function tablesFromSql(sql: string): readonly GscFactTable[] {
  const out = new Set<GscFactTable>()
  for (const m of sql.matchAll(TABLE_RE))
    out.add(m[1]!.toLowerCase() as GscFactTable)
  return out.size > 0 ? Array.from(out) : ALL_TABLES
}

function sqlIdent(s: string): string {
  return s.replace(/\W/g, '_')
}

function emptyStatus(): GscTableStatus {
  return { stage: 'idle', filesAttached: 0, filesTotal: 0 }
}

function emptyTables(): Record<GscFactTable, GscTableStatus> {
  return Object.fromEntries(ALL_TABLES.map(t => [t, emptyStatus()])) as Record<GscFactTable, GscTableStatus>
}

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
  options: {
    searchType?: 'web' | 'image' | 'video' | 'news' | 'discover' | 'googleNews'
    useOpfsCache?: boolean
  } = {},
): UseGscSiteAnalyzerReturn {
  const searchType = options.searchType ?? 'web'
  const useOpfsCache = options.useOpfsCache ?? true
  const tables = ref<Record<GscFactTable, GscTableStatus>>(emptyTables())
  const ready = ref(false)
  const error = ref<Error | null>(null)
  let active: BootedAnalyzer | null = null
  let stopEffects: (() => void) | null = null

  function bind(instance: BootedAnalyzer | null): void {
    const prev = active
    stopEffects?.()
    stopEffects = null
    active = instance

    if (instance) {
      instance.refs++
      const scope = effectScope()
      scope.run(() => {
        watchEffect(() => {
          tables.value = instance.tables.value
        })
        watchEffect(() => {
          ready.value = instance.ready.value
        })
        watchEffect(() => {
          error.value = instance.error.value
        })
      })
      stopEffects = () => scope.stop()
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

  async function query<T = Record<string, unknown>>(opts: {
    sql: string
    needs: readonly GscFactTable[]
    params?: readonly unknown[]
  }): Promise<T[]> {
    if (!active)
      throw new Error('useGscSiteAnalyzer: no active instance (site/range not set)')
    const instance = active
    await instance.bootPromise
    await Promise.all(opts.needs.map(t => ensureTable(instance, t)))
    return instance.withDb(async (conn) => {
      const result = opts.params && opts.params.length > 0
        ? await (async () => {
            const stmt = await conn.prepare(opts.sql)
            try {
              return await stmt.query(...(opts.params as unknown[]))
            }
            finally {
              await stmt.close()
            }
          })()
        : await conn.query(opts.sql)
      const arr = result.toArray() as unknown as Array<Record<string, unknown>>
      return arr.map(row => ({ ...row })) as unknown as T[]
    })
  }

  async function runQuery<T = Record<string, unknown>>(sql: string, params?: readonly unknown[]): Promise<{ rows: T[], queryMs: number }> {
    const t0 = performance.now()
    const rows = await query<T>({ sql, needs: tablesFromSql(sql), params })
    return { rows, queryMs: performance.now() - t0 }
  }

  async function analyze(params: AnalysisParams, opts?: { signal?: AbortSignal }): Promise<AnalysisResult & { queryMs: number }> {
    const t0 = performance.now()
    const source = createAttachedTableSource(
      {
        query: async (sql, bindParams) => {
          return query<Record<string, unknown>>({ sql, needs: tablesFromSql(sql), params: bindParams })
        },
      },
      {
        schema: 'main',
        signal: opts?.signal,
        attachedTables: ALL_TABLES as readonly string[],
      },
    )
    const result = await runAnalyzerFromSource(source, params, defaultAnalyzerRegistry)
    return {
      results: result.results as AnalysisResult['results'],
      meta: result.meta as AnalysisResult['meta'],
      queryMs: performance.now() - t0,
    }
  }

  return {
    tables: tables as Readonly<Ref<Record<GscFactTable, GscTableStatus>>>,
    ready: ready as Readonly<Ref<boolean>>,
    error: error as Readonly<Ref<Error | null>>,
    query,
    runQuery,
    analyze,
  }
}

function createAnalyzer(args: AnalyzerArgs): BootedAnalyzer {
  const tables = ref<Record<GscFactTable, GscTableStatus>>(emptyTables())
  const ready = ref(false)
  const error = ref<Error | null>(null)
  const tablePromises = new Map<GscFactTable, Promise<void>>()
  const opfsHandles = new Map<GscFactTable, OpfsAttachedHandle>()

  const rpc = useGscRpc()
  const analyticsConfig = useGscAnalyticsConfig()
  const analyticsCtx = useGscAnalyticsContext()

  let resolvePromise: Promise<FileResolutionResponse | null> | null = null
  function getResolution(): Promise<FileResolutionResponse | null> {
    if (resolvePromise)
      return resolvePromise
    resolvePromise = rpc.query(
      gscQueries.analysisSources(args.siteId, undefined, {
        searchType: args.searchType as 'web' | 'image' | 'video' | 'news' | 'discover' | 'googleNews',
        start: args.range.start,
        end: args.range.end,
      }),
      { silent: true },
    )
      .then((res) => {
        if (!res || (res as { canUseBrowser?: boolean }).canUseBrowser === false)
          return null
        return res as unknown as FileResolutionResponse
      })
      .catch(() => null)
    return resolvePromise
  }

  const bootPromise: Promise<{ db: AsyncDuckDB, conn: AsyncDuckDBConnection }> = (async () => {
    const bundleBase = (analyticsConfig as { duckdbBundleBase?: string }).duckdbBundleBase
    const boot = await sharedGscDuckDBWasm(bundleBase)
    ready.value = true
    return boot
  })()
  bootPromise.catch((err) => {
    error.value = err instanceof Error ? err : new Error(String(err))
  })

  let dbLock: Promise<unknown> = Promise.resolve()
  function withDb<T>(fn: (conn: AsyncDuckDBConnection) => Promise<T>): Promise<T> {
    const next = dbLock.then(async () => {
      const { conn } = await bootPromise
      return fn(conn)
    })
    dbLock = next.catch(() => {})
    return next
  }

  function patchSelf(table: GscFactTable, patch: Partial<GscTableStatus>): void {
    tables.value = { ...tables.value, [table]: { ...tables.value[table], ...patch } }
  }

  function patchLayer(table: GscFactTable, stage: GscTableStage, extras: Partial<GscTableStatus> = {}): void {
    const siteSlot = `${args.siteId}#${table}`
    const layerStage = stage === 'unavailable'
      ? 'ready'
      : stage === 'downloading' || stage === 'attaching'
        ? 'attach'
        : stage === 'resolving'
          ? 'manifest'
          : stage === 'ready'
            ? 'ready'
            : stage === 'error' ? 'error' : 'idle'
    analyticsCtx.patchProgress(siteSlot, {
      stage: layerStage,
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
      const endedAt = Date.now()
      patchSelf(table, { stage: 'unavailable', endedAt })
      patchLayer(table, 'unavailable', { endedAt })
      return
    }

    const tableEntry = full.tables.find(t => t.table === table)
    const browserFiles = tableEntry?.mode === 'browser' ? tableEntry.files : []
    if (browserFiles.length === 0) {
      const endedAt = Date.now()
      patchSelf(table, { stage: 'unavailable', endedAt })
      patchLayer(table, 'unavailable', { endedAt })
      return
    }

    patchSelf(table, { stage: 'downloading', filesTotal: browserFiles.length })
    patchLayer(table, 'downloading', { filesTotal: browserFiles.length })

    const sid = sqlIdent(args.siteId)
    const tableIdent = sqlIdent(table)
    const viewName = `${tableIdent}_${sid}`
    let filesAttached = 0
    const { db, conn } = await bootPromise
    const opfsHandle = await attachParquetWithFallback({
      db,
      conn,
      viewName,
      files: browserFiles,
      version: full.snapshotVersion,
      useOpfsCache: args.useOpfsCache,
      withDb: fn => withDb(() => fn()),
      onFileProgress: () => {
        filesAttached++
        patchSelf(table, { filesAttached })
        patchLayer(table, 'downloading', { filesAttached })
      },
    }).catch((err) => {
      const msg = err instanceof Error ? err.message : String(err)
      const endedAt = Date.now()
      patchSelf(table, { stage: 'error', error: msg, endedAt })
      patchLayer(table, 'error', { error: msg, endedAt })
      throw err
    })

    if (viewName !== tableIdent) {
      await withDb(async (conn) => {
        await conn.query(`CREATE OR REPLACE VIEW ${tableIdent} AS SELECT * FROM ${viewName}`)
      })
    }

    if (opfsHandle)
      opfsHandles.set(table, opfsHandle)

    const endedAt = Date.now()
    patchSelf(table, { stage: 'ready', endedAt })
    patchLayer(table, 'ready', { endedAt })
  }

  function ensureTableInner(table: GscFactTable): Promise<void> {
    const existing = tablePromises.get(table)
    if (existing)
      return existing
    const p = attachTable(table)
    tablePromises.set(table, p)
    return p
  }

  const instance: BootedAnalyzer = {
    bootPromise,
    tablePromises,
    tables,
    ready,
    error,
    withDb,
    refs: 0,
    dispose: async () => {
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
        for (const h of opfsHandles.values())
          await h.detach().catch(() => {})
        opfsHandles.clear()
        const { conn } = await bootPromise
        for (const t of ALL_TABLES)
          await conn.query(`DROP VIEW IF EXISTS ${sqlIdent(t)}`).catch(() => {})
      }
      catch {
        // Boot failed; nothing to tear down.
      }
    },
  }
  ;(instance as BootedAnalyzer & { ensureTable: typeof ensureTableInner }).ensureTable = ensureTableInner
  return instance
}

async function ensureTable(instance: BootedAnalyzer, table: GscFactTable): Promise<void> {
  const ensure = (instance as BootedAnalyzer & { ensureTable: (t: GscFactTable) => Promise<void> }).ensureTable
  return ensure(table)
}

import type { AsyncDuckDB, AsyncDuckDBConnection, DuckDBBundles } from '@duckdb/duckdb-wasm'
import type { AnalysisParams, AnalysisResult } from '@gscdump/analysis'

import { analyzeInBrowser } from '@gscdump/engine-duckdb-node'

export interface QueryResult {
  rows: Record<string, unknown>[]
  queryMs: number
}

export interface AnalyzeResult {
  results: Record<string, unknown>[]
  meta: Record<string, unknown>
  queryMs: number
}

export interface DuckDBWasmBootResult {
  db: AsyncDuckDB
  conn: AsyncDuckDBConnection
}

export interface BootDuckDBWasmOptions {
  logger?: unknown
  /**
   * Override the jsDelivr-hosted bundle map. Required in environments where
   * the default CDN is unreachable or where hosts must serve the WASM +
   * worker assets themselves (e.g. Cloudflare Workers' 25 MB per-asset cap).
   */
  bundles?: DuckDBBundles
}

export interface BrowserParquetFile {
  bytes: Uint8Array
  name?: string
}

export interface BrowserParquetTable {
  table: string
  files: BrowserParquetFile[]
}

export interface BrowserParquetUrlTable {
  table: string
  urls: string[]
}

export interface AttachParquetTablesOptions {
  db: AsyncDuckDB
  conn: AsyncDuckDBConnection
  tables: BrowserParquetTable[]
  schema?: string
}

export interface AttachParquetUrlTablesOptions {
  db: AsyncDuckDB
  conn: AsyncDuckDBConnection
  tables: BrowserParquetUrlTable[]
  fetch?: typeof fetch
  schema?: string
  fetchInit?: RequestInit
  /**
   * Manifest version the caller associates with this set of URLs. Returned
   * on the resulting handle so callers can compare against a fresh manifest
   * probe without re-attaching. Purely advisory — the runtime never derives
   * behavior from the value itself.
   */
  version?: number | string
}

export interface AttachSingleTableOptions {
  db: AsyncDuckDB
  conn: AsyncDuckDBConnection
  table: string
  urls: string[]
  fetch?: typeof fetch
  schema?: string
  fetchInit?: RequestInit
}

/**
 * Handle returned from {@link attachParquetUrlTables}. Lets callers detach
 * the created views (for lazy re-attach on a new manifest version) or cheap-
 * check the embedded version against a fresh probe.
 */
export interface AttachedTablesHandle {
  version: number | string | undefined
  tables: string[]
  schema: string
  detach: () => Promise<void>
}

export interface BrowserAnalysisRuntime {
  db: AsyncDuckDB
  conn: AsyncDuckDBConnection
  query: (sql: string, params?: unknown[], signal?: AbortSignal) => Promise<QueryResult>
  analyze: (params: AnalysisParams, options?: { signal?: AbortSignal }) => Promise<AnalyzeResult>
  /**
   * Returns true when `expected` doesn't match the version the runtime was
   * attached with — cheap check callers can run before each query to decide
   * whether to detach + re-attach against a fresher manifest. Undefined
   * values on either side compare equal so the no-version path is a no-op.
   */
  isStale: (expected: number | string | undefined) => boolean
  /** Update the runtime's cached manifest version in-place (e.g. after a re-attach). */
  setVersion: (version: number | string | undefined) => void
  close: () => Promise<void>
}

interface ArrowLikeRow {
  toJSON?: () => Record<string, unknown>
}

interface ArrowLikeTable {
  toArray: () => ArrowLikeRow[]
}

function escapeSqlString(value: string): string {
  return value.replace(/'/g, '\'\'')
}

function toRows(result: unknown): Record<string, unknown>[] {
  return (result as ArrowLikeTable)
    .toArray()
    .map((row) => {
      if (typeof row.toJSON === 'function')
        return row.toJSON()
      return row as Record<string, unknown>
    })
}

function fileName(table: string, index: number, provided?: string): string {
  return provided ?? `${table}_${index}.parquet`
}

function readParquetViewSql(schema: string, table: string, files: string[]): string {
  const escaped = files.map(name => `'${escapeSqlString(name)}'`).join(', ')
  return `CREATE OR REPLACE VIEW ${schema}.${table} AS SELECT * FROM read_parquet([${escaped}], union_by_name = true)`
}

/**
 * Build a `DuckDBBundles` map from a single base URL hosting the standard
 * DuckDB-WASM asset set (matches the names jsDelivr + `@duckdb/duckdb-wasm`
 * ship). Callers pointing at a Worker / R2 / self-hosted origin can pass
 * just the origin instead of duplicating the URL layout across apps.
 *
 * Omits `coi` (pthread) by default; most hosts don't serve the
 * cross-origin-isolation headers needed to use it and requesting a missing
 * asset fails bundle selection on Safari/Firefox.
 */
export function createDuckDBBundlesFromBase(baseUrl: string, options: { includeCoi?: boolean } = {}): DuckDBBundles {
  const base = baseUrl.replace(/\/+$/, '')
  const bundles: DuckDBBundles = {
    mvp: {
      mainModule: `${base}/duckdb-mvp.wasm`,
      mainWorker: `${base}/duckdb-browser-mvp.worker.js`,
    },
    eh: {
      mainModule: `${base}/duckdb-eh.wasm`,
      mainWorker: `${base}/duckdb-browser-eh.worker.js`,
    },
  }
  if (options.includeCoi) {
    bundles.coi = {
      mainModule: `${base}/duckdb-coi.wasm`,
      mainWorker: `${base}/duckdb-browser-coi.worker.js`,
      pthreadWorker: `${base}/duckdb-browser-coi.pthread.worker.js`,
    }
  }
  return bundles
}

export async function bootDuckDBWasm(
  options: BootDuckDBWasmOptions = {},
): Promise<DuckDBWasmBootResult> {
  const { getJsDelivrBundles, selectBundle, AsyncDuckDB, ConsoleLogger } = await import('@duckdb/duckdb-wasm')
  const bundles = options.bundles ?? getJsDelivrBundles()
  const bundle = await selectBundle(bundles)
  const workerUrl = URL.createObjectURL(
    new Blob([`importScripts("${bundle.mainWorker!}");`], { type: 'text/javascript' }),
  )
  const worker = new Worker(workerUrl)
  const db = new AsyncDuckDB((options.logger as any) ?? new ConsoleLogger(), worker)
  await db.instantiate(bundle.mainModule, bundle.pthreadWorker)
  URL.revokeObjectURL(workerUrl)
  const conn = await db.connect()
  return { db, conn }
}

export async function attachParquetTables(
  options: AttachParquetTablesOptions,
): Promise<void> {
  const { db, conn, tables, schema = 'main' } = options
  for (const table of tables) {
    const names: string[] = []
    for (let i = 0; i < table.files.length; i++) {
      const file = table.files[i]!
      const name = fileName(table.table, i, file.name)
      names.push(name)
      await db.registerFileBuffer(name, file.bytes)
    }
    await conn.query(readParquetViewSql(schema, table.table, names))
  }
}

export async function attachParquetUrlTables(
  options: AttachParquetUrlTablesOptions,
): Promise<AttachedTablesHandle> {
  const {
    db,
    conn,
    tables,
    fetch: fetchImpl = globalThis.fetch.bind(globalThis),
    schema = 'main',
    fetchInit,
    version,
  } = options

  const flat: Array<{ table: string, url: string, index: number }> = []
  const counts: Record<string, number> = {}
  for (const [table, urls] of tables.map(t => [t.table, t.urls] as const)) {
    if (urls.length === 0)
      continue
    counts[table] = urls.length
    for (let i = 0; i < urls.length; i++)
      flat.push({ table, url: urls[i]!, index: i })
  }

  await Promise.all(flat.map(async ({ table, url, index }) => {
    const response = await fetchImpl(url, fetchInit)
    if (!response.ok)
      throw new Error(`fetch ${url} failed: ${response.status}`)
    const bytes = new Uint8Array(await response.arrayBuffer())
    await db.registerFileBuffer(fileName(table, index), bytes)
  }))

  const attached: string[] = []
  for (const table of Object.keys(counts)) {
    const names: string[] = []
    for (let i = 0; i < counts[table]!; i++)
      names.push(fileName(table, i))
    await conn.query(readParquetViewSql(schema, table, names))
    attached.push(table)
  }

  return {
    version,
    tables: attached,
    schema,
    async detach() {
      for (const table of attached)
        await conn.query(`DROP VIEW IF EXISTS ${schema}.${table}`)
    },
  }
}

/**
 * Incremental attach — fetch + register a single table's URLs and create the
 * view, without touching any other table. Use this for lazy attach when a
 * page only needs one of several available tables.
 */
export async function attachSingleTable(options: AttachSingleTableOptions): Promise<void> {
  const {
    db,
    conn,
    table,
    urls,
    fetch: fetchImpl = globalThis.fetch.bind(globalThis),
    schema = 'main',
    fetchInit,
  } = options
  if (urls.length === 0)
    return
  await Promise.all(urls.map(async (url, index) => {
    const response = await fetchImpl(url, fetchInit)
    if (!response.ok)
      throw new Error(`fetch ${url} failed: ${response.status}`)
    const bytes = new Uint8Array(await response.arrayBuffer())
    await db.registerFileBuffer(fileName(table, index), bytes)
  }))
  const names = urls.map((_, i) => fileName(table, i))
  await conn.query(readParquetViewSql(schema, table, names))
}

/**
 * List the views currently attached under `schema` via DuckDB's
 * `information_schema`. Lets callers decide whether to call
 * `attachSingleTable` before each query without guessing at state.
 */
export async function listAttachedTables(
  conn: AsyncDuckDBConnection,
  schema: string = 'main',
): Promise<string[]> {
  const result = await conn.query(
    `SELECT table_name FROM information_schema.tables WHERE table_schema = '${escapeSqlString(schema)}'`,
  )
  return toRows(result).map(r => String(r.table_name))
}

export function createBrowserAnalysisRuntime(
  boot: DuckDBWasmBootResult,
  options: { schema?: string, version?: number | string } = {},
): BrowserAnalysisRuntime {
  const { db, conn } = boot
  const schema = options.schema ?? 'main'
  let version: number | string | undefined = options.version

  // Serialize every `analyze()` call against the shared connection. DuckDB's
  // AsyncDuckDBConnection is not concurrency-safe (async ≠ parallel); two
  // simultaneous callers corrupt prepared-statement state. Chain on a
  // rolling promise so later callers queue behind earlier ones.
  let chain: Promise<unknown> = Promise.resolve()

  async function cancelOnAbort(signal: AbortSignal | undefined, work: Promise<unknown>) {
    if (!signal)
      return work
    if (signal.aborted) {
      // Fire-and-forget: best-effort cancel, then surface the abort reason.
      conn.cancelSent().catch(() => {})
      throw signal.reason ?? new DOMException('aborted', 'AbortError')
    }
    const onAbort = () => {
      conn.cancelSent().catch(() => {})
    }
    signal.addEventListener('abort', onAbort, { once: true })
    try {
      return await work
    }
    finally {
      signal.removeEventListener('abort', onAbort)
    }
  }

  async function runParameterized(sql: string, params: readonly unknown[] | undefined, signal?: AbortSignal) {
    signal?.throwIfAborted()
    const work = (async () => {
      if (!params || params.length === 0)
        return conn.query(sql)
      const stmt = await conn.prepare(sql)
      try {
        return await stmt.query(...(params as unknown[]))
      }
      finally {
        await stmt.close()
      }
    })()
    return cancelOnAbort(signal, work)
  }

  return {
    db,
    conn,
    async query(sql: string, params?: unknown[], signal?: AbortSignal): Promise<QueryResult> {
      const t0 = performance.now()
      const result = await runParameterized(sql, params, signal)
      return {
        rows: toRows(result),
        queryMs: performance.now() - t0,
      }
    },
    async analyze(params: AnalysisParams, options: { signal?: AbortSignal } = {}): Promise<AnalyzeResult> {
      const signal = options.signal
      const run = async (): Promise<AnalyzeResult> => {
        signal?.throwIfAborted()
        const t0 = performance.now()
        const result: AnalysisResult = await analyzeInBrowser(
          {
            query: async (sql, bindParams, innerSignal) => {
              return toRows(await runParameterized(sql, bindParams, innerSignal ?? signal))
            },
          },
          { schema, signal },
          params,
        )
        return {
          results: result.results as Record<string, unknown>[],
          meta: result.meta,
          queryMs: performance.now() - t0,
        }
      }
      const next = chain.then(run, run)
      // Keep the chain alive even on rejection so later callers don't
      // inherit the failure, but don't surface unhandled rejections.
      chain = next.catch(() => {})
      return next
    },
    isStale(expected) {
      return expected !== version
    },
    setVersion(next) {
      version = next
    },
    async close(): Promise<void> {
      await conn.close()
      // terminate() is safe here because this runtime owns the db+worker pair.
      await db.terminate()
    },
  }
}

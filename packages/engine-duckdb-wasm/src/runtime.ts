import type { AsyncDuckDB, AsyncDuckDBConnection, DuckDBBundles } from '@duckdb/duckdb-wasm'
import type { AnalysisParams, AnalysisResult } from '@gscdump/engine/analysis-types'
import type { AnalyzerRegistry } from '@gscdump/engine/analyzer'

import { runAnalyzerFromSource } from '@gscdump/engine/analyzer'
import { arrowToRows as toRows } from '@gscdump/engine/arrow'
import { pgResolverAdapter } from '@gscdump/engine/resolver'
import { createAttachedTableSource } from '@gscdump/engine/source'
import { sqlEscape } from '@gscdump/engine/sql'

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
  /**
   * Called once per parquet file after it's been fetched and registered with
   * DuckDB. Fires in non-deterministic order (Promise.all under the hood).
   * Used by UI progress indicators to tick a per-site counter; a no-op
   * default keeps the hot path free.
   */
  onFileAttached?: (info: { table: string, index: number, total: number }) => void
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
  analyze: (params: AnalysisParams, registry: AnalyzerRegistry, options?: { signal?: AbortSignal }) => Promise<AnalyzeResult>
  /**
   * Returns true when `expected` doesn't match the version the runtime was
   * attached with — cheap check callers can run before each query to decide
   * whether to detach + re-attach against a fresher manifest. Undefined
   * values on either side compare equal so the no-version path is a no-op.
   */
  isStale: (expected: number | string | undefined) => boolean
  /** Update the runtime's cached manifest version in-place (e.g. after a re-attach). */
  setVersion: (version: number | string | undefined) => void
  /**
   * Update the list of attached table names. Lets callers fast-fail in
   * `analyze()` when a SQL plan references a table that wasn't in the manifest
   * for this site (e.g. site has only `keywords` parquet, analyzer wants
   * `page_keywords`) — surface a clean `AttachedTableMissingError` so the
   * caller can route to cloud fallback without paying the SQL execution cost.
   */
  setAttachedTables: (tables: readonly string[]) => void
  close: () => Promise<void>
}

function fileName(table: string, index: number, provided?: string): string {
  return provided ?? `${table}_${index}.parquet`
}

function readParquetViewSql(schema: string, table: string, files: string[]): string {
  const escaped = files.map(name => `'${sqlEscape(name)}'`).join(', ')
  // `date` lands as VARCHAR in legacy parquets (BYTE_ARRAY/UTF8, before the
  // schema enforced DATE). DuckDB infers from the parquet file, so the view
  // surface would otherwise expose VARCHAR despite SCHEMAS declaring DATE.
  // REPLACE-cast at the scan rewrites it canonically once per scan so every
  // downstream consumer — the analyzers' compiled SQL, ad-hoc SQL the chat
  // composes via the database tool — sees DATE uniformly. The cast is a no-op
  // for already-DATE-typed columns and vectorized parsing for VARCHAR ones.
  return `CREATE OR REPLACE VIEW ${schema}.${table} AS SELECT * REPLACE (CAST(date AS DATE) AS date) FROM read_parquet([${escaped}], union_by_name = true)`
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
    onFileAttached,
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

  // Per-table fetch resilience: a single 404/500 in one table's URL list
  // must not take down every other table's view. Track failures by table
  // and drop only the offenders — the surviving tables still get a view.
  const tableFailures = new Map<string, Error>()
  const total = flat.length
  await Promise.all(flat.map(async ({ table, url, index }) => {
    if (tableFailures.has(table))
      return
    await fetchImpl(url, fetchInit).then(async (response) => {
      if (!response.ok)
        throw new Error(`fetch ${url} failed: ${response.status}`)
      const bytes = new Uint8Array(await response.arrayBuffer())
      await db.registerFileBuffer(fileName(table, index), bytes)
      onFileAttached?.({ table, index, total })
    }).catch((err) => {
      tableFailures.set(table, err instanceof Error ? err : new Error(String(err)))
    })
  }))

  const attached: string[] = []
  for (const table of Object.keys(counts)) {
    if (tableFailures.has(table))
      continue
    const names: string[] = []
    for (let i = 0; i < counts[table]!; i++)
      names.push(fileName(table, i))
    await conn.query(readParquetViewSql(schema, table, names))
    attached.push(table)
  }
  if (tableFailures.size > 0) {
    // Surface the failures so consumers can log / warn rather than silently
    // miss a view. The runtime throws later with a clear "does not exist"
    // error when a query hits the missing table; this is the authoritative
    // upstream signal for why.
    for (const [table, err] of tableFailures)
      console.warn(`[gscdump/engine-duckdb-wasm] dropped table "${table}" — ${err.message}`)
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

export function createBrowserAnalysisRuntime(
  boot: DuckDBWasmBootResult,
  options: { schema?: string, version?: number | string, attachedTables?: readonly string[] } = {},
): BrowserAnalysisRuntime {
  const { db, conn } = boot
  const schema = options.schema ?? 'main'
  let version: number | string | undefined = options.version
  let attachedTables: readonly string[] | undefined = options.attachedTables

  // Serialize every `analyze()` call against the shared connection. DuckDB's
  // AsyncDuckDBConnection is not concurrency-safe (async ≠ parallel); two
  // simultaneous callers corrupt prepared-statement state. Chain on a
  // rolling promise so later callers queue behind earlier ones.
  let chain: Promise<unknown> = Promise.resolve()

  async function cancelOnAbort(signal: AbortSignal | undefined, work: Promise<unknown>): Promise<unknown> {
    if (!signal)
      return work
    if (signal.aborted) {
      // Fire-and-forget: best-effort cancel, then surface the abort reason.
      conn.cancelSent().catch(() => {})
      throw signal.reason ?? new DOMException('aborted', 'AbortError')
    }
    const onAbort = (): void => {
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

  async function runParameterized(sql: string, params: readonly unknown[] | undefined, signal?: AbortSignal): Promise<unknown> {
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
    async analyze(params: AnalysisParams, registry: AnalyzerRegistry, options: { signal?: AbortSignal } = {}): Promise<AnalyzeResult> {
      const signal = options.signal
      const run = async (): Promise<AnalyzeResult> => {
        signal?.throwIfAborted()
        const t0 = performance.now()
        const source = createAttachedTableSource(
          {
            query: async (sql, bindParams, innerSignal) => {
              return toRows(await runParameterized(sql, bindParams, innerSignal ?? signal))
            },
          },
          { schema, signal, attachedTables, adapter: pgResolverAdapter },
        )
        const result: AnalysisResult = await runAnalyzerFromSource(source, params, registry)
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
    setAttachedTables(next) {
      attachedTables = next
    },
    async close(): Promise<void> {
      await conn.close()
      // terminate() is safe here because this runtime owns the db+worker pair.
      await db.terminate()
    },
  }
}

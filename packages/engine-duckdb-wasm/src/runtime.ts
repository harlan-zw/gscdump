import type { AsyncDuckDB, AsyncDuckDBConnection, DuckDBBundles, DuckDBConfig } from '@duckdb/duckdb-wasm'
import type { AnalysisParams, AnalysisResult } from '@gscdump/engine/analysis-types'
import type { AnalyzerRegistry } from '@gscdump/engine/analyzer'
import type { Result } from 'gscdump/result'

import { runAnalyzerFromSource } from '@gscdump/engine/analyzer'
import { arrowToRows as toRows } from '@gscdump/engine/arrow'
import { pgResolverAdapter } from '@gscdump/engine/resolver'
import { createAttachedTableSource } from '@gscdump/engine/source'
import { sqlEscape } from '@gscdump/engine/sql'
import { err, ok, unwrapResult } from 'gscdump/result'

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
  /**
   * DuckDB-WASM logger. Defaults to a `ConsoleLogger` thresholded at
   * `LogLevel.WARNING`, so real warnings/errors still surface but the per-query
   * INFO events (START/OK/RUN) — which DuckDB's default `ConsoleLogger()` emits
   * as raw objects, flooding the host console with dozens of lines per render —
   * are dropped. Pass `new ConsoleLogger(LogLevel.DEBUG)` to see everything, or
   * `new VoidLogger()` to silence it entirely.
   */
  logger?: unknown
  /**
   * Override the jsDelivr-hosted bundle map. Required in environments where
   * the default CDN is unreachable or where hosts must serve the WASM +
   * worker assets themselves (e.g. Cloudflare Workers' 25 MB per-asset cap).
   */
  bundles?: DuckDBBundles
  /**
   * Extra DuckDB open config. The browser runtime always forces HTTP files
   * into range-only mode (reliable HEAD probes, no full HTTP fallback) so a
   * server that cannot answer bounded reads fails closed.
   */
  config?: DuckDBConfig
  /**
   * Cap DuckDB's memory with `SET memory_limit=<value>` right after open (e.g.
   * `'2GB'`, `'512MB'`). A runaway query then errors with a clean
   * out-of-memory rather than growing the WASM heap until the tab crashes —
   * DuckDB has no statement-level timeout, so abandoned queries are otherwise
   * only stopped by the caller's `AbortSignal` (which the runtime forwards to
   * `conn.cancelSent()`). Opt-in: omit to keep DuckDB-WASM's default sizing.
   * Accepts `<number>` with an optional `B`/`KB`/`MB`/`GB`/`TB` suffix.
   */
  memoryLimit?: string
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
  /**
   * Request init used only for runtime-owned HEAD / one-byte Range preflights.
   * DuckDB-WASM's internal HTTP reader cannot receive custom fetch headers;
   * URL reads must therefore be authorized by the URL itself.
   */
  fetchInit?: RequestInit
  /**
   * Caps simultaneous URL preflights. Browser source endpoints should already
   * return small, coverage-planned URL sets; this is the runtime's local
   * guard against accidental unbounded attachment.
   */
  fetchConcurrency?: number
  /** Reject before preflight when the URL set exceeds this many parquet files. */
  maxFiles?: number
  /** Reject before registration when hinted or authoritative bytes exceed budget. */
  maxBytes?: number
  /** Abort signal passed through to URL preflights and registration. */
  signal?: AbortSignal
  /**
   * How DuckDB reads the parquet bytes:
   *  - `'http'` (default): register the URL as an HTTP file; DuckDB issues
   *    its own range reads during query execution. Right for large parquet
   *    where only some column chunks are touched per query.
   *  - `'buffer'`: fetch the full file once into an `ArrayBuffer` and register
   *    it via `registerFileBuffer`. DuckDB makes zero HTTP calls after
   *    registration — every query reads from the in-memory copy. Right for
   *    tiny files (e.g. `dates` daily-totals parquet, <50 KB per file) where
   *    the per-file round-trip overhead dominates the actual bytes moved.
   */
  attachMode?: 'http' | 'buffer'
  /**
   * When `true` (default), skip per-file HEAD/Range preflight if the URL
   * carries a signed `?s=<bytes>.<sig>` size hint — the size is already
   * known and DuckDB will learn `Accept-Ranges` from its first read.
   * Eliminates one round-trip per file on hosts that mint size hints. Set
   * `false` to force preflight against URLs whose size you don't trust.
   */
  trustSizeHint?: boolean
  /**
   * Manifest version the caller associates with this set of URLs. Returned
   * on the resulting handle so callers can compare against a fresh manifest
   * probe without re-attaching. Purely advisory — the runtime never derives
   * behavior from the value itself.
   */
  version?: number | string
  /**
   * Called once per parquet file after it's been fetched and registered with
   * DuckDB. For URL-backed HTTP files this means "preflighted and registered"
   * rather than fully downloaded; DuckDB then performs range reads during the
   * query. Fires in bounded-concurrency completion order, which is still not
   * guaranteed to match manifest URL order. Used by UI progress indicators to
   * tick a per-site counter; a no-op default keeps the hot path free.
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
   * for this site (e.g. site has only `queries` parquet, analyzer wants
   * `page_queries`) — surface a clean `AttachedTableMissingError` so the
   * caller can route to cloud fallback without paying the SQL execution cost.
   */
  setAttachedTables: (tables: readonly string[]) => void
  close: () => Promise<void>
}

const DEFAULT_ATTACH_FETCH_CONCURRENCY = 2
const DEFAULT_ATTACH_MAX_FILES = 32
const DEFAULT_ATTACH_MAX_BYTES = 16 * 1024 * 1024
let nextAttachId = 0

export class BrowserAttachBudgetExceededError extends Error {
  override name = 'BrowserAttachBudgetExceededError'
}

// Modelled, caller-actionable failure for the browser parquet URL attach: the
// requested file set blows the local file-count or byte budget (the runtime's
// guard against accidentally pulling an unbounded manifest into the page). The
// caller branches on this to route the affected tables server-side instead of
// crashing the page. `kind`-discriminated to mirror `gscdump`/`@gscdump/engine`
// error conventions. WASM/DuckDB/HTTP IO failures stay defects and propagate.
export interface BrowserAttachError {
  kind: 'browser-attach-budget-exceeded'
  message: string
  /** Which budget tripped: the file count, the hinted byte plan, or the running byte plan. */
  budget: 'maxFiles' | 'maxBytes'
}

export const browserAttachErrors = {
  maxFilesExceeded(files: number, maxFiles: number): BrowserAttachError {
    return {
      kind: 'browser-attach-budget-exceeded',
      budget: 'maxFiles',
      message: `browser parquet attach requires ${files} files, above maxFiles=${maxFiles}`,
    }
  },
  hintedBytesExceeded(hintedBytes: number, maxBytes: number): BrowserAttachError {
    return {
      kind: 'browser-attach-budget-exceeded',
      budget: 'maxBytes',
      message: `browser parquet attach requires ${hintedBytes} hinted bytes, above maxBytes=${maxBytes}`,
    }
  },
  plannedBytesExceeded(plannedBytes: number, maxBytes: number): BrowserAttachError {
    return {
      kind: 'browser-attach-budget-exceeded',
      budget: 'maxBytes',
      message: `browser parquet attach planned ${plannedBytes} bytes, above maxBytes=${maxBytes}`,
    }
  },
} as const

export function isBrowserAttachError(value: unknown): value is BrowserAttachError {
  return typeof value === 'object' && value !== null
    && (value as { kind?: string }).kind === 'browser-attach-budget-exceeded'
    && typeof (value as { message?: unknown }).message === 'string'
}

/**
 * Re-raise a {@link BrowserAttachError} as the historical
 * {@link BrowserAttachBudgetExceededError} so existing call sites' `instanceof`
 * checks keep holding. The `Result` core is the source of truth; the throwing
 * `attachParquetUrlTables` wrapper maps through here.
 */
function browserAttachErrorToException(error: BrowserAttachError): Error {
  const exception = new BrowserAttachBudgetExceededError(error.message)
  ;(exception as Error & { browserAttachError?: BrowserAttachError }).browserAttachError = error
  return exception
}

function fileName(table: string, index: number, provided?: string): string {
  return provided ?? `${table}_${index}.parquet`
}

function attachFileName(attachId: number, table: string, index: number): string {
  return `__gscdump_attach_${attachId}_${fileName(table, index)}`
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

function positiveInteger(value: number | undefined, fallback: number, label: string): number {
  const raw = value ?? fallback
  if (!Number.isFinite(raw) || raw < 1)
    throw new Error(`${label} must be a positive integer`)
  return Math.floor(raw)
}

async function runWithConcurrency<T>(
  items: readonly T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<void>,
): Promise<void> {
  let next = 0
  let failed = false
  async function worker(): Promise<void> {
    while (!failed && next < items.length) {
      const index = next++
      try {
        await fn(items[index]!, index)
      }
      catch (err) {
        failed = true
        throw err
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker))
}

function sizeHintFromUrl(url: string): number | null {
  try {
    const base = typeof globalThis.location?.href === 'string'
      ? globalThis.location.href
      : 'http://localhost'
    const raw = new URL(url, base).searchParams.get('s')?.split('.')[0]
    if (!raw)
      return null
    const size = Number(raw)
    return Number.isFinite(size) && size >= 0 ? size : null
  }
  catch {
    return null
  }
}

function mergeAbortSignals(primary: AbortSignal | undefined, secondary: AbortSignal | undefined): AbortSignal | undefined {
  if (!primary)
    return secondary
  if (!secondary)
    return primary
  if (primary.aborted)
    return primary
  if (secondary.aborted)
    return secondary
  const controller = new AbortController()
  const abort = (signal: AbortSignal): void => {
    controller.abort(signal.reason)
  }
  primary.addEventListener('abort', () => abort(primary), { once: true })
  secondary.addEventListener('abort', () => abort(secondary), { once: true })
  return controller.signal
}

function fetchInitFor(
  fetchInit: RequestInit | undefined,
  method: 'HEAD' | 'GET',
  signal: AbortSignal | undefined,
  extraHeaders?: Record<string, string>,
): RequestInit {
  const {
    body: _body,
    method: _method,
    signal: initSignal,
    headers: initHeaders,
    ...rest
  } = fetchInit ?? {}
  const headers = new Headers(initHeaders)
  for (const [key, value] of Object.entries(extraHeaders ?? {}))
    headers.set(key, value)
  return {
    ...rest,
    method,
    headers,
    signal: mergeAbortSignals(signal, initSignal ?? undefined),
  }
}

function isAbortError(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { name?: string }).name === 'AbortError'
}

function parseContentLength(headers: Headers): number | null {
  const raw = headers.get('content-length')
  if (!raw)
    return null
  const size = Number(raw)
  return Number.isFinite(size) && size >= 0 ? size : null
}

function parseContentRangeSize(headers: Headers): number | null {
  const raw = headers.get('content-range')
  if (!raw)
    return null
  const match = /^bytes\s+\d+-\d+\/(\d+)$/i.exec(raw)
  if (!match)
    return null
  const size = Number(match[1])
  return Number.isFinite(size) && size >= 0 ? size : null
}

function supportsRangeReads(headers: Headers): boolean {
  return headers.get('accept-ranges')?.toLowerCase().split(',').map(v => v.trim()).includes('bytes') === true
}

async function cancelBody(response: Response): Promise<void> {
  await response.body?.cancel().catch(() => undefined)
}

async function preflightHttpUrl(
  url: string,
  fetchImpl: typeof fetch,
  fetchInit: RequestInit | undefined,
  signal: AbortSignal | undefined,
): Promise<number> {
  const head = await fetchImpl(url, fetchInitFor(fetchInit, 'HEAD', signal))
  if (head.ok) {
    const size = parseContentLength(head.headers)
    if (size === null)
      throw new Error(`HEAD ${url} missing Content-Length`)
    if (!supportsRangeReads(head.headers))
      throw new Error(`HEAD ${url} missing Accept-Ranges: bytes`)
    return size
  }

  await cancelBody(head)
  if (![403, 405, 501].includes(head.status))
    throw new Error(`HEAD ${url} failed: ${head.status}`)

  const probe = await fetchImpl(url, fetchInitFor(fetchInit, 'GET', signal, { Range: 'bytes=0-0' }))
  try {
    if (probe.status !== 206)
      throw new Error(`range probe ${url} failed: ${probe.status}`)
    const size = parseContentRangeSize(probe.headers)
    if (size === null)
      throw new Error(`range probe ${url} missing Content-Range size`)
    return size
  }
  finally {
    await cancelBody(probe)
  }
}

function rangeOnlyConfig(config: DuckDBConfig | undefined): DuckDBConfig {
  return {
    ...(config ?? {}),
    filesystem: {
      // Defaults: HEAD is reliable, range-only (no full-HTTP fallback). Hosts
      // whose proxy can't serve a HEAD with `Content-Length` (e.g. Cloudflare
      // Workers strips it from null-body responses) opt out via
      // `reliableHeadRequests: false` + `allowFullHTTPReads: true` in their
      // bootDuckDBWasm options.
      reliableHeadRequests: true,
      allowFullHTTPReads: false,
      ...(config?.filesystem ?? {}),
      forceFullHTTPReads: false,
    },
  }
}

async function dropAttachedResources(
  db: AsyncDuckDB,
  conn: AsyncDuckDBConnection,
  schema: string,
  tables: readonly string[],
  files: readonly string[],
): Promise<void> {
  for (const table of tables)
    await conn.query(`DROP VIEW IF EXISTS ${schema}.${table}`)
  if (files.length > 0)
    await db.dropFiles([...files])
}

/**
 * Validate a `memory_limit` value at the boot boundary. DuckDB accepts a number
 * with an optional binary-unit suffix; reject anything else so a typo can't be
 * inlined into the `SET` statement. Returns the normalized literal.
 */
function parseMemoryLimit(value: string): string {
  const trimmed = value.trim()
  if (!/^\d+(?:\.\d+)?\s*(?:B|KB|MB|GB|TB)?$/i.test(trimmed))
    throw new Error(`invalid memoryLimit '${value}' — expected e.g. '512MB' or '2GB'`)
  return trimmed
}

export async function bootDuckDBWasm(
  options: BootDuckDBWasmOptions = {},
): Promise<DuckDBWasmBootResult> {
  const { getJsDelivrBundles, selectBundle, AsyncDuckDB, ConsoleLogger, LogLevel } = await import('@duckdb/duckdb-wasm')
  const bundles = options.bundles ?? getJsDelivrBundles()
  const bundle = await selectBundle(bundles)
  const workerUrl = URL.createObjectURL(
    new Blob([`importScripts("${bundle.mainWorker!}");`], { type: 'text/javascript' }),
  )
  const worker = new Worker(workerUrl)
  const db = new AsyncDuckDB((options.logger as any) ?? new ConsoleLogger(LogLevel.WARNING), worker)
  try {
    await db.instantiate(bundle.mainModule, bundle.pthreadWorker)
    await db.open(rangeOnlyConfig(options.config))
    const conn = await db.connect()
    if (options.memoryLimit !== undefined) {
      // Parse-don't-validate: reject a malformed limit here rather than letting
      // it reach DuckDB as opaque SQL. `memory_limit` is a session setting, so
      // it can't take a `?` bind param — the validated literal is inlined.
      await conn.query(`SET memory_limit='${parseMemoryLimit(options.memoryLimit)}'`)
    }
    return { db, conn }
  }
  catch (err) {
    // Instantiate/open/connect failed — tear down the worker so a failed boot
    // doesn't leak a Worker thread (and its object URL) for the page's lifetime.
    worker.terminate()
    throw err
  }
  finally {
    URL.revokeObjectURL(workerUrl)
  }
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

/**
 * Errors-as-values core for {@link attachParquetUrlTables}: returns a typed
 * {@link BrowserAttachError} when the requested file set blows the local file-
 * count / byte budget, so callers can branch (route the affected tables
 * server-side) instead of catching an untyped throw. WASM/DuckDB/HTTP IO
 * failures stay defects and propagate. `attachParquetUrlTables` is the thin
 * throwing wrapper preserving the historical `BrowserAttachBudgetExceededError`.
 */
export async function attachParquetUrlTablesResult(
  options: AttachParquetUrlTablesOptions,
): Promise<Result<AttachedTablesHandle, BrowserAttachError>> {
  const {
    db,
    conn,
    tables,
    fetch: fetchImpl = globalThis.fetch.bind(globalThis),
    schema = 'main',
    fetchInit,
    fetchConcurrency,
    maxFiles,
    maxBytes,
    signal,
    version,
    onFileAttached,
    attachMode = 'http',
    trustSizeHint = true,
  } = options

  const concurrency = positiveInteger(fetchConcurrency, DEFAULT_ATTACH_FETCH_CONCURRENCY, 'fetchConcurrency')
  const fileBudget = positiveInteger(maxFiles, DEFAULT_ATTACH_MAX_FILES, 'maxFiles')
  const byteBudget = positiveInteger(maxBytes, DEFAULT_ATTACH_MAX_BYTES, 'maxBytes')
  const attachId = nextAttachId++

  const flat: Array<{ table: string, url: string, index: number }> = []
  const counts: Record<string, number> = {}
  for (const [table, urls] of tables.map(t => [t.table, t.urls] as const)) {
    if (urls.length === 0)
      continue
    counts[table] = urls.length
    for (let i = 0; i < urls.length; i++)
      flat.push({ table, url: urls[i]!, index: i })
  }
  if (flat.length > fileBudget)
    return err(browserAttachErrors.maxFilesExceeded(flat.length, fileBudget))
  const hintedBytes = flat.reduce((acc, item) => {
    const hint = sizeHintFromUrl(item.url)
    return hint === null ? acc : acc + hint
  }, 0)
  if (hintedBytes > byteBudget)
    return err(browserAttachErrors.hintedBytesExceeded(hintedBytes, byteBudget))

  // Two registration paths, picked per call via `attachMode`:
  //   - 'http' (default): DuckDB reads each file via HTTP range; we preflight
  //     to learn size + Accept-Ranges. When the URL carries a signed size hint
  //     (`?s=<bytes>.<sig>`) and `trustSizeHint` is on, we skip the preflight
  //     entirely — the size is already known and the server contract
  //     guarantees ranges.
  //   - 'buffer': fetch the full file once and `registerFileBuffer`. DuckDB
  //     has zero HTTP traffic after registration; right shape for tiny files
  //     where per-file round-trip overhead dominates the byte movement.
  //
  // Per-table fetch resilience: a single 404/500 in one table's URL list
  // must not take down every other table's view. Track failures by table
  // and drop only the offenders — the surviving tables still get a view.
  const tableFailures = new Map<string, Error>()
  const budgetController = new AbortController()
  const effectiveSignal = mergeAbortSignals(signal, budgetController.signal)
  let plannedBytes = 0
  const total = flat.length
  interface PreparedFile {
    table: string
    url: string
    index: number
    name: string
    bytes: number
    /** Materialised body for `'buffer'` mode; null for `'http'`. */
    body: Uint8Array | null
  }
  const prepared: PreparedFile[] = []

  // The running-byte-plan budget guard fires mid-stream, inside the bounded
  // concurrency workers: it aborts the in-flight preflights via
  // `budgetController` and propagates out of `runWithConcurrency`. We keep it as
  // an internal throw (the `BrowserAttachBudgetExceededError` class drives both
  // the abort signal and the per-worker catch's "rethrow vs record" branch),
  // then convert it to the modelled `Result` error at this boundary so the
  // caller branches on `kind` rather than catching. Any OTHER throw out of the
  // download phase is a defect (HTTP/WASM IO) and propagates unchanged.
  try {
    await runWithConcurrency(flat, concurrency, async ({ table, url, index }) => {
      if (tableFailures.has(table))
        return
      effectiveSignal?.throwIfAborted()
      try {
        let bytes: number | null = null
        let body: Uint8Array | null = null

        if (attachMode === 'buffer') {
          // Buffer mode: download the file, learn size from the body. No HEAD
          // round-trip — the GET itself yields both size and bytes.
          const res = await fetchImpl(url, fetchInitFor(fetchInit, 'GET', effectiveSignal))
          if (!res.ok)
            throw new Error(`GET ${url} failed: ${res.status}`)
          const buf = new Uint8Array(await res.arrayBuffer())
          body = buf
          bytes = buf.byteLength
        }
        else if (trustSizeHint && sizeHintFromUrl(url) !== null) {
          // HTTP mode + signed size hint: take the hint, skip the preflight.
          // Saves one round-trip per file; DuckDB learns Accept-Ranges from
          // its first range read.
          bytes = sizeHintFromUrl(url)!
        }
        else {
          // HTTP mode without a hint: preflight as before.
          bytes = await preflightHttpUrl(url, fetchImpl, fetchInit, effectiveSignal)
        }

        plannedBytes += bytes
        if (plannedBytes > byteBudget) {
          const budgetErr = new BrowserAttachBudgetExceededError(
            `browser parquet attach planned ${plannedBytes} bytes, above maxBytes=${byteBudget}`,
          )
          budgetController.abort(budgetErr)
          throw budgetErr
        }
        effectiveSignal?.throwIfAborted()
        prepared.push({ table, url, index, name: attachFileName(attachId, table, index), bytes, body })
      }
      catch (err) {
        if (effectiveSignal?.aborted || err instanceof BrowserAttachBudgetExceededError || isAbortError(err))
          throw err
        tableFailures.set(table, err instanceof Error ? err : new Error(String(err)))
      }
    })
  }
  catch (downloadErr) {
    // The mid-stream byte-budget guard is the only modelled failure here. A
    // user-supplied `signal` abort still throws (AbortError is a defect-shaped
    // cancellation, not a budget outcome) so it surfaces as before.
    if (downloadErr instanceof BrowserAttachBudgetExceededError && !signal?.aborted)
      return err(browserAttachErrors.plannedBytesExceeded(plannedBytes, byteBudget))
    throw downloadErr
  }

  const { DuckDBDataProtocol } = await import('@duckdb/duckdb-wasm')
  const attached: string[] = []
  const registeredFiles: string[] = []
  try {
    for (const file of prepared) {
      if (tableFailures.has(file.table))
        continue
      effectiveSignal?.throwIfAborted()
      if (file.body !== null)
        await db.registerFileBuffer(file.name, file.body)
      else
        await db.registerFileURL(file.name, file.url, DuckDBDataProtocol.HTTP, false)
      registeredFiles.push(file.name)
      onFileAttached?.({ table: file.table, index: file.index, total })
    }

    for (const table of Object.keys(counts)) {
      if (tableFailures.has(table))
        continue
      const files = prepared
        .filter(file => file.table === table)
        .sort((a, b) => a.index - b.index)
      if (files.length !== counts[table])
        continue
      effectiveSignal?.throwIfAborted()
      await conn.query(readParquetViewSql(schema, table, files.map(file => file.name)))
      attached.push(table)
    }
  }
  catch (err) {
    await dropAttachedResources(db, conn, schema, attached, registeredFiles).catch((cleanupErr) => {
      console.warn('[gscdump/engine-duckdb-wasm] cleanup after failed attach failed', cleanupErr)
    })
    throw err
  }

  if (tableFailures.size > 0) {
    // Surface the failures so consumers can log / warn rather than silently
    // miss a view. The runtime throws later with a clear "does not exist"
    // error when a query hits the missing table; this is the authoritative
    // upstream signal for why.
    for (const [table, err] of tableFailures)
      console.warn(`[gscdump/engine-duckdb-wasm] dropped table "${table}" — ${err.message}`)
  }

  let detached = false
  return ok({
    version,
    tables: attached,
    schema,
    async detach() {
      if (detached)
        return
      detached = true
      await dropAttachedResources(db, conn, schema, attached, registeredFiles)
    },
  })
}

/**
 * Attach browser parquet URL tables, throwing
 * {@link BrowserAttachBudgetExceededError} when the requested set blows the
 * file-count / byte budget. Thin throwing wrapper over
 * {@link attachParquetUrlTablesResult}; existing call sites and their
 * `instanceof BrowserAttachBudgetExceededError` checks keep holding.
 */
export async function attachParquetUrlTables(
  options: AttachParquetUrlTablesOptions,
): Promise<AttachedTablesHandle> {
  return unwrapResult(await attachParquetUrlTablesResult(options), browserAttachErrorToException)
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
  // AsyncDuckDBConnection is not concurrency-safe (async != parallel); two
  // simultaneous callers corrupt prepared-statement state. Chain on a
  // rolling promise so later callers queue behind earlier ones. `query()` and
  // `analyze()` share this queue because they use the same connection.
  let chain: Promise<unknown> = Promise.resolve()

  function abortError(signal: AbortSignal): unknown {
    return signal.reason ?? new DOMException('aborted', 'AbortError')
  }

  function raceSignal<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
    if (!signal)
      return promise
    if (signal.aborted)
      return Promise.reject(abortError(signal))
    return new Promise<T>((resolve, reject) => {
      const onAbort = (): void => reject(abortError(signal))
      signal.addEventListener('abort', onAbort, { once: true })
      promise.then(
        (value) => {
          signal.removeEventListener('abort', onAbort)
          resolve(value)
        },
        (err) => {
          signal.removeEventListener('abort', onAbort)
          reject(err)
        },
      )
    })
  }

  function runExclusive<T>(signal: AbortSignal | undefined, work: () => Promise<T>): Promise<T> {
    const next = chain.then(work, work)
    // Keep the chain alive even on rejection so later callers do not inherit
    // the failure, but do not surface unhandled rejections.
    // The caller observes `next`; the rejection branch only converts the
    // internal queue tail back to a fulfilled state for subsequent calls.
    chain = next.then(() => undefined, () => undefined)
    return raceSignal(next, signal)
  }

  async function cancelOnAbort(signal: AbortSignal | undefined, work: Promise<unknown>): Promise<unknown> {
    if (!signal)
      return work
    if (signal.aborted) {
      throw abortError(signal)
    }
    const onAbort = (): void => {
      void conn.cancelSent().catch((error: unknown) => {
        console.warn('[gscdump/engine-duckdb-wasm] failed to cancel aborted query', error)
      })
    }
    signal.addEventListener('abort', onAbort, { once: true })
    try {
      return await work
    }
    finally {
      signal.removeEventListener('abort', onAbort)
    }
  }

  async function runParameterizedDirect(sql: string, params: readonly unknown[] | undefined, signal?: AbortSignal): Promise<unknown> {
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
      const result = await runExclusive(signal, () => runParameterizedDirect(sql, params, signal))
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
              return toRows(await runParameterizedDirect(sql, bindParams, innerSignal ?? signal))
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
      return runExclusive(signal, run)
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

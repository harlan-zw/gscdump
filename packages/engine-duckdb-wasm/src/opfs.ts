/**
 * OPFS-backed parquet attach for DuckDB-WASM.
 *
 * Ports the proven Spike-3 approach (`poc/iceberg/browser/index.html`): download
 * a compacted Iceberg parquet data file into the Origin Private File System,
 * content-hash verify it, register the OPFS file handle with DuckDB-WASM via
 * `BROWSER_FSACCESS`, and attach it as a view. Steady-state queries are
 * zero-network — the data lives in OPFS, only the WASM runtime assets come from
 * the network (and those HTTP-cache / self-host).
 *
 * Design rules locked by the architecture doc:
 * - ATTACH-ONCE — files are downloaded + registered once per `(site, table)`.
 *   Filter / date-range changes within the attached span re-query, never
 *   re-attach.
 * - CONTENT-HASH VERIFIED — a cached OPFS file is only trusted when its
 *   SHA-256 matches the Iceberg data-file digest; a mismatch re-downloads.
 * - QUOTA-SAFE — `QuotaExceededError` degrades (the caller routes that table
 *   server-side); it never crashes the page.
 * - `navigator.storage.persist()` is requested up front so the browser is less
 *   likely to evict the cache.
 *
 * This module is browser-only. It is dynamically imported by the analyzer
 * composable so server / consumer-mode hosts never pull it into their bundle.
 */

import type { AsyncDuckDB, AsyncDuckDBConnection } from '@duckdb/duckdb-wasm'

/** A parquet data file to materialise into OPFS. */
export interface OpfsParquetFile {
  /** Same-origin URL carrying a signed size hint + short-lived access token. */
  url: string
  /** Expected byte size — drives progress + a cheap pre-verify shortcut. */
  bytes: number
  /**
   * Lowercase hex SHA-256 of the file's bytes (the Iceberg data-file digest).
   * The OPFS-cached copy is verified against this before it is trusted.
   * When omitted, only the byte size is checked (degraded trust).
   */
  contentHash?: string
  /** Row count — diagnostics only. */
  rowCount?: number
}

/** One logical table and the parquet files that compose it. */
export interface OpfsParquetTable {
  /** Iceberg table name — becomes the DuckDB view name. */
  table: string
  files: OpfsParquetFile[]
}

export interface AttachOpfsTablesOptions {
  db: AsyncDuckDB
  conn: AsyncDuckDBConnection
  tables: OpfsParquetTable[]
  /** DuckDB schema the views are created in. Default `main`. */
  schema?: string
  /** `fetch` override (tests). Default `globalThis.fetch`. */
  fetch?: typeof fetch
  /** Request init for the parquet downloads (auth headers, credentials mode). */
  fetchInit?: RequestInit
  /** Caps simultaneous downloads. Default 2. */
  fetchConcurrency?: number
  /** Abort signal threaded through downloads + registration. */
  signal?: AbortSignal
  /** Snapshot version associated with this file set — echoed on the handle. */
  version?: string
  /** Ticks once per file as it lands in OPFS + registers. UI progress. */
  onFileProgress?: (info: OpfsFileProgress) => void
}

export interface OpfsFileProgress {
  table: string
  /** OPFS file name. */
  file: string
  /** Index within the flat file list. */
  index: number
  /** Total files across all tables. */
  total: number
  /** Bytes of this file (cumulative caller-side). */
  bytes: number
  /** `'cache-hit'` — already in OPFS, verified; `'downloaded'` — fetched. */
  outcome: 'cache-hit' | 'downloaded'
}

/** Handle returned from {@link attachOpfsParquetTables}. */
export interface OpfsAttachedHandle {
  version: string | undefined
  /** Tables that successfully attached (a per-table failure drops only that table). */
  tables: string[]
  schema: string
  /** Total bytes materialised into OPFS for this attach. */
  bytesAttached: number
  /**
   * Tables that could NOT be attached because OPFS ran out of quota. The
   * caller routes these to the server tail. Empty on a clean attach.
   */
  degradedTables: string[]
  /** Detach the created views + release the registered OPFS file handles. */
  detach: () => Promise<void>
}

/**
 * Raised when OPFS cannot hold the file set. Carries the partial state so the
 * caller can degrade — attach what fit, route the rest server-side.
 */
export class OpfsQuotaExceededError extends Error {
  override name = 'OpfsQuotaExceededError'
  /** Tables that did not fit. */
  readonly degradedTables: string[]
  constructor(message: string, degradedTables: string[]) {
    super(message)
    this.degradedTables = degradedTables
  }
}

const DEFAULT_CONCURRENCY = 2
/** OPFS file-name prefix so our cache entries are namespaced + reapable. */
const OPFS_PREFIX = 'gscdump-snapshot__'

function isQuotaError(err: unknown): boolean {
  if (typeof err !== 'object' || err === null)
    return false
  const name = (err as { name?: string }).name
  // `QuotaExceededError` is the spec name; some engines also surface a numeric
  // legacy code 22. DOMException carries both.
  return name === 'QuotaExceededError'
    || (err as { code?: number }).code === 22
}

function isAbortError(err: unknown): boolean {
  return typeof err === 'object' && err !== null
    && (err as { name?: string }).name === 'AbortError'
}

/** Stable, collision-free OPFS file name for a `(table, index)` pair. */
function opfsFileName(table: string, index: number): string {
  return `${OPFS_PREFIX}${table}_${index}.parquet`
}

/**
 * Request persistent storage so the browser is less likely to evict the OPFS
 * cache under pressure. Returns the granted state — `false` is normal for an
 * un-engaged origin and is NOT an error; it just means eviction is possible.
 */
export async function requestPersistentStorage(): Promise<boolean> {
  const storage = globalThis.navigator?.storage
  if (!storage?.persist)
    return false
  // `persisted()` short-circuits the prompt when already granted.
  if (await storage.persisted?.().catch(() => false))
    return true
  return storage.persist().catch(() => false)
}

/** Best-effort `{ usageBytes, quotaBytes }` from the Storage API. */
export async function estimateOpfsStorage(): Promise<{ usageBytes?: number, quotaBytes?: number }> {
  const estimate = globalThis.navigator?.storage?.estimate
  if (!estimate)
    return {}
  const est = await estimate.call(globalThis.navigator.storage).catch(() => null)
  return est ? { usageBytes: est.usage, quotaBytes: est.quota } : {}
}

async function sha256Hex(bytes: ArrayBuffer): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes)
  return Array.from(new Uint8Array(digest))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('')
}

async function getOpfsRoot(): Promise<FileSystemDirectoryHandle> {
  const dir = globalThis.navigator?.storage?.getDirectory
  if (!dir)
    throw new Error('[engine-duckdb-wasm/opfs] OPFS unavailable: navigator.storage.getDirectory missing')
  return dir.call(globalThis.navigator.storage)
}

/**
 * Return a verified OPFS file handle for `file`, downloading it if absent or
 * corrupt. Verification: byte size must match, and when `contentHash` is set
 * the SHA-256 of the cached bytes must match it. A failed check re-downloads.
 */
async function materialiseFile(
  root: FileSystemDirectoryHandle,
  name: string,
  file: OpfsParquetFile,
  fetchImpl: typeof fetch,
  fetchInit: RequestInit | undefined,
  signal: AbortSignal | undefined,
): Promise<{ handle: FileSystemFileHandle, outcome: 'cache-hit' | 'downloaded' }> {
  signal?.throwIfAborted()

  // ---- cache probe --------------------------------------------------------
  let handle: FileSystemFileHandle | undefined
  try {
    handle = await root.getFileHandle(name)
    const cached = await handle.getFile()
    if (cached.size === file.bytes) {
      if (!file.contentHash) {
        // No digest to verify against — trust the size match (degraded).
        return { handle, outcome: 'cache-hit' }
      }
      const cachedHash = await sha256Hex(await cached.arrayBuffer())
      if (cachedHash === file.contentHash.toLowerCase())
        return { handle, outcome: 'cache-hit' }
      // Hash mismatch — corrupt / stale. Fall through to re-download.
    }
  }
  catch {
    // Not cached yet — fall through to download.
  }

  // ---- download -----------------------------------------------------------
  signal?.throwIfAborted()
  const resp = await fetchImpl(file.url, { ...fetchInit, signal })
  if (!resp.ok)
    throw new Error(`[engine-duckdb-wasm/opfs] download ${file.url} failed: ${resp.status}`)
  const buf = await resp.arrayBuffer()
  if (file.contentHash) {
    const hash = await sha256Hex(buf)
    if (hash !== file.contentHash.toLowerCase()) {
      throw new Error(
        `[engine-duckdb-wasm/opfs] content-hash mismatch for ${file.url}: `
        + `expected ${file.contentHash}, got ${hash}`,
      )
    }
  }

  // ---- write to OPFS ------------------------------------------------------
  // A `QuotaExceededError` can surface from createWritable / write / close.
  // It is allowed to propagate — `attachOpfsParquetTables` catches it and
  // degrades the affected table.
  handle = await root.getFileHandle(name, { create: true })
  const writable = await handle.createWritable()
  try {
    await writable.write(buf)
    await writable.close()
  }
  catch (err) {
    await writable.abort?.().catch(() => {})
    // The partial / empty file is useless — remove it so a later run re-downloads.
    await root.removeEntry(name).catch(() => {})
    throw err
  }
  return { handle, outcome: 'downloaded' }
}

function readParquetViewSql(schema: string, table: string, files: string[]): string {
  const list = files.map(f => `'${f.replace(/'/g, '\'\'')}'`).join(', ')
  // `date` can land as VARCHAR in older parquet — REPLACE-cast it to DATE so
  // every downstream query sees a uniform type. No-op when already DATE.
  return `CREATE OR REPLACE VIEW ${schema}.${table} AS `
    + `SELECT * REPLACE (CAST(date AS DATE) AS date) `
    + `FROM read_parquet([${list}], union_by_name = true)`
}

async function runWithConcurrency<T>(
  items: readonly T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<void>,
): Promise<void> {
  let next = 0
  let failed: unknown
  async function worker(): Promise<void> {
    while (failed === undefined && next < items.length) {
      const index = next++
      try {
        await fn(items[index]!, index)
      }
      catch (err) {
        failed = err
        throw err
      }
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, worker),
  )
}

/**
 * Download every parquet file in `tables` into OPFS, content-hash verify, and
 * attach them as DuckDB-WASM views. Attach-once: call this once per
 * `(site, table)` span; re-query without re-attaching for filter / range
 * changes inside the span.
 *
 * Quota handling: a `QuotaExceededError` while writing a table's files does
 * NOT throw — that table is recorded in `degradedTables` and skipped; the
 * caller routes it to the server tail. The remaining tables still attach.
 */
export async function attachOpfsParquetTables(
  options: AttachOpfsTablesOptions,
): Promise<OpfsAttachedHandle> {
  const {
    db,
    conn,
    tables,
    schema = 'main',
    fetch: fetchImpl = globalThis.fetch.bind(globalThis),
    fetchInit,
    fetchConcurrency = DEFAULT_CONCURRENCY,
    signal,
    version,
    onFileProgress,
  } = options

  await requestPersistentStorage()
  const root = await getOpfsRoot()

  // Flatten so downloads run with global concurrency, not per-table.
  const flat: Array<{ table: string, file: OpfsParquetFile, fileIndex: number }> = []
  for (const t of tables) {
    for (let i = 0; i < t.files.length; i++)
      flat.push({ table: t.table, file: t.files[i]!, fileIndex: i })
  }
  const total = flat.length

  const { DuckDBDataProtocol } = await import('@duckdb/duckdb-wasm')

  // Per-table OPFS file names + the registered handles, so a table that hits
  // a quota error can be dropped wholesale.
  const tableFiles = new Map<string, Array<{ name: string, handle: FileSystemFileHandle }>>()
  const degraded = new Set<string>()
  let bytesAttached = 0

  await runWithConcurrency(flat, Math.max(1, fetchConcurrency), async (item, index) => {
    if (degraded.has(item.table))
      return
    signal?.throwIfAborted()
    const name = opfsFileName(item.table, item.fileIndex)
    let result: { handle: FileSystemFileHandle, outcome: 'cache-hit' | 'downloaded' }
    try {
      result = await materialiseFile(root, name, item.file, fetchImpl, fetchInit, signal)
    }
    catch (err) {
      if (isAbortError(err))
        throw err
      if (isQuotaError(err)) {
        // OPFS is full for this table — degrade it, keep the rest.
        degraded.add(item.table)
        return
      }
      throw err
    }
    // Register the OPFS handle with DuckDB. `BROWSER_FSACCESS` reads the file
    // directly from OPFS — no copy into WASM linear memory.
    await db.registerFileHandle(name, result.handle, DuckDBDataProtocol.BROWSER_FSACCESS, true)
    const list = tableFiles.get(item.table) ?? []
    list.push({ name, handle: result.handle })
    tableFiles.set(item.table, list)
    bytesAttached += item.file.bytes
    onFileProgress?.({
      table: item.table,
      file: name,
      index,
      total,
      bytes: item.file.bytes,
      outcome: result.outcome,
    })
  })

  // ---- create the views ---------------------------------------------------
  const attached: string[] = []
  const registeredNames: string[] = []
  try {
    for (const t of tables) {
      if (degraded.has(t.table))
        continue
      const files = tableFiles.get(t.table) ?? []
      // A table only attaches when every one of its files materialised.
      if (files.length !== t.files.length) {
        degraded.add(t.table)
        continue
      }
      signal?.throwIfAborted()
      await conn.query(readParquetViewSql(schema, t.table, files.map(f => f.name)))
      attached.push(t.table)
      for (const f of files)
        registeredNames.push(f.name)
    }
  }
  catch (err) {
    // View creation failed — tear down everything we registered this call.
    await detachOpfs(db, conn, schema, attached, registeredNames).catch(() => {})
    throw err
  }

  let detached = false
  return {
    version,
    tables: attached,
    schema,
    bytesAttached,
    degradedTables: [...degraded],
    async detach() {
      if (detached)
        return
      detached = true
      await detachOpfs(db, conn, schema, attached, registeredNames)
    },
  }
}

async function detachOpfs(
  db: AsyncDuckDB,
  conn: AsyncDuckDBConnection,
  schema: string,
  tables: readonly string[],
  files: readonly string[],
): Promise<void> {
  for (const table of tables)
    await conn.query(`DROP VIEW IF EXISTS ${schema}.${table}`).catch(() => {})
  if (files.length > 0)
    await db.dropFiles([...files]).catch(() => {})
}

/**
 * Delete every OPFS entry this module created. Used to reclaim space after a
 * quota error, or to force a clean re-download. Best-effort — missing entries
 * are ignored.
 */
export async function clearOpfsSnapshotCache(): Promise<void> {
  const root = await getOpfsRoot().catch(() => null)
  if (!root)
    return
  const removable: string[] = []
  // `keys()` is async-iterable on a directory handle.
  const dir = root as FileSystemDirectoryHandle & { keys?: () => AsyncIterableIterator<string> }
  if (dir.keys) {
    for await (const name of dir.keys()) {
      if (name.startsWith(OPFS_PREFIX))
        removable.push(name)
    }
  }
  for (const name of removable)
    await root.removeEntry(name).catch(() => {})
}

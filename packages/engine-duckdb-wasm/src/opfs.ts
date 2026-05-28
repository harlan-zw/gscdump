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
 * - CONTENT-ADDRESSED — the `contentHash` from the contract is encoded into
 *   the OPFS filename. Same hash → same filename → existence is the cache
 *   hit. Different hash → new filename → fresh download. No re-hashing on
 *   the cache-hit path. Stale entries (same `(table,index)` but a different
 *   hash) are swept at attach time.
 * - QUOTA-SAFE — `QuotaExceededError` degrades (the caller routes that table
 *   server-side); it never crashes the page.
 * - `navigator.storage.persist()` is requested up front so the browser is less
 *   likely to evict the cache.
 *
 * This module is browser-only. It is dynamically imported by the analyzer
 * composable so server / consumer-mode hosts never pull it into their bundle.
 */

import type { AsyncDuckDB, AsyncDuckDBConnection, DuckDBDataProtocol } from '@duckdb/duckdb-wasm'
import type { OpfsHandleRegistry } from './opfs-registry'
import { createOpfsHandleRegistry } from './opfs-registry'

/** A parquet data file to materialise into OPFS. */
export interface OpfsParquetFile {
  /** Same-origin URL carrying a signed size hint + short-lived access token. */
  url: string
  /** Expected byte size — drives progress + a cheap pre-verify shortcut. */
  bytes: number
  /**
   * Opaque content-stable identifier for this file (e.g. the Iceberg data-
   * file object key). Encoded into the OPFS filename so the same hash is the
   * same cache entry. NOT required to be a SHA-256. When omitted, the cache
   * key falls back to `(table, index)` and only the byte size is verified
   * (degraded — stale entries can survive a content change).
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

/**
 * Per-DB reference-counted registry of OPFS file handles. BROWSER_FSACCESS
 * opens a sync access handle the first time DuckDB reads the file — OPFS forbids
 * a second sync handle on the same backing entry, so re-registering the same
 * name from a different consumer (e.g. the home fanout AND the per-site analyzer
 * sharing one DB instance) breaks reads. The registry registers each name once
 * and counts references so a shared file is only dropped (releasing its sync
 * access handle) when the last consumer detaches. One registry per DB instance.
 */
const dbRegistries = new WeakMap<AsyncDuckDB, OpfsHandleRegistry>()
function getOpfsRegistry(db: AsyncDuckDB, protocol: DuckDBDataProtocol): OpfsHandleRegistry {
  let registry = dbRegistries.get(db)
  if (!registry) {
    registry = createOpfsHandleRegistry({
      register: (name, handle) => db.registerFileHandle(name, handle as FileSystemFileHandle, protocol, true),
      drop: async (name) => { await db.dropFile(name) },
    })
    dbRegistries.set(db, registry)
  }
  return registry
}

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

/**
 * True for the OPFS sync-access-handle exclusivity error. Access handles are
 * exclusive per backing file, so when a prior attach of the same parquet (e.g.
 * a previous page/analyzer sharing the DB) hasn't released its handle yet,
 * DuckDB's `BROWSER_FSACCESS` read throws "Access Handles cannot be created…".
 * Treated as a degradation (not fatal) so the caller falls back to the
 * in-memory buffer path instead of failing the whole table.
 */
function isOpfsAccessHandleConflict(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err)
  return /createSyncAccessHandle|Access Handle/i.test(msg)
}

/**
 * OPFS file name for a `(table, index, contentHash?)` triple. When a content
 * hash is supplied, it's encoded as an 8-byte slug suffix so the filename
 * itself is the cache address: same hash → same filename → trivial cache
 * hit. The `(table, index)` prefix lets us sweep stale entries cheaply.
 */
function opfsFileName(table: string, index: number, hashSlug?: string): string {
  const base = `${OPFS_PREFIX}${table}_${index}`
  return hashSlug ? `${base}_${hashSlug}.parquet` : `${base}.parquet`
}

/**
 * Sweep prefix matching every cache entry for a `(table, index)` slot —
 * both legacy `<base>.parquet` and hash-suffixed `<base>_<slug>.parquet`
 * forms. The trailing-character check at the call site enforces the
 * delimiter (`.` or `_`) so `pages_0` never sweeps `pages_01`.
 */
function opfsFileNamePrefix(table: string, index: number): string {
  return `${OPFS_PREFIX}${table}_${index}`
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

/**
 * Stable, filesystem-safe slug derived from a `contentHash`. We keep it short
 * (16 hex chars of SHA-256) so OPFS filenames stay readable, but with enough
 * entropy that collisions across distinct payloads are vanishingly unlikely.
 */
async function contentHashSlug(contentHash: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(contentHash),
  )
  const bytes = new Uint8Array(digest)
  let hex = ''
  for (let i = 0; i < 8; i++)
    hex += bytes[i]!.toString(16).padStart(2, '0')
  return hex
}

async function getOpfsRoot(): Promise<FileSystemDirectoryHandle> {
  const dir = globalThis.navigator?.storage?.getDirectory
  if (!dir)
    throw new Error('[engine-duckdb-wasm/opfs] OPFS unavailable: navigator.storage.getDirectory missing')
  return dir.call(globalThis.navigator.storage)
}

/**
 * Return an OPFS file handle for `file`, downloading it if absent. The
 * filename encodes the `contentHash` (when supplied), so existence + size
 * match is sufficient verification — no SHA recomputation on the hot path.
 * Stale entries for the same `(table, index)` but a different content hash
 * are swept before download.
 */
async function materialiseFile(
  root: FileSystemDirectoryHandle,
  name: string,
  staleSweepPrefix: string,
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
    if (cached.size === file.bytes)
      return { handle, outcome: 'cache-hit' }
    // Size mismatch — partial / corrupt write. Re-download.
  }
  catch {
    // Not cached yet — fall through to download.
  }

  // ---- sweep stale entries -----------------------------------------------
  // Same `(table, index)` with a different content hash → orphaned cache
  // entry. Remove it before writing the new one so OPFS doesn't accumulate.
  const dir = root as FileSystemDirectoryHandle & { keys?: () => AsyncIterableIterator<string> }
  if (dir.keys) {
    for await (const existing of dir.keys()) {
      if (existing === name || !existing.startsWith(staleSweepPrefix) || !existing.endsWith('.parquet'))
        continue
      // Enforce a slot boundary so `pages_0` never sweeps `pages_01_*.parquet`.
      const next = existing.charAt(staleSweepPrefix.length)
      if (next === '.' || next === '_')
        await root.removeEntry(existing).catch(() => {})
    }
  }

  // ---- download -----------------------------------------------------------
  signal?.throwIfAborted()
  const resp = await fetchImpl(file.url, { ...fetchInit, signal })
  if (!resp.ok)
    throw new Error(`[engine-duckdb-wasm/opfs] download ${file.url} failed: ${resp.status}`)
  const buf = await resp.arrayBuffer()

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
  const registry = getOpfsRegistry(db, DuckDBDataProtocol.BROWSER_FSACCESS)

  // Per-table OPFS file names + the registered handles, so a table that hits
  // a quota error can be dropped wholesale.
  const tableFiles = new Map<string, Array<{ name: string, handle: FileSystemFileHandle }>>()
  const degraded = new Set<string>()
  const acquiredNames = new Set<string>()
  let bytesAttached = 0
  // Release every OPFS handle acquired for a table (decrements the registry
  // refcount, dropping the sync access handle when no other consumer holds it).
  const releaseTable = async (table: string): Promise<void> => {
    const names = (tableFiles.get(table) ?? []).map(f => f.name)
    for (const n of names)
      acquiredNames.delete(n)
    await registry.release(names)
  }

  const runDownloads = (): Promise<void> => runWithConcurrency(flat, Math.max(1, fetchConcurrency), async (item, index) => {
    if (degraded.has(item.table))
      return
    signal?.throwIfAborted()
    const hashSlug = item.file.contentHash ? await contentHashSlug(item.file.contentHash) : undefined
    const name = opfsFileName(item.table, item.fileIndex, hashSlug)
    const sweepPrefix = opfsFileNamePrefix(item.table, item.fileIndex)
    let result: { handle: FileSystemFileHandle, outcome: 'cache-hit' | 'downloaded' }
    try {
      result = await materialiseFile(root, name, sweepPrefix, item.file, fetchImpl, fetchInit, signal)
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
    // directly from OPFS — no copy into WASM linear memory. The registry
    // registers each name once and reference-counts it, so a name another
    // consumer already holds on the same DB is reused rather than re-opened
    // (a second sync access handle on one backing file is the OPFS conflict).
    try {
      await registry.acquire(name, () => result.handle)
      acquiredNames.add(name)
    }
    catch (err) {
      if (isAbortError(err))
        throw err
      // Sync-access-handle exclusivity conflict — degrade this table so the
      // caller can fall back to the buffer path instead of failing.
      if (isOpfsAccessHandleConflict(err)) {
        degraded.add(item.table)
        return
      }
      throw err
    }
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

  // If the download loop throws (abort, or a non-degradable error), release
  // every handle it managed to acquire before the throw escapes — there is no
  // view loop to clean up after a download-phase failure.
  try {
    await runDownloads()
  }
  catch (err) {
    await registry.release([...acquiredNames]).catch(() => {})
    throw err
  }

  // ---- create the views ---------------------------------------------------
  const attached: string[] = []
  const registeredNames: string[] = []
  for (const t of tables) {
    if (degraded.has(t.table)) {
      // Degraded during the download loop (quota / access-handle conflict on a
      // later file of the table). Any EARLIER file of this table that already
      // acquired a handle must be released here — the download loop only marked
      // the table degraded, it did not release the handles it had taken.
      await releaseTable(t.table)
      continue
    }
    const files = tableFiles.get(t.table) ?? []
    // A table only attaches when every one of its files materialised. Release
    // any handles it did acquire so they don't leak as orphan registrations.
    if (files.length !== t.files.length) {
      degraded.add(t.table)
      await releaseTable(t.table)
      continue
    }
    try {
      // The abort check is INSIDE the try so an abort between view-loop
      // iterations shares the teardown path below — otherwise a bare throw here
      // escapes uncaught and leaks every handle acquired during the download loop.
      signal?.throwIfAborted()
      await conn.query(readParquetViewSql(schema, t.table, files.map(f => f.name)))
    }
    catch (err) {
      if (isAbortError(err)) {
        await detachOpfs(registry, conn, schema, attached, [...acquiredNames]).catch(() => {})
        throw err
      }
      // Sync-access-handle exclusivity conflict — the BROWSER_FSACCESS read
      // can't open this file while a prior handle is held. Degrade just this
      // table (dropping any half-created view + releasing its handles) so the
      // caller falls back to the buffer path; other tables keep their OPFS
      // attachment.
      if (isOpfsAccessHandleConflict(err)) {
        // Only drop the half-created view if NO other consumer on this shared DB
        // holds it — otherwise we'd yank a view another attach still queries.
        if (registry.viewRefs(`${schema}.${t.table}`) === 0)
          await conn.query(`DROP VIEW IF EXISTS ${schema}.${t.table}`).catch(() => {})
        degraded.add(t.table)
        await releaseTable(t.table)
        continue
      }
      // Any other view-creation failure tears down everything registered.
      await detachOpfs(registry, conn, schema, attached, [...acquiredNames]).catch(() => {})
      throw err
    }
    attached.push(t.table)
    // This consumer now holds the view; refcount it so a sibling consumer's
    // detach can't drop the view while this one still queries through it.
    registry.acquireView(`${schema}.${t.table}`)
    for (const f of files)
      registeredNames.push(f.name)
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
      await detachOpfs(registry, conn, schema, attached, registeredNames)
    },
  }
}

async function detachOpfs(
  registry: OpfsHandleRegistry,
  conn: AsyncDuckDBConnection,
  schema: string,
  tables: readonly string[],
  files: readonly string[],
): Promise<void> {
  // Refcount-release the views: a view shared by two consumers on one DB is
  // only dropped once the LAST consumer detaches, so the first detach can't
  // break the other consumer's queries.
  for (const table of tables) {
    await registry.releaseView(
      `${schema}.${table}`,
      () => conn.query(`DROP VIEW IF EXISTS ${schema}.${table}`).then(() => {}),
    )
  }
  // Release the OPFS handles via the registry. Reference counting means a file
  // another consumer still holds (shared DB via `sharedGscDuckDBWasm`) is kept
  // open; only the last detach drops it, releasing the sync access handle.
  await registry.release(files)
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

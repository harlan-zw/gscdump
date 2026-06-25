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
 *   the OPFS filename as `<table>_<slug>.parquet`. Same hash → same filename →
 *   existence is the cache hit, REGARDLESS of the file's position in the
 *   manifest. This is load-bearing: the resolver returns the same physical file
 *   at different array indices across endpoints (e.g. a single-table
 *   `bulk-sources` vs a multi-table `analysis-sources`), so any index in the
 *   filename would re-download identical bytes under a new name and orphan the
 *   old copy. Different hash → new filename → fresh download. No re-hashing on
 *   the cache-hit path. Stale entries for a table (a hash no longer in the
 *   current manifest, plus legacy index-named files from older builds) are
 *   swept at attach time.
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
import { overlayViewBody } from './overlay-view'

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
  /**
   * Recent-window overlay parquet (the non-stable tail the lake excludes). When
   * present it is materialised into OPFS alongside `files` and the view unions
   * it with an anti-join dedup: the lake (`files`) serves every day it has, the
   * overlay serves ONLY days the lake lacks. So a stale overlay whose days have
   * since landed in the lake can't double-count, and a day that stabilised but
   * isn't yet in the lake still serves from the overlay. Its `contentHash` must
   * change when the overlay bytes change (it is overwritten in place) so the
   * cache re-downloads.
   */
  overlay?: OpfsParquetFile
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
  /**
   * Serializer for the operations that mutate the DuckDB-WASM virtual
   * filesystem / catalog (`registerFileHandle`, `dropFile`, `CREATE`/`DROP
   * VIEW`) — those are not concurrency-safe across consumers sharing one
   * `AsyncDuckDB`. Callers with a shared DB pass their global attach mutex
   * here so ONLY these mutations serialize; the parquet downloads (network +
   * OPFS writes, no DB interaction) run outside the lock and overlap across
   * concurrent attaches. Wrapping the whole `attachOpfsParquetTables` call in
   * the mutex instead serializes every table's downloads end-to-end — the
   * dominant cold-load cost.
   *
   * The returned handle's `detach()` is NOT routed through this — callers
   * that pass a lock typically already hold it around teardown, and the lock
   * is not reentrant.
   *
   * Default: run inline (caller owns the DB exclusively).
   */
  withDb?: <T>(fn: () => Promise<T>) => Promise<T>
  /**
   * Recover a table degraded by an OPFS sync-access-handle / write conflict
   * (the multi-tab case — another tab holds the file's exclusive handle) by
   * reading the already-cached bytes via the lock-free File API (or HTTP on a
   * genuine cache miss) and registering them as in-memory buffers, so the table
   * attaches from the shared cache instead of being pushed back to the caller.
   * Quota / incomplete degradations are NEVER recovered this way — buffering a
   * quota-exceeding set risks OOM, and the caller routes those to its tail.
   * Default true.
   */
  recoverContention?: boolean
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
 * Virtual-filesystem prefix for the in-memory buffers registered by the
 * contention-recovery fallback. Distinct from {@link OPFS_PREFIX} (those are
 * OPFS handles) so the two never collide in the DuckDB-WASM virtual FS, and so
 * the OPFS sweep never reaps a live recovery buffer.
 */
const RECOVER_BUFFER_PREFIX = 'gscdump-recover__'

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
 * True for the OPFS write-exclusivity error from `createWritable` — a
 * `NoModificationAllowedError` (DOMException code 7, "modifications are not
 * allowed"). It's raised when the content-addressed backing file already has an
 * open sync access handle held by a concurrent / prior `BROWSER_FSACCESS`
 * attach of the same file (e.g. the per-site analyzer and the multi-site fanout
 * sharing one DB). Like the read-side {@link isOpfsAccessHandleConflict}, it's a
 * transient exclusivity conflict, not data loss — degrade the table so the
 * caller falls back to the in-memory buffer path instead of failing the attach.
 */
function isOpfsWriteConflict(err: unknown): boolean {
  if (typeof err !== 'object' || err === null)
    return false
  const name = (err as { name?: string }).name
  const msg = err instanceof Error ? err.message : String(err)
  return name === 'NoModificationAllowedError'
    || (err as { code?: number }).code === 7
    || /createWritable|modifications are not allowed/i.test(msg)
}

/**
 * OPFS file name for a file. When a content hash is supplied it's the cache
 * address — `<table>_<slug>.parquet`, NO index — so the same content is one
 * filename no matter where it sits in the manifest. The `index` is used ONLY
 * as the disambiguator in the degraded no-`contentHash` fallback, where the
 * filename can't be content-addressed and we have nothing else to keep two
 * files of the same table apart.
 */
function opfsFileName(table: string, hashSlug: string | undefined, index: number): string {
  return hashSlug
    ? `${OPFS_PREFIX}${table}_${hashSlug}.parquet`
    : `${OPFS_PREFIX}${table}_${index}.parquet`
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Matcher for every OPFS entry that belongs to `table` — the content-addressed
 * form `<table>_<16hex>.parquet` and the legacy index forms `<table>_<n>.parquet`
 * / `<table>_<n>_<16hex>.parquet` left by older builds. Anchored on the exact
 * slug/index shape so a sibling table whose name extends this one (`pages` vs
 * `pages_summary`, `search_appearance` vs `search_appearance_pages`) never
 * matches: the segment after `<table>_` is then a word, not hex-or-digits.
 */
function tableEntryMatcher(table: string): RegExp {
  return new RegExp(`^${escapeRegExp(`${OPFS_PREFIX}${table}_`)}(?:[0-9a-f]{16}|\\d+(?:_[0-9a-f]{16})?)\\.parquet$`)
}

/**
 * Reap every cached OPFS entry for the attached tables that the current
 * manifest no longer references — stale-hash files (content rotated to a new
 * snapshot) and legacy index-named files from builds before content-addressing.
 * One directory scan; an entry is removed only when it matches exactly one
 * attached table's shape, isn't in that table's expected set, and isn't held
 * live by the registry (a concurrent consumer of the shared DB).
 */
async function sweepStaleEntries(
  root: FileSystemDirectoryHandle,
  registry: OpfsHandleRegistry,
  expectedByTable: Map<string, Set<string>>,
): Promise<void> {
  const dir = root as FileSystemDirectoryHandle & { keys?: () => AsyncIterableIterator<string> }
  if (!dir.keys)
    return
  const matchers = [...expectedByTable].map(([table, expected]) => ({ expected, re: tableEntryMatcher(table) }))
  for await (const name of dir.keys()) {
    const m = matchers.find(m => m.re.test(name))
    if (!m || m.expected.has(name) || registry.refs(name) > 0)
      continue
    await root.removeEntry(name).catch(() => {})
  }
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
 * Read a content-addressed OPFS snapshot file via the async File API and return
 * its bytes, or null when absent / size-mismatched (partial / stale write).
 *
 * `getFile()` takes NO lock — unlike DuckDB's `BROWSER_FSACCESS` sync access
 * handle — so it reads cleanly while ANOTHER tab holds the same file open. That
 * is the basis for cross-tab cache sharing: a tab that loses the exclusive-handle
 * race reads the shared cached bytes here instead of re-downloading. The
 * filename derivation is the SAME `opfsFileName` + `contentHashSlug` the attach
 * path writes, so consumers reuse the engine's naming with no replicated slug
 * logic to drift out of lock-step. `index` is only the disambiguator for the
 * degraded no-`contentHash` fallback (mirrors `attachOpfsParquetTables`).
 */
export async function readOpfsSnapshotFile(
  table: string,
  contentHash: string | undefined,
  index: number,
  expectedBytes: number,
): Promise<Uint8Array | null> {
  try {
    const root = await getOpfsRoot()
    const slug = contentHash ? await contentHashSlug(contentHash) : undefined
    const name = opfsFileName(table, slug, index)
    const handle = await root.getFileHandle(name)
    const file = await handle.getFile()
    if (file.size !== expectedBytes)
      return null
    return new Uint8Array(await file.arrayBuffer())
  }
  catch {
    return null
  }
}

/**
 * Return an OPFS file handle for `file`, downloading it if absent. The
 * filename encodes the `contentHash` (when supplied), so existence + size
 * match is sufficient verification — no SHA recomputation on the hot path.
 * Stale entries are reaped once up front by {@link sweepStaleEntries}, so this
 * is a pure cache-probe-then-download.
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
    if (cached.size === file.bytes)
      return { handle, outcome: 'cache-hit' }
    // Size mismatch — partial / corrupt write. Re-download.
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

function quoteList(files: string[]): string {
  return files.map(f => `'${f.replace(/'/g, '\'\'')}'`).join(', ')
}

// `SELECT * REPLACE (CAST(date AS DATE) AS date)` canonicalises the date column:
// it can land as VARCHAR in older / overlay parquet and as DATE in compacted
// lake parquet. No-op when already DATE; makes the union type-uniform.
function lakeSelect(files: string[]): string {
  return `SELECT * REPLACE (CAST(date AS DATE) AS date) FROM read_parquet([${quoteList(files)}], union_by_name = true)`
}

function readParquetViewSql(schema: string, table: string, files: string[]): string {
  return `CREATE OR REPLACE VIEW ${schema}.${table} AS ${lakeSelect(files)}`
}

/**
 * View SQL for a table that has a recent-window overlay. The merge body (anti-join
 * dedup, `MATERIALIZED` lake reuse, `UNION ALL BY NAME`) is built by the shared
 * {@link overlayViewBody}; here we only supply the two date-normalised SELECTs and
 * wrap the result in `CREATE OR REPLACE VIEW`. When `lakeFiles` is empty (the
 * requested range is entirely within the recent tail) the body is the overlay
 * alone — no lake to dedup against.
 */
function readParquetViewWithOverlaySql(schema: string, table: string, lakeFiles: string[], overlayFile: string): string {
  const overlay = `SELECT * REPLACE (CAST(date AS DATE) AS date) FROM read_parquet(['${overlayFile.replace(/'/g, '\'\'')}'], union_by_name = true)`
  const body = overlayViewBody({
    lakeSelect: lakeFiles.length === 0 ? null : lakeSelect(lakeFiles),
    overlaySelect: overlay,
    materializeLake: true,
  })!
  return `CREATE OR REPLACE VIEW ${schema}.${table} AS ${body}`
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
    withDb = fn => fn(),
    recoverContention = true,
  } = options

  await requestPersistentStorage()
  const root = await getOpfsRoot()

  // Flatten so downloads run with global concurrency, not per-table. Each item
  // carries its content-addressed OPFS name (computed once here, not per
  // download attempt). An overlay is just one more file to materialise; its
  // index disambiguator sits AFTER the lake files for the no-`contentHash`
  // fallback, and it's flagged so the view build can dedup the lake against it.
  const flat: Array<{ table: string, file: OpfsParquetFile, name: string, overlay?: boolean }> = []
  // Expected OPFS names per table — the cache-address set the sweep keeps and
  // everything else for the table (stale hashes, legacy index names) reaps.
  const expectedByTable = new Map<string, Set<string>>()
  for (const t of tables) {
    const expected = new Set<string>()
    for (let i = 0; i < t.files.length; i++) {
      const file = t.files[i]!
      const slug = file.contentHash ? await contentHashSlug(file.contentHash) : undefined
      const name = opfsFileName(t.table, slug, i)
      flat.push({ table: t.table, file, name })
      expected.add(name)
    }
    if (t.overlay) {
      const slug = t.overlay.contentHash ? await contentHashSlug(t.overlay.contentHash) : undefined
      const name = opfsFileName(t.table, slug, t.files.length)
      flat.push({ table: t.table, file: t.overlay, name, overlay: true })
      expected.add(name)
    }
    expectedByTable.set(t.table, expected)
  }
  const total = flat.length
  // Per-table OPFS name of the overlay file (when present), so the view build
  // can split materialised names into lake vs overlay regardless of download
  // completion order.
  const overlayNames = new Map<string, string>()
  // Expected materialised-file count per table = lake files + (overlay ? 1 : 0).
  const expectedCount = new Map<string, number>(tables.map(t => [t.table, t.files.length + (t.overlay ? 1 : 0)]))

  const { DuckDBDataProtocol } = await import('@duckdb/duckdb-wasm')
  const registry = getOpfsRegistry(db, DuckDBDataProtocol.BROWSER_FSACCESS)

  // Reap stale-hash + legacy index-named entries for these tables up front (one
  // directory scan) so OPFS doesn't accumulate a copy per snapshot version /
  // manifest ordering. Best-effort — a sweep failure never blocks the attach.
  await sweepStaleEntries(root, registry, expectedByTable).catch(() => {})

  // Per-table OPFS file names + the registered handles, so a table that hits
  // a quota error can be dropped wholesale.
  const tableFiles = new Map<string, Array<{ name: string, handle: FileSystemFileHandle }>>()
  const degraded = new Set<string>()
  // Why each degraded table degraded — only `contention` is buffer-recoverable.
  const degradeReason = new Map<string, 'quota' | 'contention' | 'incomplete'>()
  const acquiredNames = new Set<string>()
  // Virtual-FS names + view names created by the contention-recovery fallback,
  // tracked separately from the OPFS registry (buffers aren't refcounted handles)
  // so `detach()` can drop them directly.
  const bufferFiles: string[] = []
  const bufferViews: string[] = []
  let bytesAttached = 0
  // Release every OPFS handle acquired for a table (decrements the registry
  // refcount, dropping the sync access handle when no other consumer holds it).
  const releaseTable = async (table: string): Promise<void> => {
    const names = (tableFiles.get(table) ?? []).map(f => f.name)
    for (const n of names)
      acquiredNames.delete(n)
    await withDb(() => registry.release(names))
  }

  const runDownloads = (): Promise<void> => runWithConcurrency(flat, Math.max(1, fetchConcurrency), async (item, index) => {
    if (degraded.has(item.table))
      return
    signal?.throwIfAborted()
    const name = item.name
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
        degradeReason.set(item.table, 'quota')
        return
      }
      // `createWritable` write-exclusivity conflict — the backing file is held
      // open by another consumer of this shared DB. Degrade so the caller falls
      // back to the buffer path instead of failing the whole table.
      if (isOpfsWriteConflict(err)) {
        degraded.add(item.table)
        degradeReason.set(item.table, 'contention')
        return
      }
      throw err
    }
    // Register the OPFS handle with DuckDB. `BROWSER_FSACCESS` reads the file
    // directly from OPFS — no copy into WASM linear memory. The registry
    // registers each name once and reference-counts it, so a name another
    // consumer already holds on the same DB is reused rather than re-opened
    // (a second sync access handle on one backing file is the OPFS conflict).
    // The registration mutates the WASM virtual filesystem → under `withDb`.
    try {
      await withDb(() => registry.acquire(name, () => result.handle))
      acquiredNames.add(name)
    }
    catch (err) {
      if (isAbortError(err))
        throw err
      // Sync-access-handle exclusivity conflict — degrade this table so the
      // caller can fall back to the buffer path instead of failing.
      if (isOpfsAccessHandleConflict(err)) {
        degraded.add(item.table)
        degradeReason.set(item.table, 'contention')
        return
      }
      throw err
    }
    const list = tableFiles.get(item.table) ?? []
    list.push({ name, handle: result.handle })
    tableFiles.set(item.table, list)
    if (item.overlay)
      overlayNames.set(item.table, name)
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
    await withDb(() => registry.release([...acquiredNames])).catch(() => {})
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
    // A table only attaches when every one of its files materialised (lake +
    // overlay). Release any handles it did acquire so they don't leak as orphan
    // registrations.
    if (files.length !== (expectedCount.get(t.table) ?? t.files.length)) {
      degraded.add(t.table)
      degradeReason.set(t.table, degradeReason.get(t.table) ?? 'incomplete')
      await releaseTable(t.table)
      continue
    }
    // Split materialised names into lake vs overlay (download order is not
    // deterministic, so identify the overlay by its tracked name).
    const overlayName = overlayNames.get(t.table)
    const lakeNames = overlayName ? files.map(f => f.name).filter(n => n !== overlayName) : files.map(f => f.name)
    try {
      // The abort check is INSIDE the try so an abort between view-loop
      // iterations shares the teardown path below — otherwise a bare throw here
      // escapes uncaught and leaks every handle acquired during the download loop.
      signal?.throwIfAborted()
      await withDb(() => conn.query(overlayName
        ? readParquetViewWithOverlaySql(schema, t.table, lakeNames, overlayName)
        : readParquetViewSql(schema, t.table, lakeNames)))
    }
    catch (err) {
      if (isAbortError(err)) {
        await withDb(() => detachOpfs(registry, conn, schema, attached, [...acquiredNames])).catch(() => {})
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
          await withDb(() => conn.query(`DROP VIEW IF EXISTS ${schema}.${t.table}`)).catch(() => {})
        degraded.add(t.table)
        degradeReason.set(t.table, 'contention')
        await releaseTable(t.table)
        continue
      }
      // Any other view-creation failure tears down everything registered.
      await withDb(() => detachOpfs(registry, conn, schema, attached, [...acquiredNames])).catch(() => {})
      throw err
    }
    attached.push(t.table)
    // This consumer now holds the view; refcount it so a sibling consumer's
    // detach can't drop the view while this one still queries through it.
    registry.acquireView(`${schema}.${t.table}`)
    for (const f of files)
      registeredNames.push(f.name)
  }

  // ---- contention recovery (in-engine buffer fallback) --------------------
  // A table degraded by an OPFS sync-access-handle / write conflict is the
  // multi-tab case: another tab (a SEPARATE AsyncDuckDB) holds this content-
  // addressed file's exclusive handle, so BROWSER_FSACCESS can't open it here.
  // Rather than push the table back to the caller (re-read server-side / re-
  // download), read the already-cached bytes via the lock-free File API — or
  // HTTP on a genuine cache miss — and register them as in-memory buffers. The
  // table then attaches from the shared cache. Quota / incomplete degradations
  // are left alone (buffering a quota-exceeding set risks OOM).
  const recoverTableToBuffers = async (t: OpfsParquetTable): Promise<boolean> => {
    const readOne = async (file: OpfsParquetFile, index: number): Promise<Uint8Array> => {
      const cached = await readOpfsSnapshotFile(t.table, file.contentHash, index, file.bytes)
      if (cached)
        return cached
      // Genuine cache miss (eviction, or this tab never finished its own write
      // before the conflict) — fetch over HTTP, the same source the OPFS path
      // would have used.
      signal?.throwIfAborted()
      const resp = await fetchImpl(file.url, { ...fetchInit, signal })
      if (!resp.ok)
        throw new Error(`[engine-duckdb-wasm/opfs] recover ${file.url} failed: ${resp.status}`)
      return new Uint8Array(await resp.arrayBuffer())
    }
    const lakeNames: string[] = []
    for (let i = 0; i < t.files.length; i++) {
      const buf = await readOne(t.files[i]!, i)
      const name = `${RECOVER_BUFFER_PREFIX}${t.table}_${i}.parquet`
      await withDb(() => db.registerFileBuffer(name, buf))
      bufferFiles.push(name)
      lakeNames.push(name)
      bytesAttached += t.files[i]!.bytes
    }
    let overlayName: string | undefined
    if (t.overlay) {
      const buf = await readOne(t.overlay, t.files.length)
      overlayName = `${RECOVER_BUFFER_PREFIX}${t.table}_overlay.parquet`
      await withDb(() => db.registerFileBuffer(overlayName!, buf))
      bufferFiles.push(overlayName)
      bytesAttached += t.overlay.bytes
    }
    // Buffers already sit in WASM linear memory, so use the streaming (non-
    // MATERIALIZED) overlay body — a MATERIALIZED CTE would copy them again.
    const body = overlayViewBody({
      lakeSelect: lakeNames.length ? lakeSelect(lakeNames) : null,
      overlaySelect: overlayName
        ? `SELECT * REPLACE (CAST(date AS DATE) AS date) FROM read_parquet(['${overlayName.replace(/'/g, '\'\'')}'], union_by_name = true)`
        : null,
      materializeLake: false,
    })
    if (!body)
      return false
    await withDb(() => conn.query(`CREATE OR REPLACE VIEW ${schema}.${t.table} AS ${body}`))
    bufferViews.push(t.table)
    return true
  }

  if (recoverContention && !signal?.aborted) {
    for (const t of tables) {
      if (!degraded.has(t.table) || degradeReason.get(t.table) !== 'contention')
        continue
      const before = bufferFiles.length
      const ok = await recoverTableToBuffers(t).catch(() => false)
      if (ok) {
        degraded.delete(t.table)
      }
      else {
        // Recovery failed (cache miss + network error, or abort): drop any
        // buffers it registered so they don't leak, and leave the table degraded
        // for the caller to route to its server tail.
        for (const n of bufferFiles.slice(before))
          await withDb(() => db.dropFile(n)).catch(() => {})
        bufferFiles.length = before
      }
    }
  }

  let detached = false
  return {
    version,
    // OPFS-attached tables (registry-managed) plus any buffer-recovered ones.
    tables: [...attached, ...bufferViews],
    schema,
    bytesAttached,
    degradedTables: [...degraded],
    async detach() {
      if (detached)
        return
      detached = true
      await detachOpfs(registry, conn, schema, attached, registeredNames)
      // Buffer-recovered views/files aren't in the OPFS registry — drop directly.
      for (const v of bufferViews)
        await conn.query(`DROP VIEW IF EXISTS ${schema}.${v}`).catch(() => {})
      for (const n of bufferFiles)
        await db.dropFile(n).catch(() => {})
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

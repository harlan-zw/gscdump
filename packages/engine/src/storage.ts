import type { Row, TableName, TenantCtx } from 'gscdump/contracts'
import type { BuilderState } from 'gscdump/query'

export type { Row, TableName, TenantCtx } from 'gscdump/contracts'

export interface WriteCtx extends TenantCtx {
  table: TableName
  date?: string
  now?: () => number
}

export interface QueryCtx extends TenantCtx {
  table?: TableName
  signal?: AbortSignal
}

export interface GcCtx {
  now?: () => number
  userId?: string
  siteId?: string
}

export interface ManifestEntry {
  userId: string
  siteId?: string
  table: TableName
  partition: string
  objectKey: string
  rowCount: number
  bytes: number
  createdAt: number
  retiredAt?: number
  /** Table schema version at write time. Omitted on pre-#27 entries — treat as 1. */
  schemaVersion?: number
}

export interface ListLiveFilter {
  userId: string
  siteId?: string
  table?: TableName
  partitions?: string[]
}

export interface DataSource {
  read: (
    key: string,
    range?: { offset: number, length: number },
    signal?: AbortSignal,
  ) => Promise<Uint8Array>
  write: (key: string, bytes: Uint8Array) => Promise<void>
  delete: (keys: string[]) => Promise<void>
  /**
   * One-shot listing under a prefix. Implementations may cap the number of
   * returned keys (typically 10k) — callers iterating full tenant space
   * should prefer `streamList` when available or narrow the prefix.
   */
  list: (prefix: string) => Promise<string[]>
  /**
   * Per-key URI probe. Returns a URI string DuckDB's `httpfs` (or an
   * equivalent engine that fetches its own I/O) can read directly, or
   * `undefined` if the key isn't URI-resolvable on this backend and the
   * caller must fall back to `read(key)` for the bytes.
   *
   * Contracts:
   * - When defined, the returned URI MUST yield byte-identical content to
   *   `read(key)`. Callers rely on this for correctness.
   * - Backends with a native URI for every key (filesystem: absolute path,
   *   R2 via `httpfs`: signed URL) may always return a string.
   * - Backends without a native URI shape (in-memory) omit the method or
   *   return `undefined` per call.
   * - Mixed-per-query is allowed: some keys in one query may return a URI,
   *   others may not; the executor branches per key.
   */
  uri?: (key: string) => string | undefined
  /**
   * Optional — probe the byte size of a key without reading it. Used by
   * the engine to fill in `WriteResult.bytes` when a codec reports 0 or
   * unknown but the file is non-trivial.
   */
  head?: (key: string) => Promise<{ bytes: number } | undefined>
  /**
   * Optional streaming variant of `list`. Implementations that page
   * backing-store results (R2, S3) should implement this and yield keys
   * lazily. `list` may return up to an adapter-defined cap (typically
   * 10k keys); callers iterating full tenant space must prefer
   * `streamList` when available, or chunk by narrower prefixes.
   */
  streamList?: (prefix: string) => AsyncIterable<string>
}

export interface WatermarkScope {
  userId: string
  siteId?: string
  table: TableName
}

export interface Watermark extends WatermarkScope {
  newestDateSynced: string
  oldestDateSynced: string
  lastSyncAt: number
}

export interface WatermarkFilter {
  userId: string
  siteId?: string
  table?: TableName
}

export type SyncStateKind = 'pending' | 'inflight' | 'done' | 'failed'

export interface SyncStateScope {
  userId: string
  siteId?: string
  table: TableName
  date: string
}

export interface SyncState extends SyncStateScope {
  state: SyncStateKind
  updatedAt: number
  attempts: number
  error?: string
}

export interface SyncStateFilter {
  userId: string
  siteId?: string
  table?: TableName
  state?: SyncStateKind
}

export interface SyncStateDetail {
  at?: number
  error?: string
}

export interface LockScope {
  userId: string
  siteId?: string
  table: TableName
  partition: string
}

export interface ManifestStore {
  listLive: (filter: ListLiveFilter) => Promise<ManifestEntry[]>
  listAll: (filter: ListLiveFilter) => Promise<ManifestEntry[]>
  registerVersion: (entry: ManifestEntry, superseding?: ManifestEntry[]) => Promise<void>
  registerVersions: (entries: ManifestEntry[], superseding?: ManifestEntry[]) => Promise<void>
  listRetired: (olderThan: number) => Promise<ManifestEntry[]>
  delete: (entries: ManifestEntry[]) => Promise<void>
  getWatermarks: (filter: WatermarkFilter) => Promise<Watermark[]>
  bumpWatermark: (scope: WatermarkScope, date: string, at?: number) => Promise<void>
  getSyncStates: (filter: SyncStateFilter) => Promise<SyncState[]>
  setSyncState: (scope: SyncStateScope, state: SyncStateKind, detail?: SyncStateDetail) => Promise<void>
  /**
   * Serialize concurrent writers against the same scope. Held across the
   * write+register window so GC (orphan sweep) won't delete bytes that are
   * midway between `dataSource.write` and `manifestStore.registerVersion`.
   * Scope = tenant × table × partition.
   */
  withLock: <T>(scope: LockScope, fn: () => Promise<T>) => Promise<T>
}

export interface WriteResult {
  bytes: number
  rowCount: number
}

export interface CodecCtx {
  table: TableName
}

/**
 * Key-oriented codec. Each method owns its I/O through `dataSource`:
 * - Node / browser codecs read/write bytes via `dataSource.read` / `.write`.
 * - Workers codecs let DuckDB's httpfs read/write remote URIs directly (via
 *   `dataSource.uri`) and never materialise bytes in JS.
 *
 * The engine never touches bytes; it just hands rows + keys to the codec.
 *
 * Invariants every implementation MUST uphold:
 * - `writeRows` with an empty `rows` array MUST still write a file
 *   carrying the canonical column set for `ctx.table` — a schema-correct
 *   empty file. No placeholder-column shortcuts; readers depend on the
 *   schema being present for `union_by_name` merges.
 * - `WriteResult.bytes` MUST be the real byte size written to the
 *   data source (not 0, not an estimate) so the engine can enforce the
 *   payload ceiling without a second `head` round-trip.
 * - `WriteResult.rowCount` MUST equal `rows.length` (or, for
 *   `compactRows`, the sum of input row counts).
 */
export interface ParquetCodec {
  writeRows: (
    ctx: CodecCtx,
    rows: Row[],
    key: string,
    dataSource: DataSource,
  ) => Promise<WriteResult>
  readRows: (
    ctx: CodecCtx,
    key: string,
    dataSource: DataSource,
  ) => Promise<Row[]>
  compactRows: (
    ctx: CodecCtx,
    inputKeys: string[],
    outputKey: string,
    dataSource: DataSource,
  ) => Promise<WriteResult>
}

export interface QueryResult {
  rows: Row[]
  sql: string
  objectKeys: string[]
}

export interface QueryExecuteOptions {
  sql: string
  params: unknown[]
  /**
   * Named placeholder → object keys. The executor substitutes `{{NAME}}`
   * occurrences in the SQL with the matching `read_parquet([...])` list,
   * choosing between virtual-FS names or native URIs based on whether
   * `dataSource.uri` is available.
   */
  fileKeys: Record<string, string[]>
  dataSource: DataSource
  table: TableName
  signal?: AbortSignal
}

export interface QueryExecuteResult {
  rows: Row[]
  /** The final SQL actually run (after placeholder substitution). */
  sql: string
}

export interface QueryExecutor {
  execute: (opts: QueryExecuteOptions) => Promise<QueryExecuteResult>
}

export interface FileSetRef {
  table: TableName
  partitions?: string[]
}

export interface RunSQLOptions {
  ctx: TenantCtx
  /**
   * Named partition references. Each name becomes a `{{NAME}}` placeholder
   * substituted into the SQL with the matching list of object keys. The
   * canonical name is `FILES`; analyzers also use `FILES_PREV` for a prior
   * window. Providing zero fileSets runs the SQL against no files.
   */
  fileSets: Record<string, FileSetRef>
  /** Schema-bearing table; defaults to the first fileSet's table. */
  table?: TableName
  sql: string
  params?: unknown[]
  signal?: AbortSignal
}

export interface StorageEngine {
  writeDay: (ctx: WriteCtx, rows: Row[]) => Promise<void>
  query: (ctx: QueryCtx, state: BuilderState) => Promise<QueryResult>
  /**
   * Run arbitrary SQL resolved against named partition sets. Composes
   * manifest lookup + object reads + placeholder substitution + execution
   * so callers don't need to reach into `ManifestStore`/`DataSource`
   * directly.
   */
  runSQL: (opts: RunSQLOptions) => Promise<QueryResult>
  compactOlderThan: (ctx: WriteCtx, days: number) => Promise<void>
  gcOrphans: (ctx: GcCtx, graceMs: number) => Promise<{ deleted: number }>
  listLive: (filter: ListLiveFilter) => Promise<ManifestEntry[]>
  listAll: (filter: ListLiveFilter) => Promise<ManifestEntry[]>
  getWatermarks: (filter: WatermarkFilter) => Promise<Watermark[]>
  getSyncStates: (filter: SyncStateFilter) => Promise<SyncState[]>
  setSyncState: (scope: SyncStateScope, state: SyncStateKind, detail?: SyncStateDetail) => Promise<void>
  /** Read the raw bytes of a single object. Rarely needed outside the `dump` CLI. */
  readObject: (key: string) => Promise<Uint8Array>
}

export interface EngineOptions {
  dataSource: DataSource
  manifestStore: ManifestStore
  codec: ParquetCodec
  executor: QueryExecutor
  now?: () => number
}

export function dayPartition(date: string): string {
  return `daily/${date}`
}

export function monthPartition(month: string): string {
  return `monthly/${month}`
}

export function objectKey(
  ctx: TenantCtx,
  table: TableName,
  partition: string,
  version: number,
): string {
  const prefix = ctx.siteId
    ? `u_${ctx.userId}/${ctx.siteId}/${table}`
    : `u_${ctx.userId}/${table}`
  return `${prefix}/${partition}__v${version}.parquet`
}

export function tenantPrefix(ctx: TenantCtx): string {
  return ctx.siteId ? `u_${ctx.userId}/${ctx.siteId}/` : `u_${ctx.userId}/`
}

import type { Grain, Row, TableName, TenantCtx } from '@gscdump/contracts'
import type { BuilderState, SearchType } from 'gscdump/query'
import type { ParquetQueryFilter } from 'hyparquet'

export type { Grain, Row, TableName, TenantCtx } from '@gscdump/contracts'
export type { SearchType } from 'gscdump/query'

export interface WriteCtx extends TenantCtx {
  table: TableName
  date?: string
  now?: () => number
  /**
   * GSC search-type partition this write belongs to. Defaults to `'web'`.
   * Non-web values (`discover`, `news`, `googleNews`, `image`, `video`)
   * cause the writer to insert the type into the object key path so files
   * for different search types coexist without colliding.
   */
  searchType?: SearchType
  /**
   * Temporal granularity for this write. `'day'` (default) routes to
   * `writeDay` semantics. `'hour'` routes to `writeHour` — the host (ingest
   * accumulator) interprets this; the engine surfaces both methods directly.
   */
  grain?: Grain
}

/**
 * A closed profiling span: a named slice of read-path work with its
 * wall-clock cost and optional dimensional meta (file counts, row counts).
 * Emitted by an injected {@link QueryProfiler}; see `./profile.ts`.
 */
export interface QuerySpan {
  readonly name: string
  readonly ms: number
  readonly meta?: Readonly<Record<string, string | number | boolean>>
}

/**
 * Injected read-path profiler. `start(name, meta)` opens a span and returns an
 * `end` thunk to call when that work finishes (merging completion-only meta).
 * Absent by default — every emit site optional-chains it, so an unprofiled
 * query pays nothing. Build one with `createQueryProfiler` / `collectSpans`.
 */
export interface QueryProfiler {
  readonly start: (
    name: string,
    meta?: Record<string, string | number | boolean>,
  ) => (extra?: Record<string, string | number | boolean>) => void
}

export interface QueryCtx extends TenantCtx {
  table?: TableName
  signal?: AbortSignal
  /** Optional read-path profiler; forwarded into `runSQL` and the executor. */
  profiler?: QueryProfiler
  /**
   * Restrict the query to a single GSC search-type partition (`web`,
   * `discover`, etc.). Undefined preserves the cross-type union for
   * legacy/web-only deployments; explicit value scopes the read to
   * manifest entries written for that type. Mirrors {@link WriteCtx.searchType}.
   */
  searchType?: SearchType
  /**
   * Temporal granularity for this query. `'day'` (default) reads daily
   * partitions only and skips any `hourly/` partitions. `'hour'` reads only
   * hourly partitions. The two never mix — daily-from-hourly aggregation
   * happens through the `discover-daily-from-hourly` rollup, not at read.
   */
  grain?: Grain
}

export interface GcCtx {
  now?: () => number
  userId?: string
  siteId?: string
  /**
   * Override retention for hourly partitions in milliseconds. Defaults to
   * 90 days inside `gcOrphansImpl`. Hourly is GC-only — never compacted —
   * so this is the only lifecycle knob for `hourly/{date}` entries.
   */
  hourlyRetentionMs?: number
}

/**
 * Compaction tier of a manifest entry. Determines which compactor stage may
 * pick it up as input:
 * - `raw`: per-day file produced by `writeDay`. Eligible for raw→d7 merge at 7d.
 * - `d7`: weekly compaction output. Eligible for d7→d30 merge at 30d.
 * - `d30`: monthly compaction output (matches the legacy `monthly/` partition
 *   shape — pre-tier entries are read as `d30`). Eligible for d30→d90 at 90d.
 * - `d90`: quarterly cold-tier output. Terminal; never recompacted.
 *
 * Without an explicit tier, entries written before this field landed default
 * to `raw` for `daily/` partitions and `d30` for `monthly/` partitions, so
 * the tiered compactor picks the right inputs without a backfill rewrite.
 */
export type CompactionTier = 'raw' | 'd7' | 'd30' | 'd90'

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
  /**
   * Compaction tier. Omitted on entries written before tiered compaction —
   * treat as `raw` for `daily/` partitions and `d30` for `monthly/` partitions
   * (see {@link inferLegacyTier}).
   */
  tier?: CompactionTier
  /**
   * GSC search-type this entry covers (web | discover | news | googleNews |
   * image | video). Omitted on entries written before per-type partitioning
   * landed — treat as `web` (see {@link inferSearchType}). Compaction merges
   * only entries with the same searchType.
   */
  searchType?: SearchType
}

export interface ListLiveFilter {
  userId: string
  siteId?: string
  table?: TableName
  partitions?: string[]
  /**
   * Narrow to a single compaction tier. Tier-aware compaction stages set this
   * so the store doesn't have to return (and the caller doesn't have to scan)
   * the entire manifest just to compact the raw cohort. Legacy entries without
   * an explicit `tier` field match on {@link inferLegacyTier}.
   */
  tier?: CompactionTier
  /**
   * Narrow to a single GSC searchType slice. Undefined means "no filter" — used
   * by cross-type admin paths (GC / orphan sweep, tenant-stats site discovery).
   * Explicit value filters to that slice; pass `'web'` to match the legacy /
   * sentinel-`''` entries via {@link inferSearchType}.
   *
   * Read paths that scope to a single (user, site, table) cohort MUST set this
   * once writes from multiple search types coexist for that cohort, otherwise
   * the result unions web + non-web entries into a single query and double-
   * counts metrics.
   */
  searchType?: SearchType
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
  /**
   * GSC search-type this watermark covers. Omitted = `web` for legacy
   * compatibility with pre-searchType watermarks.
   */
  searchType?: SearchType
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
  searchType?: SearchType
}

export type SyncStateKind = 'pending' | 'inflight' | 'done' | 'failed'

export interface SyncStateScope {
  userId: string
  siteId?: string
  table: TableName
  date: string
  /**
   * GSC search-type this sync state covers. Omitted = `web` (the legacy
   * default; matches pre-#5 sync states stored before per-type sync landed).
   * Lookups must compare via {@link inferSearchType} so a missing field
   * matches an explicit `'web'` and vice versa.
   */
  searchType?: SearchType
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
  searchType?: SearchType
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

export interface PurgeFilter {
  userId: string
  siteId?: string
}

export interface ManifestPurgeResult {
  entriesRemoved: number
  watermarksRemoved: number
  syncStatesRemoved: number
}

export interface PurgeResult {
  userId: string
  siteId?: string
  prefix: string
  objectsDeleted: number
  entriesRemoved: number
  watermarksRemoved: number
  syncStatesRemoved: number
  at: number
}

export interface PurgeUrlsResult {
  userId: string
  siteId?: string
  urlsRequested: number
  entriesRewritten: number
  rowsRemoved: number
  bytesAfter: number
  at: number
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
  /**
   * GDPR-grade tenant purge. Removes every manifest entry, watermark, and
   * sync-state record matching the filter. Does NOT touch the underlying
   * data-source bytes; callers (typically {@link StorageEngine.purgeTenant})
   * remove manifest visibility first, then sweep tenant-prefix bytes so that
   * mid-flight failures cannot leave live manifest entries pointing at deleted
   * objects.
   *
   * On stores with CAS-backed sharding (R2 manifest) this may issue one
   * mutation per shard. On read-only stores (HTTP) this throws.
   */
  purgeTenant: (filter: PurgeFilter) => Promise<ManifestPurgeResult>
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
  /**
   * Per-placeholder table identity. Used by the executor to emit a
   * schema-correct empty fallback when a named file set is empty: an
   * `extraFiles` placeholder against `page_queries` should fall back to
   * the page_queries schema, not the analyzer's primary `table`.
   */
  placeholderTables?: Record<string, TableName>
  /**
   * Per-placeholder row-group pushdown filter, derived from the query's
   * structured filter (see `extractParquetPushdown`). A pure-JS decode executor
   * MAY pass it to the parquet reader to prune row groups and shrink the rows
   * it materialises before the SQL WHERE re-applies. Pure optimization: the
   * filter is a superset of the final predicate, so an executor that ignores it
   * (e.g. native DuckDB, which pushes from the SQL itself) stays correct.
   */
  pushdownFilters?: Record<string, ParquetQueryFilter>
  dataSource: DataSource
  table: TableName
  signal?: AbortSignal
  /**
   * Optional callback invoked by the executor when it detects the DuckDB
   * process is approaching a memory ceiling (e.g. ingesting rows after
   * httpfs decode, or materialising a large temp relation). Callers can
   * shed work, warm a spillover path, or warn the user. Advisory only —
   * not all executors implement it.
   */
  onMemoryPressure?: (info: { bytes?: number, reason: string }) => void
  /**
   * Optional profiler. An instrumented executor emits `files.register` and
   * `query.run` spans through it; an absent profiler is a no-op skip.
   */
  profiler?: QueryProfiler
}

export interface QueryExecuteResult {
  rows: Row[]
  /** The final SQL actually run (after placeholder substitution). */
  sql: string
  /**
   * Optional diagnostics the executor may emit for observability + capacity
   * planning. Undefined on executors that don't instrument their runtime.
   *
   * - `peakBytes`: highest resident memory the engine reported during the
   *   query. Callers may use this to decide whether to drop / compact state
   *   before the next call.
   * - `resetRecommended`: executor thinks the underlying connection should
   *   be recycled (fragmented, near ceiling). Caller-owned decision —
   *   honored by `BrowserAnalysisRuntime` consumers but not enforced.
   */
  diagnostics?: {
    peakBytes?: number
    resetRecommended?: boolean
  }
}

export interface QueryExecutor {
  execute: (opts: QueryExecuteOptions) => Promise<QueryExecuteResult>
}

export interface FileSetRef {
  table: TableName
  partitions?: string[]
  /**
   * Pre-resolved object keys, bypassing the manifest lookup. When provided,
   * runSQL skips `manifestStore.listLive` for this entry and uses these keys
   * directly. Use for entity-store sidecars (`entities/inspections/index.parquet`,
   * `entities/sitemaps/urls/index.parquet`) which aren't registered in the
   * analytics manifest. `table` is still required as the schema sentinel for
   * the empty-fallback rewrite, but isn't consulted when `keys` is non-empty.
   */
  keys?: string[]
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
  /**
   * Restrict every manifest lookup the runner performs to a single
   * search-type slice. Applies uniformly across all `fileSets`; per-
   * fileSet overrides aren't supported (the only multi-fileSet caller,
   * comparison joins, always wants the same slice for both windows).
   * Undefined keeps the legacy cross-type union.
   */
  searchType?: SearchType
  /**
   * Per-placeholder parquet pushdown filter, forwarded verbatim to the
   * executor. Keyed by fileSet name (matching `fileSets`). See
   * `QueryExecuteOptions.pushdownFilters` and `extractParquetPushdown`.
   */
  pushdownFilters?: Record<string, ParquetQueryFilter>
  /**
   * Optional read-path profiler. `runSQL` emits `manifest.list` +
   * `executor.execute` spans and forwards it into the executor for the
   * finer `files.register` / `query.run` breakdown.
   */
  profiler?: QueryProfiler
}

export interface StorageEngine {
  writeDay: (ctx: WriteCtx, rows: Row[]) => Promise<void>
  /**
   * Read-merge-write a single-day hourly partition. Idempotent on
   * `(url, hour)` (last-write-wins): callers can re-fire the same slice
   * after a retry and the partition converges. `ctx.date` is the PT
   * calendar day; rows must carry `hour` + `date` fields. Partition shape
   *  `hourly/{date}`; coexists with daily partitions in the same `table`
   *  prefix (`hourly_pages`).
   */
  writeHour: (ctx: WriteCtx, rows: Row[]) => Promise<void>
  query: (ctx: QueryCtx, state: BuilderState) => Promise<QueryResult>
  /**
   * Run arbitrary SQL resolved against named partition sets. Composes
   * manifest lookup + object reads + placeholder substitution + execution
   * so callers don't need to reach into `ManifestStore`/`DataSource`
   * directly.
   */
  runSQL: (opts: RunSQLOptions) => Promise<QueryResult>
  compactTiered: (ctx: WriteCtx, thresholds?: import('./compaction').CompactionThresholds) => Promise<void>
  /**
   * Write-time half of the manifest tier invariant: retire every live entry
   * whose every covered day is already served by a finer-or-newer live entry.
   *
   * `compactTiered` retires the inputs it merges, but cannot retire a coarse
   * partition that outlived the finer files it should have superseded (a D1→R2
   * backfill writing coarse directly, a re-sync landing fresh dailies after a
   * month already rolled up). Those stale overlaps make the query resolver
   * union the same dates twice. Subsumption is evaluated per searchType, over
   * the full live set (so a `web` monthly never cancels a `discover` weekly),
   * then the subsumed set is retired via the manifest's `registerVersions([], …)`
   * primitive — atomic, no inserts. Safe by construction: it only drops files
   * whose days are already covered, so no data is lost.
   *
   * Reads and retires through the engine's own manifest store, so it is
   * read-your-writes-consistent with the `compactTiered` that precedes it.
   * Returns audit counters. Hosts running a cached manifest store must bust
   * their cache afterwards — the engine has no knowledge of host-side caching.
   */
  reconcileSubsumed: (ctx: WriteCtx) => Promise<{ retired: number, partitions: string[] }>
  gcOrphans: (ctx: GcCtx, graceMs: number) => Promise<{ deleted: number }>
  /**
   * GDPR-grade tenant purge. Deletes every object under the tenant prefix
   * (parquet, rollups, entity stores), then removes manifest/watermark/
   * sync-state records via {@link ManifestStore.purgeTenant}.
   *
   * Order matters: bytes are deleted before manifest entries, so a
   * crash mid-purge leaves orphan manifest records (detectable via the
   * normal orphan sweep) rather than orphan bytes with no record.
   *
   * Returns counters suitable for an audit log. Caller is responsible
   * for persisting the audit entry.
   */
  purgeTenant: (ctx: TenantCtx) => Promise<PurgeResult>
  /**
   * GDPR URL-matcher purge. Deletes rows whose `url` column matches one of
   * `urls` across every live parquet entry for the tenant in tables that
   * carry a `url` column (`pages`, `page_queries`). Tables without a `url`
   * column (`queries`, `countries`, `search_appearance`) are
   * untouched — they never store per-URL data.
   *
   * For each affected entry the engine reads the file, filters the matching
   * rows out, writes a replacement parquet at a new object key, and registers
   * the new entry as a supersede of the old. Entries with no matches are
   * left untouched. Entries with all rows matching are replaced by a
   * schema-bearing empty-rows file.
   *
   * Narrower counterpart to {@link purgeTenant}: use this for a per-URL
   * takedown request; use `purgeTenant` for full-account deletion.
   */
  purgeUrls: (ctx: TenantCtx, urls: readonly string[]) => Promise<PurgeUrlsResult>
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

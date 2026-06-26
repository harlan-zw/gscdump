/**
 * R2 Data Catalog (Iceberg REST catalog) connection + table-definition
 * helpers, built on `icebird`.
 *
 * The icebird spike (2026-05-22) established `icebird` as the ingest writer:
 * a Cloudflare Worker writes Apache Iceberg directly via `icebergAppend()` —
 * no Cloudflare Pipelines, no Container, no PyIceberg. This module is the
 * shared seam both `IcebergAppendSink` (per-slice appends) and the app's
 * one-off table-creation script build on.
 *
 * Two pieces of icebird wiring, identical to the spike:
 *  - `restCatalogConnect` — the R2 Data Catalog REST endpoint, authenticated
 *    with the `R2_CATALOG_TOKEN` bearer.
 *  - `s3SignedResolver` — SigV4-signed R2 S3 access for the parquet/Avro/
 *    metadata objects, using the R2 access-key pair.
 *
 * The 5 fact tables' columns + partition spec are derived from the frozen
 * `ICEBERG_SCHEMAS` contract — never hand-listed here.
 */

import type { Result } from 'gscdump/result'
import type { EngineError } from '../errors'
import type { QueryProfiler } from '../storage'
import type { CatalogCache } from './catalog-cache'
import type { IcebergColumnType, IcebergS3Config, IcebergTableName, PartitionKeyEncoding } from './schema'
import { err, ok } from 'gscdump/result'
import {
  cachingResolver,
  icebergAppend,
  icebergCreateTable,
  icebergDropTable,
  icebergManifests,
  restCatalogConnect,
  restCatalogCreateNamespace,
  restCatalogListTables,
  restCatalogLoadTable,
  s3SignedResolver,
} from 'icebird'
import { engineErrors } from '../errors'
import { TABLE_METADATA } from '../schema'
import { cacheGet, cachePut } from './catalog-cache'

import { buildPartitionFilter } from './partition-prune'
import {
  ICEBERG_PARTITION_SPEC,
  ICEBERG_SCHEMAS,
  ICEBERG_TABLES,
  icebergSchemasFor,
} from './schema'

/** icebird's lowercase Iceberg primitive types (subset we use). */
export type IcebergPrimitiveType = 'string' | 'int' | 'long' | 'double' | 'date'

/** A field in an icebird table `Schema`. */
export interface IcebergSchemaField {
  id: number
  name: string
  required: boolean
  type: IcebergPrimitiveType
}

/** An icebird table `Schema` (Iceberg `struct`). */
export interface IcebergSchema {
  'type': 'struct'
  'schema-id': number
  'fields': IcebergSchemaField[]
}

/** A field in an icebird `PartitionSpec`. */
export interface IcebergPartitionSpecField {
  'source-id': number
  'field-id': number
  'name': string
  'transform': 'identity' | 'month'
}

/** An icebird `PartitionSpec`. */
export interface IcebergPartitionSpec {
  'spec-id': number
  'fields': IcebergPartitionSpecField[]
}

/** A field in an icebird `SortOrder`. */
export interface IcebergSortOrderField {
  'source-id': number
  'transform': 'identity'
  'direction': 'asc' | 'desc'
  'null-order': 'nulls-first' | 'nulls-last'
}

/** An icebird `SortOrder` (Iceberg write-order). */
export interface IcebergSortOrder {
  'order-id': number
  'fields': IcebergSortOrderField[]
}

/** Everything needed to talk to the R2 Data Catalog. */
export interface IcebergCatalogConfig {
  /** REST catalog URI, e.g. `https://catalog.cloudflarestorage.com/<acct>/<warehouse>`. */
  catalogUri: string
  /** Warehouse identifier, e.g. `<acct>_gscdump-analytics`. */
  warehouse: string
  /** Catalog namespace the 5 fact tables live under (e.g. `gsc`). */
  namespace: string
  /** Bearer token for the REST catalog (`R2_CATALOG_TOKEN`). */
  catalogToken: string
  /** R2 S3 credentials for the warehouse objects. */
  s3: IcebergS3Config
}

/** The connected catalog context + a signed S3 resolver — the icebird call inputs. */
export interface IcebergConnection {
  /** icebird REST catalog context, passed as `{ catalog }` to icebird write fns. */
  catalog: Awaited<ReturnType<typeof restCatalogConnect>>
  /** icebird S3 resolver (caching-wrapped), passed as `{ resolver }` to icebird fns. */
  resolver: ReturnType<typeof cachingResolver>
  /** The namespace the fact tables live under. */
  namespace: string
}

const ICEBERG_TYPE_MAP: Record<IcebergColumnType, IcebergPrimitiveType> = {
  STRING: 'string',
  INT: 'int',
  LONG: 'long',
  DOUBLE: 'double',
  DATE: 'date',
}

/**
 * Build the icebird `Schema` for one of the 5 fact tables from the frozen
 * `ICEBERG_SCHEMAS` contract. Field ids are advisory — R2 Data Catalog
 * re-assigns them on `createTable` (see `ICEBERG_FIELD_ID_BASE`).
 */
export function icebergSchemaFor(table: IcebergTableName, encoding: PartitionKeyEncoding = 'string'): IcebergSchema {
  return {
    'type': 'struct',
    'schema-id': 0,
    'fields': icebergSchemasFor(encoding)[table].columns.map(col => ({
      id: col.fieldId,
      name: col.name,
      required: col.required,
      type: ICEBERG_TYPE_MAP[col.type],
    })),
  }
}

/**
 * Build the icebird `PartitionSpec` for one of the 5 fact tables: the locked
 * spec `identity(site_id) + identity(search_type) + month(date)`. Each
 * partition field's `source-id` is resolved to the real column field id from
 * {@link icebergSchemaFor}.
 */
export function icebergPartitionSpecFor(table: IcebergTableName, encoding: PartitionKeyEncoding = 'string'): IcebergPartitionSpec {
  const fields = icebergSchemasFor(encoding)[table].columns
  const fieldId = (name: string): number => {
    const col = fields.find(c => c.name === name)
    if (!col)
      throw new Error(`iceberg-catalog: table '${table}' has no '${name}' column`)
    return col.fieldId
  }
  return {
    'spec-id': 0,
    'fields': ICEBERG_PARTITION_SPEC.map((p, i) => ({
      'source-id': fieldId(p.sourceColumn),
      'field-id': 1000 + i,
      'name': p.name,
      'transform': p.transform,
    })),
  }
}

/**
 * Build the icebird `SortOrder` for a fact table from its `clusterKey`
 * (dimension-first, then `date`) — e.g. `pages` → sort by `url`, then `date`.
 *
 * Declared so any sort-aware compaction (a self-run `icebergRewrite`, or R2
 * managed compaction if/when it honors sort order) re-clusters merged files the
 * same way the append path already orders them ({@link sortByClusterKey} in
 * `append-sink.ts`). R2's managed compaction currently only bin-packs small
 * files without re-sorting, so this is forward-looking: it costs nothing today
 * (the table simply carries the metadata) and means a future sort-aware pass
 * produces globally clustered files for free, maximizing row-group skipping on
 * the DuckDB-over-R2 read path. clusterKey columns are all non-null, so the
 * null ordering is moot; `identity`/`asc` mirrors the physical write order.
 */
export function icebergSortOrderFor(table: IcebergTableName, encoding: PartitionKeyEncoding = 'string'): IcebergSortOrder {
  const fields = icebergSchemasFor(encoding)[table].columns
  const fieldId = (name: string): number => {
    const col = fields.find(c => c.name === name)
    if (!col)
      throw new Error(`iceberg-catalog: table '${table}' has no '${name}' column`)
    return col.fieldId
  }
  return {
    'order-id': 1,
    'fields': TABLE_METADATA[table].clusterKey.map(col => ({
      'source-id': fieldId(col),
      'transform': 'identity',
      'direction': 'asc',
      'null-order': 'nulls-last',
    })),
  }
}

/** Options for {@link connectIcebergCatalog}. */
export interface ConnectIcebergOptions {
  /**
   * Optional cross-isolate cache (any unstorage driver). When supplied, the
   * `/v1/config` REST probe is served from cache on a warm catalog, removing
   * one serial network hop from cold-isolate connects. The bearer token is
   * NEVER cached — only the warehouse-static routing config (`url`, `prefix`,
   * `defaults`, `overrides`) is; `requestInit` is rebuilt from `config`.
   */
  cache?: CatalogCache
  /** Injectable clock for the cache TTL. Defaults to `Date.now`. */
  clock?: () => number
}

/** The serialisable, secret-free part of an icebird REST catalog context. */
interface CachedCatalogConfig {
  url: string
  prefix: string
  defaults: Record<string, string>
  overrides: Record<string, string>
}

/**
 * TTL on the cached `/v1/config` routing config. It is warehouse-static
 * (changes only if R2 re-points the warehouse prefix), so a generous TTL is
 * safe; a miss costs one `/v1/config` probe, never a wrong route.
 */
const CATALOG_CONFIG_TTL_MS = 60 * 60 * 1000

function catalogConfigKey(config: IcebergCatalogConfig): string {
  // Keyed by warehouse identity, not the token: `/v1/config` depends on the
  // warehouse + endpoint, and the token must not enter the cache.
  return `gsc-catalog-cfg\0${config.catalogUri}\0${config.warehouse}`
}

/**
 * Connect to the R2 Data Catalog: a REST catalog context + a signed S3
 * resolver. Runs in Node and in `workerd` — SigV4 is Web Crypto, I/O is
 * `fetch`, no node builtins.
 *
 * With a `cache`, the `/v1/config` probe is skipped on a warm catalog and the
 * context is rebuilt from the cached routing config plus the freshly-derived
 * bearer `requestInit`. icebird reads only `url`/`prefix`/`requestInit` from
 * the context downstream, so this is a faithful, secret-free reconstruction.
 */
export async function connectIcebergCatalog(
  config: IcebergCatalogConfig,
  opts: ConnectIcebergOptions = {},
): Promise<IcebergConnection> {
  const now = (opts.clock ?? Date.now)()
  const requestInit = { headers: { Authorization: `Bearer ${config.catalogToken}` } }

  let catalog: Awaited<ReturnType<typeof restCatalogConnect>> | undefined
  if (opts.cache) {
    const cached = await cacheGet<CachedCatalogConfig>(opts.cache, catalogConfigKey(config), now)
    if (cached) {
      catalog = Object.freeze({
        type: 'rest' as const,
        url: cached.url,
        prefix: cached.prefix,
        defaults: cached.defaults,
        overrides: cached.overrides,
        requestInit,
      })
    }
  }
  if (!catalog) {
    catalog = await restCatalogConnect({
      url: config.catalogUri,
      warehouse: config.warehouse,
      requestInit,
    })
    if (opts.cache) {
      const toCache: CachedCatalogConfig = {
        url: catalog.url,
        prefix: catalog.prefix,
        defaults: catalog.defaults,
        overrides: catalog.overrides,
      }
      await cachePut(opts.cache, catalogConfigKey(config), toCache, CATALOG_CONFIG_TTL_MS, now)
    }
  }

  // Wrap the signed resolver in icebird's `cachingResolver`: reads of the same
  // manifest-list / manifest avro share one fetch and one in-memory buffer for
  // the life of the connection (the in-isolate complement to the cross-isolate
  // `CatalogCache`). Iceberg objects are written at fresh per-commit paths, so
  // path-level memoisation is always fresh under R2's managed compaction — a
  // new snapshot's manifests live at new paths and miss the cache cleanly;
  // writes through this resolver invalidate their own path on success.
  const resolver = cachingResolver(s3SignedResolver({
    accessKeyId: config.s3.accessKeyId,
    secretAccessKey: config.s3.secretAccessKey,
    region: config.s3.region ?? 'auto',
    endpoint: config.s3.endpoint,
    pathStyle: true,
  }))
  return { catalog, resolver, namespace: config.namespace }
}

// ---------------------------------------------------------------------------
// 429 commit-retry — R2 Data Catalog rate-limits.
// ---------------------------------------------------------------------------
//
// icebird's `commitWithRetry` retries 412/409 optimistic-concurrency
// conflicts internally (50 attempts, full-jitter back-off, without
// re-uploading data files — only the per-attempt manifest list + metadata
// json are rewritten). It treats every other status — including R2 Data
// Catalog's `429 too many commits to this table` — as fatal. Under the
// Phase-3 re-backfill, many sync Workers commit to the same hot global table
// concurrently, so 429s are expected. This wrapper closes that gap.

/** Tunable retry policy for {@link icebergAppendRetrying}. */
export interface CommitRetryOptions {
  /** Total attempts, including the first. Default 6. */
  maxAttempts?: number
  /** Base (ms) for the exponential back-off ceiling. Default 1000. */
  baseDelayMs?: number
  /** Hard cap (ms) on the back-off ceiling. Default 20_000. */
  maxDelayMs?: number
  /** Injectable sleep — tests pass a synchronous no-op. */
  sleep?: (ms: number) => Promise<void>
  /** Injectable RNG for the jitter — tests pass a deterministic value. */
  random?: () => number
}

/**
 * True when `err` is an R2 Data Catalog commit rate-limit response
 * (`429 too many commits to this table`). Matches a numeric `status` of 429
 * or the message text, so it holds whether icebird surfaces the raw HTTP
 * error or a wrapped `Error`.
 */
export function isCommitRateLimited(err: unknown): boolean {
  if (err && typeof err === 'object' && (err as { status?: unknown }).status === 429)
    return true
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase()
  return msg.includes('429') || msg.includes('too many commits') || msg.includes('rate limit')
}

function defaultCommitSleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/**
 * `icebergAppend` wrapped with retry on R2 Data Catalog 429 commit
 * rate-limits, using full-jitter exponential back-off. icebird already
 * retries 412/409 internally; 429 is the gap this closes. Non-429 errors
 * (and 429s that survive every attempt) propagate unchanged.
 *
 * RESIDUAL RISK — re-upload orphans. icebird's `icebergAppend` prepares the
 * data + manifest files ONCE, outside its internal 412/409 retry loop, so
 * those retries never re-upload data. A 429 that escapes that loop and is
 * retried HERE re-runs the whole `icebergAppend` call, which re-prepares and
 * re-uploads the data files; the previous attempt's parquet objects become
 * orphans (referenced by no snapshot). 429s should be rare and clear within
 * an attempt or two, so orphan volume is small, and R2 orphan-file cleanup
 * reclaims them. Eliminating the 429 source entirely (per-table commit
 * coalescing) is assessed in the Phase-1.5 report.
 */
export async function icebergAppendRetrying(
  args: Parameters<typeof icebergAppend>[0],
  options: CommitRetryOptions = {},
): Promise<void> {
  const maxAttempts = options.maxAttempts ?? 6
  const baseDelayMs = options.baseDelayMs ?? 1000
  const maxDelayMs = options.maxDelayMs ?? 20_000
  const sleep = options.sleep ?? defaultCommitSleep
  const random = options.random ?? Math.random

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const err = await icebergAppend(args).then(() => undefined, (e: unknown) => e)
    if (err === undefined)
      return
    if (!isCommitRateLimited(err) || attempt === maxAttempts - 1)
      throw err
    // Full-jitter back-off: a uniform random delay in [0, ceiling), the
    // ceiling growing exponentially and capped at `maxDelayMs`. Jitter stops
    // concurrent writers from stampeding the catalog in lock-step.
    const ceiling = Math.min(maxDelayMs, baseDelayMs * 2 ** attempt)
    await sleep(Math.floor(random() * ceiling))
  }
}

/**
 * Outcome of a single table create/drop: the table name plus a `Result` —
 * `Ok(void)` on success, `Err(iceberg-table-op-failed)` carrying the failure
 * message (and original `cause`) when the catalog rejects the op (e.g. "table
 * already exists", a 5xx). Per-table so a partial provisioning run is fully
 * observable; the human-readable string lives on `error.message`.
 */
export interface IcebergTableOpResult {
  table: string
  outcome: Result<void, EngineError>
}

/**
 * Ensure the catalog namespace exists. Idempotent — an "already exists"
 * response from the REST catalog is swallowed.
 */
export async function ensureIcebergNamespace(conn: IcebergConnection): Promise<void> {
  await restCatalogCreateNamespace(conn.catalog, { namespace: conn.namespace })
    .catch(() => {
      // namespace already exists — fine
    })
}

/**
 * Create the global Iceberg fact tables with the locked partition spec
 * (`identity(site_id) + identity(search_type) + month(date)`) and the schema
 * derived from {@link ICEBERG_SCHEMAS}. Per-table errors are captured rather
 * than thrown so a partial run is observable; "table already exists" surfaces
 * as a failed result. Used by the app's one-off provisioning script.
 */
export async function createIcebergTables(
  conn: IcebergConnection,
  tables: readonly IcebergTableName[] = ICEBERG_TABLES,
  encoding: PartitionKeyEncoding = 'string',
): Promise<IcebergTableOpResult[]> {
  const results: IcebergTableOpResult[] = []
  for (const table of tables) {
    // REST catalog `createTable` delegates to the catalog endpoint — no S3
    // resolver needed (unlike `icebergAppend`, which writes data files).
    await icebergCreateTable({
      catalog: conn.catalog,
      namespace: conn.namespace,
      table,
      schema: icebergSchemaFor(table, encoding),
      partitionSpec: icebergPartitionSpecFor(table, encoding),
      sortOrder: icebergSortOrderFor(table, encoding),
    }).then(
      () => results.push({ table, outcome: ok(undefined) }),
      (e: unknown) => results.push({ table, outcome: err(engineErrors.icebergTableOpFailed('create', table, e)) }),
    )
  }
  return results
}

/**
 * List the table names currently in the catalog namespace.
 *
 * A genuinely-empty namespace resolves to `[]`. A LIST *failure* (catalog
 * unreachable, 401/403, 5xx) propagates rather than being masked as an empty
 * list — callers must be able to tell "no tables" from "couldn't ask".
 */
export async function listIcebergTables(conn: IcebergConnection): Promise<string[]> {
  const list = await restCatalogListTables(conn.catalog, { namespace: conn.namespace })
  return list.map(t => t.name).sort()
}

// ---------------------------------------------------------------------------
// Read path — list data files for a partition slice.
// ---------------------------------------------------------------------------
//
// `analysis-sources.get.ts` consumes this to build presigned URLs the browser
// downloads into OPFS. Wave 3 of the Iceberg re-architecture: reads must come
// from the catalog so the browser sees what the ingest sink writes, not the
// legacy `r2_manifest`.

/** A data file in the current snapshot's manifest, scoped to one partition. */
export interface IcebergListedDataFile {
  /** Raw Iceberg `data_file.file_path` (e.g. `s3://gscdump-analytics/.../x.parquet`). */
  filePath: string
  /** Object key relative to the warehouse bucket (the part after `s3://<bucket>/`). */
  objectKey: string
  bytes: number
  rowCount: number
}

export interface ListIcebergDataFilesOptions {
  table: IcebergTableName
  /** Partition identity column. `number` for `'int'`-encoded catalogs. */
  siteId: string | number
  /** Partition identity column. `number` (int code) for `'int'`-encoded catalogs. */
  searchType: string | number
  /**
   * Partition-key encoding of the catalog. `'int'` changes how manifest-summary
   * bounds are decoded (int bytes vs UTF-8) and how the per-file partition value
   * is compared. Defaults to `'string'`.
   */
  encoding?: PartitionKeyEncoding
  /**
   * Inclusive date range. Every month touched by `[start, end]` is scanned;
   * `month(date)` is the third partition transform.
   */
  range: { start: string, end: string }
  /**
   * Optional cross-isolate cache (any unstorage driver). When supplied, the
   * snapshot pointer is cached short (so a warm catalog skips `loadTable`) and
   * the resolved file list is cached long, content-addressed by snapshot id
   * (so it skips the manifest walk). Omit it to read straight from the catalog.
   */
  cache?: CatalogCache
  /** Injectable clock for the cache TTLs. Defaults to `Date.now`. */
  clock?: () => number
  /**
   * Optional read-path profiler. Emits `iceberg.snapshot` (snapshot-pointer
   * load), `iceberg.cache` (resolved-files lookup + hit/miss), and
   * `iceberg.walk` (manifest fetch + entry scan, with manifest/file counts) —
   * the catalog cold-start breakdown a hosted reader wants in `Server-Timing`.
   */
  profiler?: QueryProfiler
}

/**
 * TTL on the cached snapshot pointer `(namespace, table) → snapshotId`. Bounds
 * how long a reader serves a previous snapshot after a new commit.
 *
 * Raised 30s → 30min after profiling the bulk file-resolution path: a pointer
 * MISS is NOT cheap — it costs one `restCatalogLoadTable`, measured at ~1.8s
 * cold (the dominant phase of a ~3.5s resolve). At 30s nearly every real
 * navigation re-paid that 1.8s. The original "a miss is cheap" assumption was
 * wrong; the round-trip is the single most expensive read-path phase. 30min
 * keeps the pointer warm across a whole working session, so cold-first only
 * hits genuinely-idle tables.
 *
 * Safe to lengthen because staleness here is benign and bounded:
 *   - the resolved-files cache is keyed by the (immutable) snapshotId, so a
 *     slightly-stale pointer returns a SELF-CONSISTENT file set, never a torn read;
 *   - the recent-window overlay is HEADed fresh on every resolve, so the
 *     non-stable tail (the data users actually watch move) stays current
 *     regardless of pointer age;
 *   - GSC lake data lags days and finalizes hourly, so a ≤5min-old stable
 *     snapshot is indistinguishable to the user.
 * A new sync commits a new snapshotId; the next post-TTL refresh picks it up.
 */
const SNAPSHOT_REF_TTL_MS = 30 * 60 * 1000

/**
 * Long TTL on the resolved file list. The cache key embeds the immutable
 * `snapshotId`, so a hit is always correct within its lifetime — a new sync
 * commits a NEW snapshot id and therefore a NEW key. A long TTL just maximises
 * the cross-isolate hit rate; old snapshots' keys expire on their own.
 */
const RESOLVED_FILES_TTL_MS = 24 * 60 * 60 * 1000

/**
 * TTL on the cached table metadata, keyed by the IMMUTABLE snapshotId (so a hit
 * is always correct — a new sync mints a new snapshotId hence a new key). Lets a
 * resolved-files MISS that arrived with a warm snapshot pointer (metadata
 * unloaded) walk WITHOUT re-paying the ~1.8s `restCatalogLoadTable` reload. 24h
 * to match the resolved-files list it serves alongside.
 */
const METADATA_TTL_MS = 24 * 60 * 60 * 1000

/**
 * Size guard on the cached metadata. `metadata.json` is normally small — schema
 * + partition specs + the snapshot LIST (each entry is an id + manifest-list
 * path + summary), NOT the per-file entry arrays that live in manifests and once
 * blew past the 25MB KV ceiling. A pathological snapshot history could still
 * bloat it, so over-budget docs are simply not cached (the reload path still
 * works); this keeps the metadata cache from ever reintroducing the KV-blob risk.
 */
const MAX_CACHED_METADATA_BYTES = 2 * 1024 * 1024

function snapshotRefKey(namespace: string, table: string): string {
  return `gsc-snapref\0${namespace}\0${table}`
}

function metadataRefKey(namespace: string, table: string, snapshotId: string): string {
  return `gsc-snapmeta\0${namespace}\0${table}\0${snapshotId}`
}

function resolvedFilesKey(
  namespace: string,
  table: string,
  snapshotId: string,
  siteId: string | number,
  searchType: string | number,
  wantedMonths: ReadonlySet<number>,
): string {
  const months = [...wantedMonths].sort((a, b) => a - b).join(',')
  return `gsc-files\0${namespace}\0${table}\0${snapshotId}\0${siteId}\0${searchType}\0${months}`
}

/**
 * Months covering `[start, end]` inclusive, as `YYYY-MM`. Walks calendar
 * boundaries so the result is correct regardless of day-of-month.
 */
function monthsInRange(range: { start: string, end: string }): string[] {
  const [sy, sm] = range.start.split('-').map(Number) as [number, number]
  const [ey, em] = range.end.split('-').map(Number) as [number, number]
  const out: string[] = []
  let y = sy
  let m = sm
  while (y < ey || (y === ey && m <= em)) {
    out.push(`${y}-${String(m).padStart(2, '0')}`)
    m++
    if (m > 12) {
      m = 1
      y++
    }
  }
  return out
}

/**
 * Iceberg's `month(date)` transform value: months since 1970-01-01.
 * `2026-05` → `(2026 - 1970) * 12 + (5 - 1)` = 676.
 */
function monthsSinceEpoch(ym: string): number {
  const [y, m] = ym.split('-').map(Number) as [number, number]
  return (y - 1970) * 12 + (m - 1)
}

/**
 * Extract the warehouse-relative object key from an Iceberg `s3://bucket/key`
 * file path. Returns the input unchanged when it isn't an `s3://` URL.
 */
function stripBucket(filePath: string): string {
  if (!filePath.startsWith('s3://'))
    return filePath
  const rest = filePath.slice(5)
  const slash = rest.indexOf('/')
  return slash >= 0 ? rest.slice(slash + 1) : rest
}

type LoadedTableMetadata = Awaited<ReturnType<typeof restCatalogLoadTable>>['metadata']

/** Load the current snapshot id for a table, via the cache when one is given. */
async function loadSnapshotId(
  conn: IcebergConnection,
  opts: ListIcebergDataFilesOptions,
  now: number,
): Promise<{ snapshotId: string | null, metadata: LoadedTableMetadata | null }> {
  if (opts.cache) {
    const cached = await cacheGet<string>(opts.cache, snapshotRefKey(conn.namespace, opts.table), now)
    // `null` is cached for a genuinely-empty table; a string is a live pointer.
    // Either way we skip `loadTable` and the metadata stays unloaded — only a
    // resolved-files MISS below forces the metadata fetch for the walk.
    if (cached !== undefined)
      return { snapshotId: cached, metadata: null }
  }
  const { metadata } = await restCatalogLoadTable(conn.catalog, {
    namespace: conn.namespace,
    table: opts.table,
  })
  const raw = metadata['current-snapshot-id']
  const snapshotId = raw == null ? null : String(raw)
  if (opts.cache) {
    await cachePut(opts.cache, snapshotRefKey(conn.namespace, opts.table), snapshotId, SNAPSHOT_REF_TTL_MS, now)
    // Also cache the metadata, keyed by the immutable snapshotId, so a later
    // resolved-files MISS arriving with a warm pointer (metadata unloaded) can
    // walk without re-paying this ~1.8s loadTable. Size-guarded so a bloated
    // snapshot history can never push a giant value into KV.
    if (snapshotId != null) {
      const serialized = JSON.stringify(metadata)
      if (serialized.length <= MAX_CACHED_METADATA_BYTES)
        await cachePut(opts.cache, metadataRefKey(conn.namespace, opts.table, snapshotId), metadata, METADATA_TTL_MS, now)
    }
  }
  return { snapshotId, metadata }
}

/**
 * List the parquet data files in the current snapshot of `table`, filtered to a
 * single partition slice `(siteId, searchType, month(date) ∈ range)`.
 *
 * The shared `gsc.<table>` tables are multi-tenant, so a naive walk is O(all
 * tenants). This prunes the manifest LIST by partition summaries before
 * fetching any manifest's entries (see {@link buildPartitionFilter}), making
 * the fetch count independent of tenant count, and — when an unstorage `cache`
 * is supplied — skips the `loadTable` round-trip on a warm snapshot pointer and
 * the manifest walk entirely on a resolved-files hit. The final entry-level
 * partition filter is the authoritative correctness check; pruning only avoids
 * reading manifests that cannot match.
 *
 * Skips deleted entries (status=2) and non-data file types (delete files).
 * Returns object keys + bytes + rowCount so the caller can build presigned
 * URLs without re-walking the catalog.
 */
export async function listIcebergDataFiles(
  conn: IcebergConnection,
  opts: ListIcebergDataFilesOptions,
): Promise<IcebergListedDataFile[]> {
  const profiler = opts.profiler
  const now = (opts.clock ?? Date.now)()
  const wantedMonths = new Set(monthsInRange(opts.range).map(monthsSinceEpoch))

  const endSnapshot = profiler?.start('iceberg.snapshot')
  let { snapshotId, metadata } = await loadSnapshotId(conn, opts, now)
  // `metadata == null` with a live id means the snapshot pointer came warm from
  // the cache (the `loadTable` round-trip was skipped).
  endSnapshot?.({ cached: metadata == null && snapshotId != null })
  // No current snapshot — table exists but is empty. Empty list is correct.
  if (snapshotId == null)
    return []

  // Resolved-files cache is content-addressed by the (cached, possibly stale)
  // snapshot id. A hit returns without loading metadata or walking manifests.
  const filesKey = resolvedFilesKey(conn.namespace, opts.table, snapshotId, opts.siteId, opts.searchType, wantedMonths)
  if (opts.cache) {
    const endCache = profiler?.start('iceberg.cache')
    const cached = await cacheGet<IcebergListedDataFile[]>(opts.cache, filesKey, now)
    endCache?.({ hit: cached !== undefined })
    if (cached !== undefined)
      return cached
  }

  // Miss — we must walk, which needs real metadata. A warm snapshot pointer gave
  // us `metadata == null`. First try the snapshotId-keyed metadata cache: the
  // snapshot's metadata is immutable, so recovering it here walks the SAME
  // snapshot the resolved-files key was built from, WITHOUT the ~1.8s loadTable.
  if (!metadata && opts.cache) {
    const cachedMeta = await cacheGet<LoadedTableMetadata>(opts.cache, metadataRefKey(conn.namespace, opts.table, snapshotId), now)
    if (cachedMeta != null)
      metadata = cachedMeta
  }
  // Still no metadata (cache miss, or none supplied). Reload uncached — and
  // because a cached pointer can be stale, re-key the walk result against the
  // genuinely-current snapshot the reload returns.
  if (!metadata) {
    const reloaded = await loadSnapshotId(conn, { ...opts, cache: undefined }, now)
    snapshotId = reloaded.snapshotId
    metadata = reloaded.metadata
    if (snapshotId == null || !metadata)
      return []
  }

  const endWalk = profiler?.start('iceberg.walk')
  const partitionFilter = buildPartitionFilter(opts.siteId, opts.searchType, wantedMonths, opts.encoding ?? 'string')
  const manifests = await icebergManifests({ metadata, resolver: conn.resolver, partitionFilter })

  // Authoritative per-file partition check. Compare via String() so it is robust
  // across encodings: 'string' → uuid vs uuid; 'int' → the manifest's numeric
  // site_id/search_type vs the numeric opts values (number/number, or even
  // number/bigint, all coerce consistently).
  const wantSite = String(opts.siteId)
  const wantSearch = String(opts.searchType)
  const out: IcebergListedDataFile[] = []
  for (const m of manifests) {
    for (const entry of m.entries) {
      if (entry.status === 2)
        continue
      const df = entry.data_file
      if (df.content !== 0)
        continue
      const part = df.partition as Record<string, unknown>
      if (String(part.site_id) !== wantSite)
        continue
      if (String(part.search_type) !== wantSearch)
        continue
      const month = part.date_month
      if (typeof month !== 'number' || !wantedMonths.has(month))
        continue
      out.push({
        filePath: df.file_path,
        objectKey: stripBucket(df.file_path),
        bytes: Number(df.file_size_in_bytes),
        rowCount: Number(df.record_count),
      })
    }
  }
  endWalk?.({ manifests: manifests.length, files: out.length })

  if (opts.cache) {
    // Re-key against the freshly-loaded snapshot id (the cached one may have
    // been stale). Awaited only when no `defer` hook is set, so the write is
    // never cut off when the response returns.
    const freshKey = resolvedFilesKey(conn.namespace, opts.table, snapshotId, opts.siteId, opts.searchType, wantedMonths)
    await cachePut(opts.cache, freshKey, out, RESOLVED_FILES_TTL_MS, now)
  }
  return out
}

/**
 * Drop tables from the catalog namespace, purging their data objects.
 * Defaults to every table currently in the namespace — used to clear the
 * wrong-spec Pipelines-provisioned `gsc.*` tables before re-creating them.
 */
export async function dropIcebergTables(
  conn: IcebergConnection,
  tables?: readonly string[],
): Promise<IcebergTableOpResult[]> {
  // Discovering the default target set via LIST: a failure here must surface,
  // not collapse to `[]` (which would silently drop nothing while reporting
  // success). An empty namespace still legitimately resolves to `[]`.
  const targets = tables
    ?? (await restCatalogListTables(conn.catalog, { namespace: conn.namespace }))
      .map(t => t.name)
  const results: IcebergTableOpResult[] = []
  for (const table of targets) {
    await icebergDropTable({
      catalog: conn.catalog,
      namespace: conn.namespace,
      table,
      purgeRequested: true,
    }).then(
      () => results.push({ table, outcome: ok(undefined) }),
      (e: unknown) => results.push({ table, outcome: err(engineErrors.icebergTableOpFailed('drop', table, e)) }),
    )
  }
  return results
}

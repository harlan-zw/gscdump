/**
 * R2 Data Catalog (Iceberg REST catalog) connection + generic read/write
 * primitives, built on `icebird` (ADR-0021 "clean moves": connect /
 * ensureNamespace / list / drop / `icebergAppendRetrying` (+ append-id
 * idempotency) / the data-file resolver — all dataset-agnostic already).
 *
 * Raw `icebird` primitives (`icebergCreateTable`, `icebergManifests`,
 * `restCatalogLoadTable`) are NOT re-exported from here for public consumption
 * — see `./unsafe-raw.ts` (ADR-0021 amendment 1). This module uses them
 * internally.
 */

import type { ManifestReadCache } from 'icebird/src/manifest.js'
import type {
  icebergAppend,
  icebergAppendBatches,
} from 'icebird/src/write/write.js'
import type { AppendIdentity } from './append-identity'
import type { CatalogCache, CatalogCacheGetOutcome } from './catalog-cache'
import type { IcebergFieldSummary, ManifestPartitionFilter, PartitionValueMatch } from './partition-prune'
import type { IcebergPartitionField, IcebergPrimitiveType, IcebergS3Config } from './schema'
import {
  restCatalogConnect,
  restCatalogCreateNamespace,
  restCatalogListTables,
  restCatalogLoadTable,
} from 'icebird/src/catalog/rest.js'
import { cachingResolver } from 'icebird/src/fetch.js'
import { icebergManifests } from 'icebird/src/manifest.js'
import { s3SignedResolver } from 'icebird/src/s3.js'
import { deriveAppendIdentity } from './append-identity'
import { stringifyBigintSafe } from './bigint'
import { cacheGet, cachePut, reportCatalogCacheError } from './catalog-cache'
import { toIcebergDayCount } from './date'
import { buildManifestPartitionFilter, manifestMonthBucket, MULTI_MONTH_MANIFEST } from './partition-prune'

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
  /** Warehouse identifier, e.g. `<acct>_<bucket>`. */
  warehouse: string
  /** Catalog namespace the dataset's table lives under (e.g. `gsc`, `crawl`). */
  namespace: string
  /** Bearer token for the REST catalog. */
  catalogToken: string
  /** R2 S3 credentials for the warehouse objects. */
  s3: IcebergS3Config
}

const connectionReadBatch = Symbol('iceberg-connection-read-batch')

/** The connected catalog context + a signed S3 resolver — the icebird call inputs. */
export interface IcebergConnection {
  /** icebird REST catalog context, passed as `{ catalog }` to icebird write fns. */
  catalog: Awaited<ReturnType<typeof restCatalogConnect>>
  /** icebird S3 resolver (caching-wrapped), passed as `{ resolver }` to icebird fns. */
  resolver: ReturnType<typeof cachingResolver>
  /** The namespace the dataset's table lives under. */
  namespace: string
  /**
   * Catalog identity baked into every cross-isolate cache key. Namespaces are
   * NOT unique across catalogs (every per-team catalog uses the same 'gsc'
   * namespace) while deployments share one KV, so a key of (namespace, table)
   * alone lets one team's snapshot pointer/metadata poison every other team's
   * reads. Set by {@link connectIcebergCatalog}; hand-built connections may
   * omit it ONLY when their cache is not shared across catalogs.
   */
  cacheScope?: string
  /** Concurrent reads share decoded metadata only while their batch is active. */
  [connectionReadBatch]?: ConnectionReadBatch
}

interface ConnectionReadBatch {
  active: number
  snapshots: Map<CatalogCache['storage'] | undefined, Map<string, Promise<{ snapshotId: string | null, metadata: LoadedTableMetadata | null }>>>
  manifests: Map<string, ManifestReadCache>
}

function beginConnectionRead(conn: IcebergConnection): () => void {
  const batch = conn[connectionReadBatch]
  if (!batch)
    return () => {}
  batch.active++
  return () => {
    batch.active--
    if (batch.active === 0) {
      batch.snapshots.clear()
      batch.manifests.clear()
    }
  }
}

function manifestReadCacheFor(conn: IcebergConnection, namespace: string, table: string, metadata: LoadedTableMetadata): ManifestReadCache | undefined {
  const batch = conn[connectionReadBatch]
  if (!batch || batch.active === 0)
    return undefined
  const snapshotId = metadata['current-snapshot-id']
  if (snapshotId == null)
    return undefined
  const key = `${conn.cacheScope ?? ''}\0${namespace}\0${table}\0${snapshotId}`
  let cache = batch.manifests.get(key)
  if (!cache) {
    cache = { lists: new Map(), entries: new Map() }
    batch.manifests.set(key, cache)
  }
  return cache
}

/** Options for {@link connectIcebergCatalog}. */
export interface ConnectIcebergOptions {
  /**
   * Optional cross-isolate cache (any unstorage driver). When supplied, the
   * `/v1/config` REST probe is served from cache on a warm catalog.
   */
  cache?: CatalogCache
  /** Injectable clock for the cache TTL. Defaults to `Date.now`. */
  clock?: () => number
  /** Optional connection-stage timings. Spans carry no catalog coordinates. */
  profiler?: QueryProfiler
}

function startConnectSpan(profiler: QueryProfiler | undefined, name: string): ((meta: Record<string, string | number | boolean>) => void) | undefined {
  if (!profiler)
    return undefined
  // Profiling is diagnostic. A broken observer must not change a catalog read.
  try {
    const end = profiler.start(name)
    if (!end)
      return undefined
    return (meta) => {
      try {
        end(meta)
      }
      catch {}
    }
  }
  catch {
    return undefined
  }
}

/** The serialisable, secret-free part of an icebird REST catalog context. */
interface CachedCatalogConfig {
  url: string
  prefix: string
  defaults: Record<string, string>
  overrides: Record<string, string>
}

type IcebergResolver = ReturnType<typeof cachingResolver>
type IcebergWriter = ReturnType<NonNullable<IcebergResolver['writer']>>
type IcebirdWriteModule = typeof import('icebird/src/write/write.js')

let icebirdWriteModule: Promise<IcebirdWriteModule> | undefined

function useIcebirdWriteModule(): Promise<IcebirdWriteModule> {
  icebirdWriteModule ??= import('icebird/src/write/write.js')
  return icebirdWriteModule
}

/**
 * TTL on the cached `/v1/config` routing config. It is warehouse-static
 * (changes only if R2 re-points the warehouse prefix), so a generous TTL is
 * safe; a miss costs one `/v1/config` probe, never a wrong route.
 */
const CATALOG_CONFIG_TTL_MS = 60 * 60 * 1000

function catalogConfigKey(config: IcebergCatalogConfig): string {
  return `lakehouse-catalog-cfg\0${config.catalogUri}\0${config.warehouse}`
}

/**
 * Connect to the R2 Data Catalog: a REST catalog context + a signed S3
 * resolver. Runs in Node and in `workerd` — SigV4 is Web Crypto, I/O is
 * `fetch`, no node builtins.
 */
export async function connectIcebergCatalog(
  config: IcebergCatalogConfig,
  opts: ConnectIcebergOptions = {},
): Promise<IcebergConnection> {
  const now = (opts.clock ?? Date.now)()
  const requestInit = { headers: { Authorization: `Bearer ${config.catalogToken}` } }

  let catalog: Awaited<ReturnType<typeof restCatalogConnect>> | undefined
  if (opts.cache) {
    const endCache = startConnectSpan(opts.profiler, 'catalog.config.cache')
    const cacheRead: { outcome: CatalogCacheGetOutcome } = { outcome: 'miss' }
    const cached = await cacheGet<CachedCatalogConfig>(opts.cache, catalogConfigKey(config), now, (outcome) => {
      cacheRead.outcome = outcome
    })
    endCache?.({ outcome: cacheRead.outcome === 'hit' && !cached ? 'invalid' : cacheRead.outcome })
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
    const endRest = startConnectSpan(opts.profiler, 'catalog.config.rest')
    let restOutcome: 'ok' | 'error' = 'error'
    try {
      catalog = await restCatalogConnect({
        url: config.catalogUri,
        warehouse: config.warehouse,
        requestInit,
      })
      restOutcome = 'ok'
    }
    finally {
      endRest?.({ outcome: restOutcome })
    }
    if (opts.cache) {
      const toCache: CachedCatalogConfig = {
        url: catalog.url,
        prefix: catalog.prefix,
        defaults: catalog.defaults,
        overrides: catalog.overrides,
      }
      const endWrite = startConnectSpan(opts.profiler, 'catalog.config.write')
      try {
        await cachePut(opts.cache, catalogConfigKey(config), toCache, CATALOG_CONFIG_TTL_MS, now)
      }
      finally {
        endWrite?.({ deferred: opts.cache.defer != null })
      }
    }
  }

  const cacheScope = catalogCacheScope(config)
  const s3Resolver = s3SignedResolver({
    accessKeyId: config.s3.accessKeyId,
    secretAccessKey: config.s3.secretAccessKey,
    region: config.s3.region ?? 'auto',
    endpoint: config.s3.endpoint,
    pathStyle: true,
  })
  const resolver = withVerifiedWriterByteLengths(cachingResolver(s3Resolver))
  return {
    catalog,
    resolver,
    namespace: config.namespace,
    cacheScope,
    [connectionReadBatch]: { active: 0, snapshots: new Map(), manifests: new Map() },
  }
}

/**
 * icebird records `data_file.file_size_in_bytes` from the writer's `offset`
 * after `writer.finish()` resolves. For buffered writers (the S3/R2 path uses
 * hyparquet's `ByteWriter`) the actual uploaded body is `getBytes().byteLength`.
 * Keep that invariant local to the catalog resolver so every dataset writer gets
 * the same protection and callers cannot commit stale byte counts by accident.
 */
function withVerifiedWriterByteLengths(resolver: IcebergResolver): IcebergResolver {
  if (!resolver.writer)
    return resolver
  const baseWriter = resolver.writer
  return {
    ...resolver,
    writer(path, options) {
      const writer = baseWriter(path, options)
      const finish = writer.finish.bind(writer)
      writer.finish = async function () {
        await finish()
        const actual = bufferedByteLength(writer)
        if (actual == null || writer.offset === actual)
          return
        console.warn(`[lakehouse] corrected Iceberg writer byte length for ${path}: offset=${writer.offset} actual=${actual}`)
        writer.offset = actual
      }
      return writer
    },
  }
}

function bufferedByteLength(writer: IcebergWriter): number | null {
  // A flushing writer may have `offset` as total bytes and `getBytes()` as only
  // the buffered tail. Only ByteWriter-style non-flushing writers are safe to
  // reconcile this way.
  if (typeof writer.flush === 'function')
    return null
  try {
    const bytes = writer.getBytes()
    return Number.isFinite(bytes.byteLength) ? bytes.byteLength : null
  }
  catch {
    return null
  }
}

/**
 * The catalog-identity component of every cross-isolate cache key. Exported so
 * write paths that only hold the config (not a connection) can invalidate the
 * exact keys readers populate — see {@link invalidateSnapshotRef}.
 */
export function catalogCacheScope(config: Pick<IcebergCatalogConfig, 'catalogUri' | 'warehouse'>): string {
  return `${config.catalogUri}\0${config.warehouse}`
}

function isNamespaceAlreadyExistsError(err: unknown): boolean {
  if (err && typeof err === 'object' && (err as { status?: unknown }).status === 409)
    return true
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase()
  return msg.includes('already exists') || msg.includes('409') || msg.includes('conflict')
}

/** An existing namespace cannot prove this caller created or owns its contents. */
export async function createIcebergNamespace(conn: IcebergConnection): Promise<{ _tag: 'Created' } | { _tag: 'Exists' }> {
  return restCatalogCreateNamespace(conn.catalog, { namespace: conn.namespace })
    .then(() => ({ _tag: 'Created' } as const))
    .catch((error: unknown) => {
      if (error && typeof error === 'object' && 'status' in error && error.status === 409)
        return { _tag: 'Exists' } as const
      throw error
    })
}

/**
 * Ensure the catalog namespace exists. Idempotent — an "already exists"
 * response from the REST catalog is swallowed.
 */
export async function ensureIcebergNamespace(conn: IcebergConnection): Promise<void> {
  await restCatalogCreateNamespace(conn.catalog, { namespace: conn.namespace })
    .catch((err: unknown) => {
      if (!isNamespaceAlreadyExistsError(err))
        throw err
      // namespace already exists — fine
    })
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

/** Outcome of a single table create/drop op. */
export interface IcebergTableOpResult {
  table: string
  ok: boolean
  error?: string
}

/**
 * Drop tables from the catalog namespace, purging their data objects.
 * Defaults to every table currently in the namespace.
 */
export async function dropIcebergTables(
  conn: IcebergConnection,
  tables?: readonly string[],
): Promise<IcebergTableOpResult[]> {
  const targets = tables
    ?? (await restCatalogListTables(conn.catalog, { namespace: conn.namespace }))
      .map(t => t.name)
  const results: IcebergTableOpResult[] = []
  const { icebergDropTable } = await useIcebirdWriteModule()
  for (const table of targets) {
    await icebergDropTable({
      catalog: conn.catalog,
      namespace: conn.namespace,
      table,
      purgeRequested: true,
    }).then(
      () => results.push({ table, ok: true }),
      (e: unknown) => results.push({ table, ok: false, error: e instanceof Error ? e.message : String(e) }),
    )
  }
  return results
}

// ---------------------------------------------------------------------------
// Transient commit-retry — R2 Data Catalog rate-limits (429) and R2 server
// blips (5xx on a data/metadata object PUT).
//
// Both classes get the SAME full-jitter exponential schedule. A separate,
// faster schedule for 5xx would buy almost nothing: full jitter already draws
// from [0, ceiling), so the first 5xx retry can fire immediately, and the two
// classes overlap in cause (R2 load-shedding surfaces as either). One schedule
// also means one budget — `maxAttempts` bounds the whole loop regardless of
// which class each attempt failed with.
// ---------------------------------------------------------------------------

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
  /**
   * Idempotency token stamped into the appended snapshot's summary
   * (`lakehouse.append-id`) and matched by the landed-check. When omitted it is
   * Derived from framed, typed record content when omitted. Row and object
   * key order do not change the token. A matching legacy content token throws
   * `LegacyAppendIdentityUnverifiable` until committed rows are verified.
   */
  appendId?: string
}

export type IcebergAppendArgs = Parameters<typeof icebergAppend>[0]
export type AppendBatchFactory = () => Iterable<Record<string, unknown>[]> | AsyncIterable<Record<string, unknown>[]>

export type IcebergAppendBatchesArgs
  = Omit<Parameters<typeof icebergAppendBatches>[0], 'batches' | 'snapshotProperties'>
    & { batchFactory: AppendBatchFactory, snapshotProperties?: Record<string, string> }

const APPEND_ID_SUMMARY_KEY = 'lakehouse.append-id'

/**
 * True when `err` is an R2 Data Catalog commit rate-limit response
 * (`429 too many commits to this table`).
 *
 * Deliberately 429-ONLY. Callers use this to decide whether to decorrelate
 * concurrent committers (defer the whole unit of work off-slot), which is the
 * wrong response to a one-off server blip — see {@link isCommitServerError}.
 */
export function isCommitRateLimited(err: unknown): boolean {
  if (err && typeof err === 'object' && (err as { status?: unknown }).status === 429)
    return true
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase()
  return msg.includes('429') || msg.includes('too many commits') || msg.includes('rate limit')
}

/** Transient server-side statuses R2's S3 API and the catalog REST API return. */
const TRANSIENT_SERVER_STATUSES: ReadonlySet<number> = new Set([500, 502, 503, 504])

/**
 * A status paired with its canonical reason phrase, which is the shape icebird
 * throws (`PUT ${path}: ${res.status} ${res.statusText}`). Requiring the phrase
 * is what makes the message fallback safe: Iceberg data files are named
 * `00500-0-<uuid>.parquet`, so a bare `includes('500')` would classify a hard
 * 403 on such a path as retryable and loop on a permanent failure.
 */
const TRANSIENT_SERVER_MESSAGE_RE
  = /\b(?:500 internal server error|502 bad gateway|503 service unavailable|504 gateway time-?out)\b/i

/**
 * True when `err` is a transient server-side 5xx from R2 — a bare
 * `500 Internal Server Error` on a data/metadata object PUT, or a 502/503/504
 * from the catalog REST API.
 *
 * These carry no S3 error code and no body; they are single-request blips that
 * clear on the next call. Distinct from {@link isCommitRateLimited} so a caller
 * that must decorrelate writers on a 429 does not also do so on a server error.
 */
export function isCommitServerError(err: unknown): boolean {
  const status = err && typeof err === 'object' ? (err as { status?: unknown }).status : undefined
  if (typeof status === 'number')
    return TRANSIENT_SERVER_STATUSES.has(status)
  const msg = err instanceof Error ? err.message : String(err)
  return TRANSIENT_SERVER_MESSAGE_RE.test(msg)
}

/**
 * The retry predicate: is `err` worth another append attempt at all?
 *
 * Union of {@link isCommitRateLimited} and {@link isCommitServerError}.
 * Everything else — 4xx, catalog conflicts icebird already exhausted its own
 * 412/409 retries on, schema/validation failures — is permanent and must
 * propagate on the first attempt.
 */
export function isCommitTransient(err: unknown): boolean {
  return isCommitRateLimited(err) || isCommitServerError(err)
}

function defaultCommitSleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/**
 * `icebergAppend` wrapped with retry on transient commit failures
 * ({@link isCommitTransient}: 429 rate-limits and R2 5xx blips), using
 * full-jitter exponential back-off, plus a landed-check idempotency guard so a
 * failure whose commit actually landed is never re-applied (see
 * `deriveAppendIdentity`/`checkAppendLanded`).
 *
 * Retrying is safe because `icebergAppend` writes data + manifest files BEFORE
 * the atomic catalog pointer swap, so a 5xx during the upload phase aborts
 * before anything is referenced by a snapshot; the retry writes fresh files and
 * commits once. A 5xx on the pointer swap itself is covered by the
 * landed-check.
 */
export async function icebergAppendRetrying(
  args: IcebergAppendArgs,
  options: CommitRetryOptions = {},
): Promise<void> {
  const { icebergAppend } = await useIcebirdWriteModule()
  const maxAttempts = options.maxAttempts ?? 6
  const baseDelayMs = options.baseDelayMs ?? 1000
  const maxDelayMs = options.maxDelayMs ?? 20_000
  const sleep = options.sleep ?? defaultCommitSleep
  const random = options.random ?? Math.random
  const identity: AppendIdentity = options.appendId === undefined
    ? await deriveAppendIdentity(args.records ?? [])
    : { _tag: 'Explicit', appendId: options.appendId }
  const appendId = identity.appendId
  const stampedArgs = {
    ...args,
    snapshotProperties: { ...(args as { snapshotProperties?: Record<string, string> }).snapshotProperties, [APPEND_ID_SUMMARY_KEY]: appendId },
    isAlreadyApplied: (metadata: LandedCheckMetadata) => hasAppendIdentity(metadata, identity),
  } as IcebergAppendArgs

  let check = await checkAppendLanded(args, identity)
  if (check.landed)
    return

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    // The landed-check just loaded the table. Hand that load to icebird so the
    // attempt does not issue a second billed load-table for the same state.
    const err = await icebergAppend({ ...stampedArgs, metadata: check.metadata }).then(() => undefined, (e: unknown) => e)
    if (err === undefined)
      return
    if (!isCommitTransient(err))
      throw err
    check = await checkAppendLanded(args, identity)
    if (check.landed)
      return
    if (attempt === maxAttempts - 1)
      throw err
    const ceiling = Math.min(maxDelayMs, baseDelayMs * 2 ** attempt)
    await sleep(Math.floor(random() * ceiling))
  }
}

/**
 * Lazy multi-file append with the same transient-retry landed-check contract as
 * {@link icebergAppendRetrying}. The factory is invoked once per real attempt,
 * so a retry can re-open bounded source chunks without retaining prior rows.
 * Returns false when an earlier attempt already committed this append id.
 */
export async function icebergAppendBatchesRetrying(
  args: IcebergAppendBatchesArgs,
  options: CommitRetryOptions & { appendId: string },
): Promise<boolean> {
  const { icebergAppendBatches } = await useIcebirdWriteModule()
  const maxAttempts = options.maxAttempts ?? 6
  const baseDelayMs = options.baseDelayMs ?? 1000
  const maxDelayMs = options.maxDelayMs ?? 20_000
  const sleep = options.sleep ?? defaultCommitSleep
  const random = options.random ?? Math.random
  const appendId = options.appendId
  const { batchFactory, ...appendArgs } = args
  const stampedArgs = {
    ...appendArgs,
    snapshotProperties: { ...appendArgs.snapshotProperties, [APPEND_ID_SUMMARY_KEY]: appendId },
    isAlreadyApplied: (metadata: LandedCheckMetadata) => hasAppendId(metadata, appendId),
  }

  let check = await checkAppendLanded(args, { _tag: 'Explicit', appendId })
  if (check.landed)
    return false

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const err = await icebergAppendBatches({
      ...stampedArgs,
      metadata: check.metadata,
      batches: batchFactory(),
    }).then(() => undefined, (e: unknown) => e)
    if (err === undefined)
      return true
    if (!isCommitTransient(err))
      throw err
    check = await checkAppendLanded(args, { _tag: 'Explicit', appendId })
    if (check.landed)
      return true
    if (attempt === maxAttempts - 1)
      throw err
    const ceiling = Math.min(maxDelayMs, baseDelayMs * 2 ** attempt)
    await sleep(Math.floor(random() * ceiling))
  }
  return false
}

type LandedCheckMetadata = Awaited<ReturnType<typeof restCatalogLoadTable>>['metadata']

/**
 * Result of the landed-check. `metadata` is the table state the check loaded,
 * so the next append attempt can stage against it without loading the table
 * again. It is `undefined` for non-REST catalogs, where icebird loads itself.
 */
type AppendLandedCheck
  = | { landed: true }
    | { landed: false, metadata: LandedCheckMetadata | undefined }

/** Did the append carrying `appendId` already commit? REST catalogs only. */
async function checkAppendLanded(
  args: { catalog?: { type?: string }, namespace?: string | string[], table?: string },
  identity: AppendIdentity,
): Promise<AppendLandedCheck> {
  const a = args as { catalog?: { type?: string }, namespace?: string | string[], table?: string }
  if (a.catalog?.type !== 'rest' || a.namespace == null || a.table == null)
    return { landed: false, metadata: undefined }
  const { metadata } = await restCatalogLoadTable(a.catalog as Parameters<typeof restCatalogLoadTable>[0], {
    namespace: a.namespace,
    table: a.table,
  })
  return hasAppendIdentity(metadata, identity)
    ? { landed: true }
    : { landed: false, metadata }
}

function hasAppendId(metadata: LandedCheckMetadata, appendId: string): boolean {
  // Catalog snapshot arrays have no chronological ordering guarantee.
  return metadata.snapshots?.some(snapshot => (snapshot.summary as Record<string, string> | undefined)?.[APPEND_ID_SUMMARY_KEY] === appendId) ?? false
}

function hasAppendIdentity(metadata: LandedCheckMetadata, identity: AppendIdentity): boolean {
  if (hasAppendId(metadata, identity.appendId))
    return true
  // Old content hashes cannot distinguish a retry from a serialization collision.
  if (identity._tag === 'Content' && hasAppendId(metadata, identity.legacyAppendId)) {
    throw Object.assign(new Error('A legacy append ID matched. Verify committed rows before retrying with an explicit append ID.'), {
      _tag: 'LegacyAppendIdentityUnverifiable',
      legacyAppendId: identity.legacyAppendId,
    })
  }
  return false
}

// ---------------------------------------------------------------------------
// Read path — resolve data files for a partition slice (generic, ADR-0021
// amendment 9: parameterized over an arbitrary partition spec + value matches
// instead of the frozen `site_id`/`search_type` pair).
// ---------------------------------------------------------------------------

/**
 * Inclusive per-file bounds of the dataset's date column, decoded from the
 * manifest entry's `lower_bounds`/`upper_bounds`, in the Iceberg `date`
 * domain: days since the Unix epoch (see `toIcebergDayCount`).
 */
export interface IcebergDataFileDateBounds {
  /** Smallest date in the file, as a day count. */
  minDay: number
  /** Largest date in the file, as a day count. */
  maxDay: number
}

/** A data file in the current snapshot's manifest, scoped to one partition. */
export interface IcebergListedDataFile {
  filePath: string
  objectKey: string
  bytes: number
  rowCount: number
  /**
   * Date-column bounds when the manifest carried decodable stats for the file.
   * ABSENT means "unknown", never "empty": a file without bounds is always
   * kept by the resolver (see {@link resolveIcebergDataFiles}).
   */
  dateBounds?: IcebergDataFileDateBounds
}

/**
 * Minimal profiler contract — start a named span, get back an end callback.
 *
 * The `meta` shape is pinned to `Record<string, string | number | boolean>`
 * to stay structurally identical to `@gscdump/engine`'s `QueryProfiler`
 * (`packages/engine/src/storage.ts`). Engine depends on lakehouse (not the
 * reverse), so this can't be a cross-package re-export without a cycle —
 * matching the shape exactly is what lets a profiler built with engine's
 * `createQueryProfiler` flow into `resolveIcebergDataFiles`/
 * `listIcebergDataFiles` without a type error at the call boundary.
 */
export interface QueryProfiler {
  start: (name: string) => ((meta?: Record<string, string | number | boolean>) => void) | undefined
}

export interface ResolveIcebergDataFilesOptions {
  namespace: string
  table: string
  /** Partition spec for this table — used both for the manifest prune and the per-file check. */
  partitionSpec: readonly { sourceColumn: string, transform: 'identity' | 'month', name: string }[]
  /** Identity/dims values to match. */
  matches: readonly PartitionValueMatch[]
  /** Inclusive date range. Every month touched by `[start, end]` is scanned. */
  range: { start: string, end: string }
  cache?: CatalogCache
  clock?: () => number
  profiler?: QueryProfiler
}

const SNAPSHOT_REF_TTL_MS = 30 * 60 * 1000
const RESOLVED_FILES_TTL_MS = 24 * 60 * 60 * 1000
const METADATA_TTL_MS = 24 * 60 * 60 * 1000
const MAX_CACHED_METADATA_BYTES = 2 * 1024 * 1024
/**
 * TTL on a cached month's manifest-derived file list. Generous — the key
 * itself (the sha-256 of that month's manifest-path SET) is what makes a hit
 * correct, not the TTL; the TTL is only hygiene so a month nobody queries
 * again eventually falls out of the store.
 */
const MONTH_FILES_TTL_MS = 30 * 24 * 60 * 60 * 1000

function snapshotRefKey(scope: string, namespace: string, table: string): string {
  return `lh-snapref\0${scope}\0${namespace}\0${table}`
}

/**
 * Drop the cached snapshot pointer for `(namespace, table)` so the next read
 * re-loads the table and sees the just-committed snapshot immediately instead
 * of after {@link SNAPSHOT_REF_TTL_MS} (writers call this post-commit; without
 * it worst-case reader staleness is TTL + the downstream ref's own TTL). Only
 * the snapshot REF is dropped: `lh-snapmeta`/`lh-files` entries are keyed by
 * snapshotId, so stale ones age out harmlessly and fresh ones rebuild on the
 * next read. Best-effort like every cache path here — a failed delete only
 * means TTL-bounded staleness, never an error.
 */
export async function invalidateSnapshotRef(cache: CatalogCache, namespace: string, table: string, cacheScope = ''): Promise<void> {
  // Reported without rejecting (cache-hygiene failure must not fail the commit
  // path that calls this); the TTL bounds staleness if the delete never lands.
  // `cacheScope` must match the reader's connection scope (`catalogCacheScope`
  // over the same config) or the delete silently misses the live key.
  const key = snapshotRefKey(cacheScope, namespace, table)
  await cache.storage.removeItem(key).catch((error: unknown) => {
    reportCatalogCacheError(cache, 'remove', key, error)
  })
}

function metadataRefKey(scope: string, namespace: string, table: string, snapshotId: string): string {
  return `lh-snapmeta\0${scope}\0${namespace}\0${table}\0${snapshotId}`
}

/**
 * Key for a resolved file list.
 *
 * Keyed on the EXACT range, not the month set: per-file date-bound pruning
 * makes two ranges inside one month resolve different file lists, so a
 * month-granular key would serve one range's files for another's query. The
 * `lh-files2` prefix retires the month-keyed `lh-files` entries written before
 * date pruning existed rather than reusing (and mis-serving) them.
 */
function matchKeyOf(matches: readonly PartitionValueMatch[]): string {
  return [...matches].map(m => `${m.field}=${m.value}`).sort().join(',')
}

function resolvedFilesKey(
  scope: string,
  namespace: string,
  table: string,
  snapshotId: string,
  matches: readonly PartitionValueMatch[],
  range: { start: string, end: string },
): string {
  return `lh-files2\0${scope}\0${namespace}\0${table}\0${snapshotId}\0${matchKeyOf(matches)}\0${range.start}..${range.end}`
}

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

function monthsSinceEpoch(ym: string): number {
  const [y, m] = ym.split('-').map(Number) as [number, number]
  return (y - 1970) * 12 + (m - 1)
}

function ymFromMonthsSinceEpoch(value: number): string {
  const y = 1970 + Math.floor(value / 12)
  const m = (((value % 12) + 12) % 12) + 1
  return `${y}-${String(m).padStart(2, '0')}`
}

/**
 * Key for a cached month's resolved-and-scoped (but NOT yet day-bounds-
 * pruned) file list.
 *
 * `manifestSetHash` is a sha-256 of that month's sorted manifest-path set —
 * that is what makes a hit correct BY CONSTRUCTION: a commit or a compaction
 * that adds, removes or rewrites any manifest touching the month changes the
 * hash, which changes the key, which misses. No snapshot id in the key: two
 * snapshots that happen to walk the same manifest set for a month are
 * legitimately the same cache entry.
 */
function monthFilesKey(
  scope: string,
  namespace: string,
  table: string,
  matchKey: string,
  monthYm: string,
  manifestSetHash: string,
): string {
  return `lh-month\0${scope}\0${namespace}\0${table}\0${matchKey}\0${monthYm}\0${manifestSetHash}`
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('')
}

// ---------------------------------------------------------------------------
// Per-file date-bound pruning.
//
// The partition tuple only narrows to a MONTH, so a 7-day query over a range
// that straddles two calendar months resolves every file in both month
// partitions. The writer already stamps per-file `lower_bounds`/`upper_bounds`
// (Avro field ids 125-130) for every column, including the date column, so the
// exact [min, max] date of each file is in hand during the manifest walk at
// zero extra fetches.
//
// EVERY helper below FAILS OPEN — an absent, malformed, wrong-width or
// wrong-typed bound returns `null`, and a `null` bound KEEPS the file. Dropping
// a file because its stats were missing would silently return wrong query
// results, which is far worse than reading a file we did not need.
// ---------------------------------------------------------------------------

/** Iceberg single-value serialization for `date`: 4-byte little-endian int32 day count. */
const DATE_BOUND_BYTES = 4

/**
 * Read one column's bound bytes out of a manifest `lower_bounds`/`upper_bounds`
 * map. Iceberg encodes these as an Avro array of `{key, value}` records, which
 * is what the read path decodes them to; hand-built entries may instead be a
 * plain `Record<fieldId, bytes>`. Both shapes are accepted; anything else
 * returns `null` (keep the file).
 */
function boundBytesForField(map: unknown, fieldId: number): Uint8Array | null {
  if (map == null)
    return null
  const raw = Array.isArray(map)
    ? (map as { key?: unknown, value?: unknown }[]).find(e => e != null && Number(e.key) === fieldId)?.value
    : (map as Record<number, unknown>)[fieldId]
  if (raw instanceof Uint8Array)
    return raw
  if (raw instanceof ArrayBuffer)
    return new Uint8Array(raw)
  return null
}

/** Decode a `date` bound to a day count, or `null` when it is not decodable. */
function decodeDateBound(bytes: Uint8Array | null): number | null {
  if (bytes == null || bytes.byteLength !== DATE_BOUND_BYTES)
    return null
  const day = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getInt32(0, true)
  return Number.isFinite(day) ? day : null
}

/**
 * Decode a data file's date bounds. Requires BOTH bounds — the writer emits
 * them as a pair, so a half-present pair means something unexpected produced
 * the manifest and the file is kept unpruned.
 */
function readDataFileDateBounds(
  df: { lower_bounds?: unknown, upper_bounds?: unknown },
  dateFieldId: number,
): IcebergDataFileDateBounds | null {
  const minDay = decodeDateBound(boundBytesForField(df.lower_bounds, dateFieldId))
  const maxDay = decodeDateBound(boundBytesForField(df.upper_bounds, dateFieldId))
  if (minDay == null || maxDay == null || minDay > maxDay)
    return null
  return { minDay, maxDay }
}

/**
 * Resolve the field id of the dataset's date column from the table metadata's
 * current schema. Returns `null` when the column cannot be identified, or when
 * it is not an Iceberg `date` (the only physical encoding this decoder handles),
 * so the caller keeps every file.
 */
function dateColumnFieldId(metadata: LoadedTableMetadata | null, columnName: string | undefined): number | null {
  if (!metadata || !columnName)
    return null
  const meta = metadata as unknown as {
    'schemas'?: { 'schema-id'?: number, 'fields'?: { id?: unknown, name?: unknown, type?: unknown }[] }[]
    'current-schema-id'?: number
    'schema'?: { fields?: { id?: unknown, name?: unknown, type?: unknown }[] }
  }
  const schema = meta.schemas?.find(s => s['schema-id'] === meta['current-schema-id'])
    ?? meta.schemas?.[0]
    ?? meta.schema
  const field = schema?.fields?.find(f => f.name === columnName)
  if (!field || field.type !== 'date' || typeof field.id !== 'number')
    return null
  return field.id
}

/** Inclusive day-count window for a query range, or `null` when it is unparseable. */
function rangeDayWindow(range: { start: string, end: string }): { startDay: number, endDay: number } | null {
  try {
    const startDay = toIcebergDayCount(range.start)
    const endDay = toIcebergDayCount(range.end)
    return startDay <= endDay ? { startDay, endDay } : null
  }
  catch {
    // Unparseable range — fail open and prune on the month tuple only.
    return null
  }
}

function stripBucket(filePath: string): string {
  if (!filePath.startsWith('s3://'))
    return filePath
  const rest = filePath.slice(5)
  const slash = rest.indexOf('/')
  return slash >= 0 ? rest.slice(slash + 1) : rest
}

type LoadedTableMetadata = Awaited<ReturnType<typeof restCatalogLoadTable>>['metadata']

async function loadSnapshotId(
  conn: IcebergConnection,
  namespace: string,
  table: string,
  cache: CatalogCache | undefined,
  now: number,
): Promise<{ snapshotId: string | null, metadata: LoadedTableMetadata | null }> {
  const batch = conn[connectionReadBatch]
  if (!batch || batch.active === 0)
    return loadSnapshotIdUnshared(conn, namespace, table, cache, now)

  const storage = cache?.storage
  let pendingByTable = batch.snapshots.get(storage)
  if (!pendingByTable) {
    pendingByTable = new Map()
    batch.snapshots.set(storage, pendingByTable)
  }
  const key = `${conn.cacheScope ?? ''}\0${namespace}\0${table}`
  const existing = pendingByTable.get(key)
  if (existing)
    return existing
  const pending = loadSnapshotIdUnshared(conn, namespace, table, cache, now)
  pendingByTable.set(key, pending)
  pending.then(undefined, () => {
    if (pendingByTable?.get(key) === pending)
      pendingByTable.delete(key)
  })
  return pending
}

async function loadSnapshotIdUnshared(
  conn: IcebergConnection,
  namespace: string,
  table: string,
  cache: CatalogCache | undefined,
  now: number,
): Promise<{ snapshotId: string | null, metadata: LoadedTableMetadata | null }> {
  const scope = conn.cacheScope ?? ''
  if (cache) {
    const cached = await cacheGet<string>(cache, snapshotRefKey(scope, namespace, table), now)
    if (cached !== undefined)
      return { snapshotId: cached, metadata: null }
  }
  const { metadata } = await restCatalogLoadTable(conn.catalog, { namespace, table })
  const raw = metadata['current-snapshot-id']
  const snapshotId = raw == null ? null : String(raw)
  if (cache) {
    await cachePut(cache, snapshotRefKey(scope, namespace, table), snapshotId, SNAPSHOT_REF_TTL_MS, now)
    if (snapshotId != null) {
      // Metadata carries BigInt snapshot ids. Cross-isolate stores are JSON
      // boundaries, so cache the lossless string form rather than handing the
      // driver raw BigInts and silently losing this cache tier.
      const serialized = stringifyBigintSafe(metadata)
      if (serialized.length <= MAX_CACHED_METADATA_BYTES) {
        const cacheableMetadata = JSON.parse(serialized) as LoadedTableMetadata
        await cachePut(cache, metadataRefKey(scope, namespace, table, snapshotId), cacheableMetadata, METADATA_TTL_MS, now)
      }
    }
  }
  return { snapshotId, metadata }
}

/** Minimal shape of one manifest entry, as accessed while turning it into a listed data file. */
interface ManifestWalkEntry {
  status?: number
  snapshot_id?: number | bigint | string
  data_file: {
    content?: number
    file_path: string
    file_size_in_bytes: unknown
    record_count: unknown
    partition: Record<string, unknown>
    lower_bounds?: unknown
    upper_bounds?: unknown
  }
}

/** Resolve only added files from one authoritative append snapshot. */
export async function resolveIcebergAppendFiles(
  conn: IcebergConnection,
  table: string,
  appendId: string,
  matches: readonly PartitionValueMatch[],
): Promise<{ _tag: 'Ok', snapshotId: string, files: IcebergListedDataFile[] } | { _tag: 'Err', reason: 'append-unavailable' }> {
  const resolve = await createIcebergAppendFileResolver(conn, table)
  return resolve(appendId, matches)
}

/** A fresh table view and immutable manifest cache owned by one bounded request. */
export async function createIcebergAppendFileResolver(conn: IcebergConnection, table: string, dateColumn?: string): Promise<
  ((appendId: string, matches: readonly PartitionValueMatch[]) => ReturnType<typeof resolveIcebergAppendFiles>) & {
    currentFiles: (matches: readonly PartitionValueMatch[]) =>
      { _tag: 'Ok', files: IcebergListedDataFile[] } | { _tag: 'Err', reason: 'append-unavailable' }
    confirmCurrent: () => Promise<boolean>
  }
> {
  const { metadata, metadataLocation } = await restCatalogLoadTable(conn.catalog, { namespace: conn.namespace, table })
  const dateFieldId = dateColumnFieldId(metadata, dateColumn)
  const manifestCache: ManifestReadCache = { lists: new Map(), entries: new Map() }
  const immutableBytes = new Map<string, Promise<ArrayBuffer>>()
  const retainedSizes = new Map<string, number>()
  // This request-local table session retains at most 4 MiB of immutable metadata.
  const maxRetainedBytes = 4 * 1024 * 1024
  const budgetFailure = { _tag: 'ManifestBudgetExceeded' } as const
  let retainedBytes = 0
  let unavailable = false
  const resolver = {
    ...conn.resolver,
    reader: async (url: string) => {
      let bytes = immutableBytes.get(url)
      if (!bytes) {
        bytes = Promise.resolve(conn.resolver.reader(url)).then(async (buffer) => {
          if (!Number.isSafeInteger(buffer.byteLength) || buffer.byteLength < 0
            || buffer.byteLength > maxRetainedBytes) {
            unavailable = true
            throw budgetFailure
          }
          // Cache pressure does not disprove committed files. Evict old immutable
          // reads and their decoded entries, then read them again if needed.
          for (const [key, size] of retainedSizes) {
            if (retainedBytes + buffer.byteLength <= maxRetainedBytes)
              break
            retainedSizes.delete(key)
            immutableBytes.delete(key)
            manifestCache.lists.delete(key)
            manifestCache.entries.delete(key)
            retainedBytes -= size
          }
          retainedBytes += buffer.byteLength
          retainedSizes.set(url, buffer.byteLength)
          const content = await buffer.slice(0, buffer.byteLength)
          if (content.byteLength !== buffer.byteLength) {
            unavailable = true
            throw budgetFailure
          }
          return content
        })
        immutableBytes.set(url, bytes)
      }
      const buffer = await bytes
      return { byteLength: buffer.byteLength, slice: async (start: number, end: number) => buffer.slice(start, end) }
    },
  }
  const budgetUnavailable = (error: unknown): WalkedManifest[] => {
    if (error !== budgetFailure)
      throw error
    return [] // Every public operation below refuses this session.
  }
  const current: WalkedManifest[] = metadata['current-snapshot-id'] == null
    ? []
    : await icebergManifests({ metadata, resolver, manifestCache }).catch(budgetUnavailable)
  const currentFiles = new Map<string, ManifestWalkEntry['data_file']>()
  for (const manifest of current) {
    for (const entry of manifest.entries) {
      if (entry.status !== 2 && entry.data_file.content === 0)
        currentFiles.set(entry.data_file.file_path, entry.data_file)
    }
  }
  const resolve = async (appendId: string, matches: readonly PartitionValueMatch[]): Promise<
    { _tag: 'Ok', snapshotId: string, files: IcebergListedDataFile[] } | { _tag: 'Err', reason: 'append-unavailable' }
  > => {
    if (unavailable)
      return { _tag: 'Err', reason: 'append-unavailable' }
    const snapshots = metadata.snapshots?.filter(snapshot =>
      (snapshot.summary as Record<string, string> | undefined)?.[APPEND_ID_SUMMARY_KEY] === appendId) ?? []
    if (!appendId || snapshots.length !== 1)
      return { _tag: 'Err', reason: 'append-unavailable' }
    if (snapshots[0].summary?.operation !== 'append')
      return { _tag: 'Err', reason: 'append-unavailable' }
    const snapshotId = snapshots[0]['snapshot-id']
    const manifests: WalkedManifest[] = await icebergManifests({ metadata, resolver, snapshotId, manifestCache }).catch(budgetUnavailable)
    if (unavailable)
      return { _tag: 'Err', reason: 'append-unavailable' }
    const files: IcebergListedDataFile[] = []
    for (const manifest of manifests) {
      for (const entry of manifest.entries) {
        if (entry.status === 2 || entry.data_file.content !== 0)
          return { _tag: 'Err', reason: 'append-unavailable' }
        if (entry.status !== 1 || entry.snapshot_id == null || String(entry.snapshot_id) !== String(snapshotId))
          continue
        const file = toListedFile(entry, matches, undefined, new Set(), null)
        if (file) {
          const member = currentFiles.get(file.filePath)
          if (!member || Number(member.record_count) !== file.rowCount || Number(member.file_size_in_bytes) !== file.bytes)
            return { _tag: 'Err', reason: 'append-unavailable' }
          files.push(file)
        }
      }
    }
    if (files.length === 0)
      return { _tag: 'Err', reason: 'append-unavailable' }
    return { _tag: 'Ok', snapshotId: String(snapshotId), files }
  }
  return Object.assign(resolve, {
    confirmCurrent: async () => {
      if (unavailable)
        return false
      const fresh = await restCatalogLoadTable(conn.catalog, { namespace: conn.namespace, table })
      return fresh.metadataLocation === metadataLocation
        && fresh.metadata['table-uuid'] === metadata['table-uuid']
        && String(fresh.metadata['current-snapshot-id']) === String(metadata['current-snapshot-id'])
    },
    currentFiles: (matches: readonly PartitionValueMatch[]) => {
      if (unavailable)
        return { _tag: 'Err' as const, reason: 'append-unavailable' as const }
      const files: IcebergListedDataFile[] = []
      for (const manifest of current) {
        for (const entry of manifest.entries) {
          if (entry.status !== 2 && entry.data_file.content !== 0)
            return { _tag: 'Err' as const, reason: 'append-unavailable' as const }
          const file = toListedFile(entry, matches, undefined, new Set(), dateFieldId)
          if (file)
            files.push(file)
        }
      }
      return { _tag: 'Ok' as const, files }
    },
  })
}

/** One manifest's walked result — `icebergManifests`'s return element. */
interface WalkedManifest {
  url: string
  entries: ManifestWalkEntry[]
}

/** Outcome of resolving the manifests for one range: the scoped files plus profiler counters. */
interface ManifestWalkOutcome {
  entries: IcebergListedDataFile[]
  manifestsWalked: number
  monthsWanted: number
  monthsHit: number
}

/**
 * Turn one manifest entry into a listed data file: applies the DELETED/
 * non-data-file checks, the identity/dims `matches`, and month-partition
 * membership.
 *
 * Deliberately does NOT apply day-bounds pruning — that runs once, after
 * cached-month entries and freshly-walked entries are merged, over the
 * combined list (see {@link resolveIcebergDataFiles}). Pruning here would
 * mean a month cached for one range's day-window could never serve a
 * narrower or different range inside the same month.
 */
function toListedFile(
  entry: ManifestWalkEntry,
  matches: readonly PartitionValueMatch[],
  monthFieldName: string | undefined,
  wantedMonths: ReadonlySet<number>,
  dateFieldId: number | null,
): IcebergListedDataFile | null {
  if (entry.status === 2)
    return null
  const df = entry.data_file
  if (df.content !== 0)
    return null
  const part = df.partition
  for (const match of matches) {
    if (String(part[match.field]) !== String(match.value))
      return null
  }
  if (monthFieldName) {
    const month = part[monthFieldName]
    if (typeof month !== 'number' || !wantedMonths.has(month))
      return null
  }
  // `dateBounds` is null whenever the stats are absent, malformed, or of a
  // type this decoder does not handle. A null NEVER prunes here — this
  // function only decodes; day-bounds pruning is the caller's job.
  const dateBounds = dateFieldId == null ? null : readDataFileDateBounds(df, dateFieldId)
  return {
    filePath: df.file_path,
    objectKey: stripBucket(df.file_path),
    bytes: Number(df.file_size_in_bytes),
    rowCount: Number(df.record_count),
    ...(dateBounds ? { dateBounds } : {}),
  }
}

/**
 * Resolve data files with a single, unfiltered manifest walk — the original
 * behaviour, used whenever the month cache cannot apply (no cache injected,
 * or the table's partition spec has no `month`-transform field to bucket by).
 */
async function resolveViaFullWalk(
  conn: IcebergConnection,
  metadata: LoadedTableMetadata,
  partitionFilter: ManifestPartitionFilter,
  matches: readonly PartitionValueMatch[],
  monthFieldName: string | undefined,
  wantedMonths: ReadonlySet<number>,
  dateFieldId: number | null,
  manifestCache: ManifestReadCache | undefined,
): Promise<ManifestWalkOutcome> {
  const manifests: WalkedManifest[] = await icebergManifests({ metadata, resolver: conn.resolver, partitionFilter, manifestCache })
  const entries: IcebergListedDataFile[] = []
  for (const m of manifests) {
    for (const entry of m.entries) {
      const file = toListedFile(entry, matches, monthFieldName, wantedMonths, dateFieldId)
      if (file)
        entries.push(file)
    }
  }
  return { entries, manifestsWalked: manifests.length, monthsWanted: 0, monthsHit: 0 }
}

/**
 * Resolve data files through the month-keyed manifest cache.
 *
 * Superseded design: 3.4.2 (PR #42) cached each manifest OBJECT individually
 * behind a per-manifest KV get/put in `manifest-cache-resolver.ts`. Measured
 * on team catalog `gsc-team-9df5b57c-...-int`, `gsc.queries`, one site, a
 * 13-month range (164 manifests surviving partition pruning for 93 data
 * files): a cold walk was 5–8s from a Worker; with the per-manifest cache it
 * measured 11–20s and never improved, because a KV get of a 50–150KB base64
 * manifest from a Worker costs about as much as the S3 GET it replaces, and
 * the un-deferred KV put on every miss doubled that. Reverted in gscdump.com
 * #224 (issue #43). The manifest is the wrong cache grain — a closed month's
 * manifest SET does not change between daily commits, so this caches the
 * MONTH instead: a content-addressed key (sha-256 of that month's sorted
 * manifest-path set) makes a hit correct by construction, and a hit skips
 * every manifest fetch for that month rather than trading N manifest GETs
 * for N KV gets.
 *
 * Two calls to `icebergManifests`, both of which re-fetch the manifest-list
 * avro (cheap — ONE object per snapshot, not per manifest): the first's
 * `partitionFilter` always returns `false`, so `fetchManifests` is handed an
 * empty array and walks nothing — it exists purely to observe every
 * surviving manifest's `manifest_path` + `partitions` summary, which icebird
 * hands the filter before deciding whether to fetch. The second walks only
 * the manifests whose month missed the cache (or that cannot be proven
 * single-month at all).
 */
async function resolveViaMonthCache(
  conn: IcebergConnection,
  cache: CatalogCache,
  metadata: LoadedTableMetadata,
  partitionFilter: ManifestPartitionFilter,
  partitionSpec: readonly IcebergPartitionField[],
  matches: readonly PartitionValueMatch[],
  monthFieldName: string,
  wantedMonths: ReadonlySet<number>,
  dateFieldId: number | null,
  scope: string,
  namespace: string,
  table: string,
  now: number,
  manifestCache: ManifestReadCache | undefined,
): Promise<ManifestWalkOutcome> {
  const matchKey = matchKeyOf(matches)

  // Pass 1: list-only. Records (manifest_path -> month bucket) for every
  // manifest the ordinary partition filter would keep; walks nothing.
  const manifestMonths = new Map<string, number | typeof MULTI_MONTH_MANIFEST>()
  await icebergManifests({
    metadata,
    resolver: conn.resolver,
    manifestCache,
    partitionFilter: (partitions: IcebergFieldSummary[] | undefined, _specId: number, manifest: { manifest_path: string }) => {
      try {
        if (partitionFilter(partitions) === false)
          return false
        manifestMonths.set(manifest.manifest_path, manifestMonthBucket(partitionSpec, partitions))
      }
      catch {
        // The pruning filter threw for this manifest (e.g. a malformed
        // month-summary bound). Icebird's own catch KEEPS the manifest — a
        // pruning failure must not hide data — so its entries WILL be
        // fetched. Record it as un-cacheable so pass 2 walks it; leaving it
        // unrecorded would make pass 2's `toWalk` filter skip it and its
        // data files would silently vanish from the result.
        manifestMonths.set(manifest.manifest_path, MULTI_MONTH_MANIFEST)
      }
      return false
    },
  })

  // Only ever key/read the month cache for a month this call actually wants.
  // `resolveIcebergDataFiles` already rejects an empty `wantedMonths`
  // outright, but this stays as a second, independent guard: a manifest
  // whose month bucket falls outside `wantedMonths` for any other reason
  // must never turn into a cache get (and so can never turn into a hit) for
  // a month the caller did not ask for.
  const pathsByMonth = new Map<number, string[]>()
  for (const [path, bucket] of manifestMonths) {
    if (bucket === MULTI_MONTH_MANIFEST || !wantedMonths.has(bucket))
      continue
    const list = pathsByMonth.get(bucket)
    if (list)
      list.push(path)
    else
      pathsByMonth.set(bucket, [path])
  }
  const monthsWanted = pathsByMonth.size

  // Content-address each wanted month by the sha-256 of its sorted manifest
  // path set — the hash IS the correctness guard: any commit or compaction
  // that changes which manifests touch the month changes the key.
  const monthKeys = new Map<number, string>()
  await Promise.all([...pathsByMonth].map(async ([monthValue, paths]) => {
    const hash = await sha256Hex([...paths].sort().join('\0'))
    monthKeys.set(monthValue, monthFilesKey(scope, namespace, table, matchKey, ymFromMonthsSinceEpoch(monthValue), hash))
  }))

  const cachedByMonth = new Map<number, IcebergListedDataFile[]>()
  await Promise.all([...monthKeys].map(async ([monthValue, key]) => {
    const cached = await cacheGet<IcebergListedDataFile[]>(cache, key, now)
    if (cached !== undefined)
      cachedByMonth.set(monthValue, cached)
  }))
  const monthsHit = cachedByMonth.size

  const toWalk = new Set<string>()
  for (const [path, bucket] of manifestMonths) {
    if (bucket === MULTI_MONTH_MANIFEST || !cachedByMonth.has(bucket))
      toWalk.add(path)
  }

  const entries: IcebergListedDataFile[] = []
  for (const cached of cachedByMonth.values())
    entries.push(...cached)

  let manifestsWalked = 0
  if (toWalk.size > 0) {
    // Pass 2: walk only the missed/uncacheable manifests.
    const manifests: WalkedManifest[] = await icebergManifests({
      metadata,
      resolver: conn.resolver,
      manifestCache,
      partitionFilter: (_partitions: IcebergFieldSummary[] | undefined, _specId: number, manifest: { manifest_path: string }) =>
        toWalk.has(manifest.manifest_path),
    })
    manifestsWalked = manifests.length

    const freshByMonth = new Map<number, IcebergListedDataFile[]>()
    for (const m of manifests) {
      const bucket = manifestMonths.get(m.url)
      // Seed EVERY walked single-month bucket before filtering its entries:
      // a month whose entries all fail `matches` must still cache as an
      // empty array under its content-addressed key, or every later query
      // re-walks that month's manifests forever.
      if (bucket !== undefined && bucket !== MULTI_MONTH_MANIFEST && !freshByMonth.has(bucket))
        freshByMonth.set(bucket, [])
      for (const entry of m.entries) {
        const file = toListedFile(entry, matches, monthFieldName, wantedMonths, dateFieldId)
        if (!file)
          continue
        entries.push(file)
        if (bucket !== undefined && bucket !== MULTI_MONTH_MANIFEST) {
          const list = freshByMonth.get(bucket)
          if (list)
            list.push(file)
          else
            freshByMonth.set(bucket, [file])
        }
      }
    }

    // Await the write when no `defer` hook exists: `cachePut` returns the
    // pending put then, and a Worker without `cache.defer` suspends the
    // isolate at response end, so a fire-and-forget write would be cut off
    // and the month cache would never populate. With a `defer` hook
    // `cachePut` hands the write off and returns immediately, keeping it off
    // the response critical path either way. A driver failure is reported
    // via `reportCatalogCacheError` inside `cachePut`, never thrown here.
    // Start every month's put before awaiting any of them — a cold walk
    // across N missed months pays one round-trip of KV latency, not N.
    const puts: Promise<void>[] = []
    for (const [monthValue, files] of freshByMonth) {
      const key = monthKeys.get(monthValue)
      if (key)
        puts.push(cachePut(cache, key, files, MONTH_FILES_TTL_MS, now))
    }
    await Promise.all(puts)
  }

  return { entries, manifestsWalked, monthsWanted, monthsHit }
}

/**
 * List the parquet data files in the current snapshot of `table`, filtered to
 * one partition slice (`matches` + `range`). Generic over the partition spec —
 * the `IcebergDataset.resolveDataFiles` method is a thin wrapper that supplies
 * the def's own spec + identity/dims values.
 */
export function resolveIcebergDataFiles(
  conn: IcebergConnection,
  opts: ResolveIcebergDataFilesOptions,
): Promise<IcebergListedDataFile[]> {
  const release = beginConnectionRead(conn)
  return resolveIcebergDataFilesInBatch(conn, opts).finally(release)
}

async function resolveIcebergDataFilesInBatch(
  conn: IcebergConnection,
  opts: ResolveIcebergDataFilesOptions,
): Promise<IcebergListedDataFile[]> {
  const { namespace, table } = opts
  const profiler = opts.profiler
  const now = (opts.clock ?? Date.now)()
  const wantedMonths = new Set(monthsInRange(opts.range).map(monthsSinceEpoch))
  // An inverted (`end` before `start`, at month granularity) or unparseable
  // range expands to zero wanted months. Every downstream filter treats an
  // EMPTY `wantedMonths` as "no month restriction" (fail open, same as an
  // absent month field), not "restrict to nothing" — so without this guard a
  // warm month cache would happily serve whatever months it already holds
  // for a query that asked for none of them. Return before touching the
  // snapshot, the exact-range cache, or the month cache at all.
  if (wantedMonths.size === 0)
    return []

  const endSnapshot = profiler?.start('iceberg.snapshot')
  let { snapshotId, metadata } = await loadSnapshotId(conn, namespace, table, opts.cache, now)
  endSnapshot?.({ cached: metadata == null && snapshotId != null })
  if (snapshotId == null)
    return []

  const scope = conn.cacheScope ?? ''
  const filesKey = resolvedFilesKey(scope, namespace, table, snapshotId, opts.matches, opts.range)
  if (opts.cache) {
    const endCache = profiler?.start('iceberg.cache')
    const cached = await cacheGet<IcebergListedDataFile[]>(opts.cache, filesKey, now)
    endCache?.({ hit: cached !== undefined })
    if (cached !== undefined)
      return cached
  }

  if (!metadata && opts.cache) {
    const cachedMeta = await cacheGet<LoadedTableMetadata>(opts.cache, metadataRefKey(scope, namespace, table, snapshotId), now)
    if (cachedMeta != null)
      metadata = cachedMeta
  }
  if (!metadata) {
    const reloaded = await loadSnapshotId(conn, namespace, table, undefined, now)
    snapshotId = reloaded.snapshotId
    metadata = reloaded.metadata
    if (snapshotId == null || !metadata)
      return []
  }

  const endWalk = profiler?.start('iceberg.walk')
  const partitionFilter = buildManifestPartitionFilter(opts.partitionSpec, opts.matches, wantedMonths)
  const monthField = opts.partitionSpec.find(f => f.transform === 'month')
  const monthFieldName = monthField?.name
  // Per-file date-bound pruning inputs. Either being `null` disables the check
  // entirely (fail open): unknown date column, non-`date` physical type, or an
  // unparseable range all fall back to month-tuple pruning alone.
  const dateFieldId = dateColumnFieldId(metadata, monthField?.sourceColumn)
  const dayWindow = rangeDayWindow(opts.range)
  const manifestCache = manifestReadCacheFor(conn, namespace, table, metadata)

  const walk = opts.cache && monthFieldName
    ? await resolveViaMonthCache(conn, opts.cache, metadata, partitionFilter, opts.partitionSpec, opts.matches, monthFieldName, wantedMonths, dateFieldId, scope, namespace, table, now, manifestCache)
    : await resolveViaFullWalk(conn, metadata, partitionFilter, opts.matches, monthFieldName, wantedMonths, dateFieldId, manifestCache)

  // Day-bounds pruning runs once, over the merged (cached ∪ freshly-walked)
  // list — see `toListedFile` and `resolveViaMonthCache`'s doc for why it
  // can't run per-manifest when some entries came from the month cache.
  let boundsPruned = 0
  const out: IcebergListedDataFile[] = []
  for (const file of walk.entries) {
    if (file.dateBounds && dayWindow && (file.dateBounds.maxDay < dayWindow.startDay || file.dateBounds.minDay > dayWindow.endDay)) {
      boundsPruned++
      continue
    }
    out.push(file)
  }
  // Merge order depends on which months were cache hits vs freshly walked,
  // so it is not stable across calls — sort so the result is deterministic
  // regardless of how it was assembled.
  out.sort((a, b) => (a.filePath < b.filePath ? -1 : a.filePath > b.filePath ? 1 : 0))

  endWalk?.({
    manifests: walk.manifestsWalked,
    files: out.length,
    boundsPruned,
    monthsWanted: walk.monthsWanted,
    monthsHit: walk.monthsHit,
    manifestsWalked: walk.manifestsWalked,
  })

  if (opts.cache) {
    const freshKey = resolvedFilesKey(scope, namespace, table, snapshotId, opts.matches, opts.range)
    await cachePut(opts.cache, freshKey, out, RESOLVED_FILES_TTL_MS, now)
  }
  return out
}

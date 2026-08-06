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

import type {
  icebergAppend,
  icebergAppendBatches,
} from 'icebird/src/write/write.js'
import type { CatalogCache } from './catalog-cache'
import type { PartitionValueMatch } from './partition-prune'
import type { IcebergPrimitiveType, IcebergS3Config } from './schema'
import {
  restCatalogConnect,
  restCatalogCreateNamespace,
  restCatalogListTables,
  restCatalogLoadTable,
} from 'icebird/src/catalog/rest.js'
import { cachingResolver } from 'icebird/src/fetch.js'
import { icebergManifests } from 'icebird/src/manifest.js'
import { s3SignedResolver } from 'icebird/src/s3.js'
import { stringifyBigintSafe } from './bigint'
import { cacheGet, cachePut, reportCatalogCacheError } from './catalog-cache'
import { buildManifestPartitionFilter } from './partition-prune'

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

  const resolver = withVerifiedWriterByteLengths(cachingResolver(s3SignedResolver({
    accessKeyId: config.s3.accessKeyId,
    secretAccessKey: config.s3.secretAccessKey,
    region: config.s3.region ?? 'auto',
    endpoint: config.s3.endpoint,
    pathStyle: true,
  })))
  return { catalog, resolver, namespace: config.namespace, cacheScope: catalogCacheScope(config) }
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
   * DERIVED from the records' content, making the token STABLE across
   * PROCESSES, not just within one call's retry loop.
   */
  appendId?: string
}

export type IcebergAppendArgs = Parameters<typeof icebergAppend>[0]
export type AppendBatchFactory = () => Iterable<Record<string, unknown>[]> | AsyncIterable<Record<string, unknown>[]>

export type IcebergAppendBatchesArgs
  = Omit<Parameters<typeof icebergAppendBatches>[0], 'batches' | 'snapshotProperties'>
    & { batchFactory: AppendBatchFactory, snapshotProperties?: Record<string, string> }

const APPEND_ID_SUMMARY_KEY = 'lakehouse.append-id'
const APPEND_LANDED_SCAN_DEPTH = 25

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
 * `deriveAppendId`/`appendAlreadyLanded`).
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
  const appendId = options.appendId ?? await deriveAppendId(args)
  const stampedArgs = {
    ...args,
    snapshotProperties: { ...(args as { snapshotProperties?: Record<string, string> }).snapshotProperties, [APPEND_ID_SUMMARY_KEY]: appendId },
  } as IcebergAppendArgs

  if (await appendAlreadyLanded(args, appendId))
    return

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const err = await icebergAppend(stampedArgs).then(() => undefined, (e: unknown) => e)
    if (err === undefined)
      return
    if (!isCommitTransient(err))
      throw err
    if (await appendAlreadyLanded(args, appendId))
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
  }

  if (await appendAlreadyLanded(args, appendId))
    return false

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const err = await icebergAppendBatches({
      ...stampedArgs,
      batches: batchFactory(),
    }).then(() => undefined, (e: unknown) => e)
    if (err === undefined)
      return true
    if (!isCommitTransient(err))
      throw err
    if (await appendAlreadyLanded(args, appendId))
      return true
    if (attempt === maxAttempts - 1)
      throw err
    const ceiling = Math.min(maxDelayMs, baseDelayMs * 2 ** attempt)
    await sleep(Math.floor(random() * ceiling))
  }
  return false
}

/** Content-addressed idempotency token — see `@gscdump/engine`'s original for full rationale. */
async function deriveAppendId(args: IcebergAppendArgs): Promise<string> {
  const records = ((args as { records?: ReadonlyArray<Record<string, unknown>> }).records) ?? []
  if (records.length === 0)
    return globalThis.crypto.randomUUID()
  const rowSig = (r: Record<string, unknown>): string =>
    Object.keys(r).sort().map(k => `${k}=${String(r[k])}`).join('')
  const body = records.map(rowSig).sort().join('')
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(body))
  return Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('')
}

/** Did the append carrying `appendId` already commit? REST catalogs only. */
async function appendAlreadyLanded(
  args: { catalog?: { type?: string }, namespace?: string | string[], table?: string },
  appendId: string,
): Promise<boolean> {
  const a = args as { catalog?: { type?: string }, namespace?: string | string[], table?: string }
  if (a.catalog?.type !== 'rest' || a.namespace == null || a.table == null)
    return false
  const { metadata } = await restCatalogLoadTable(a.catalog as Parameters<typeof restCatalogLoadTable>[0], {
    namespace: a.namespace,
    table: a.table,
  })
  const snapshots = (metadata as { snapshots?: Array<{ summary?: Record<string, string | undefined> }> }).snapshots ?? []
  const from = Math.max(0, snapshots.length - APPEND_LANDED_SCAN_DEPTH)
  for (let i = snapshots.length - 1; i >= from; i--) {
    if (snapshots[i]?.summary?.[APPEND_ID_SUMMARY_KEY] === appendId)
      return true
  }
  return false
}

// ---------------------------------------------------------------------------
// Read path — resolve data files for a partition slice (generic, ADR-0021
// amendment 9: parameterized over an arbitrary partition spec + value matches
// instead of the frozen `site_id`/`search_type` pair).
// ---------------------------------------------------------------------------

/** A data file in the current snapshot's manifest, scoped to one partition. */
export interface IcebergListedDataFile {
  filePath: string
  objectKey: string
  bytes: number
  rowCount: number
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

function resolvedFilesKey(
  scope: string,
  namespace: string,
  table: string,
  snapshotId: string,
  matches: readonly PartitionValueMatch[],
  wantedMonths: ReadonlySet<number>,
): string {
  const matchKey = [...matches].map(m => `${m.field}=${m.value}`).sort().join(',')
  const months = [...wantedMonths].sort((a, b) => a - b).join(',')
  return `lh-files\0${scope}\0${namespace}\0${table}\0${snapshotId}\0${matchKey}\0${months}`
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
      // metadata carries BigInt snapshot ids (see catalog-cache docstring), so a
      // plain JSON.stringify throws — stringifyBigintSafe measures the byte size
      // for the cache gate without crashing on those ids.
      const serialized = stringifyBigintSafe(metadata)
      if (serialized.length <= MAX_CACHED_METADATA_BYTES)
        await cachePut(cache, metadataRefKey(scope, namespace, table, snapshotId), metadata, METADATA_TTL_MS, now)
    }
  }
  return { snapshotId, metadata }
}

/**
 * List the parquet data files in the current snapshot of `table`, filtered to
 * one partition slice (`matches` + `range`). Generic over the partition spec —
 * the `IcebergDataset.resolveDataFiles` method is a thin wrapper that supplies
 * the def's own spec + identity/dims values.
 */
export async function resolveIcebergDataFiles(
  conn: IcebergConnection,
  opts: ResolveIcebergDataFilesOptions,
): Promise<IcebergListedDataFile[]> {
  const { namespace, table } = opts
  const profiler = opts.profiler
  const now = (opts.clock ?? Date.now)()
  const wantedMonths = new Set(monthsInRange(opts.range).map(monthsSinceEpoch))

  const endSnapshot = profiler?.start('iceberg.snapshot')
  let { snapshotId, metadata } = await loadSnapshotId(conn, namespace, table, opts.cache, now)
  endSnapshot?.({ cached: metadata == null && snapshotId != null })
  if (snapshotId == null)
    return []

  const scope = conn.cacheScope ?? ''
  const filesKey = resolvedFilesKey(scope, namespace, table, snapshotId, opts.matches, wantedMonths)
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
  const manifests = await icebergManifests({ metadata, resolver: conn.resolver, partitionFilter })

  const monthFieldName = opts.partitionSpec.find(f => f.transform === 'month')?.name
  const out: IcebergListedDataFile[] = []
  for (const m of manifests) {
    for (const entry of m.entries) {
      if (entry.status === 2)
        continue
      const df = entry.data_file
      if (df.content !== 0)
        continue
      const part = df.partition as Record<string, unknown>
      let matchesAll = true
      for (const match of opts.matches) {
        if (String(part[match.field]) !== String(match.value)) {
          matchesAll = false
          break
        }
      }
      if (!matchesAll)
        continue
      if (monthFieldName) {
        const month = part[monthFieldName]
        if (typeof month !== 'number' || !wantedMonths.has(month))
          continue
      }
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
    const freshKey = resolvedFilesKey(scope, namespace, table, snapshotId, opts.matches, wantedMonths)
    await cachePut(opts.cache, freshKey, out, RESOLVED_FILES_TTL_MS, now)
  }
  return out
}

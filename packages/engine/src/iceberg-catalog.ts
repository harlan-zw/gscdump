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

import type { IcebergColumnType, IcebergTableName } from './iceberg-schema'
import {
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
import {
  ICEBERG_PARTITION_SPEC,
  ICEBERG_SCHEMAS,
  ICEBERG_TABLES,
} from './iceberg-schema'

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

/** S3-compatible credentials for the R2 warehouse. */
export interface IcebergS3Config {
  /** R2 S3 endpoint, e.g. `https://<account>.r2.cloudflarestorage.com`. */
  endpoint: string
  accessKeyId: string
  secretAccessKey: string
  /** Defaults to `'auto'` (R2's region). */
  region?: string
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
  /** icebird S3 resolver, passed as `{ resolver }` to icebird write fns. */
  resolver: ReturnType<typeof s3SignedResolver>
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
export function icebergSchemaFor(table: IcebergTableName): IcebergSchema {
  return {
    'type': 'struct',
    'schema-id': 0,
    'fields': ICEBERG_SCHEMAS[table].columns.map(col => ({
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
export function icebergPartitionSpecFor(table: IcebergTableName): IcebergPartitionSpec {
  const fields = ICEBERG_SCHEMAS[table].columns
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
 * Connect to the R2 Data Catalog: a REST catalog context + a signed S3
 * resolver. Runs in Node and in `workerd` — SigV4 is Web Crypto, I/O is
 * `fetch`, no node builtins.
 */
export async function connectIcebergCatalog(config: IcebergCatalogConfig): Promise<IcebergConnection> {
  const catalog = await restCatalogConnect({
    url: config.catalogUri,
    warehouse: config.warehouse,
    requestInit: { headers: { Authorization: `Bearer ${config.catalogToken}` } },
  })
  const resolver = s3SignedResolver({
    accessKeyId: config.s3.accessKeyId,
    secretAccessKey: config.s3.secretAccessKey,
    region: config.s3.region ?? 'auto',
    endpoint: config.s3.endpoint,
    pathStyle: true,
  })
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

/** Outcome of a single table create/drop. */
export interface IcebergTableOpResult {
  table: string
  ok: boolean
  /** Present when `ok` is false. */
  error?: string
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
): Promise<IcebergTableOpResult[]> {
  const results: IcebergTableOpResult[] = []
  for (const table of tables) {
    // REST catalog `createTable` delegates to the catalog endpoint — no S3
    // resolver needed (unlike `icebergAppend`, which writes data files).
    await icebergCreateTable({
      catalog: conn.catalog,
      namespace: conn.namespace,
      table,
      schema: icebergSchemaFor(table),
      partitionSpec: icebergPartitionSpecFor(table),
    }).then(
      () => results.push({ table, ok: true }),
      (e: unknown) => results.push({ table, ok: false, error: String(e) }),
    )
  }
  return results
}

/** List the table names currently in the catalog namespace. */
export async function listIcebergTables(conn: IcebergConnection): Promise<string[]> {
  return restCatalogListTables(conn.catalog, { namespace: conn.namespace })
    .then(list => list.map(t => t.name).sort(), () => [])
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
  /** Partition identity column. */
  siteId: string
  /** Partition identity column. */
  searchType: string
  /**
   * Inclusive date range. Every month touched by `[start, end]` is scanned;
   * `month(date)` is the third partition transform.
   */
  range: { start: string, end: string }
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

/**
 * List the parquet data files in the current snapshot of `table`, filtered
 * to a single partition slice `(siteId, searchType, month(date) ∈ range)`.
 *
 * Cost: 1 REST `loadTable` + N manifest fetches (typically 1–10 small Avro
 * files). Iceberg returns the manifest list embedded in `metadata`, so a
 * cached `metadata` would let callers skip the REST call entirely.
 *
 * Skips deleted entries (status=2) and non-data file types (delete files).
 * Returns object keys + bytes + rowCount so the caller can build presigned
 * URLs without re-walking the catalog.
 */
export async function listIcebergDataFiles(
  conn: IcebergConnection,
  opts: ListIcebergDataFilesOptions,
): Promise<IcebergListedDataFile[]> {
  const { metadata } = await restCatalogLoadTable(conn.catalog, {
    namespace: conn.namespace,
    table: opts.table,
  })

  // No current snapshot — table exists but is empty. Empty list is correct.
  if (metadata['current-snapshot-id'] == null)
    return []

  const wantedMonths = new Set(monthsInRange(opts.range).map(monthsSinceEpoch))
  const manifests = await icebergManifests({ metadata, resolver: conn.resolver })

  const out: IcebergListedDataFile[] = []
  for (const m of manifests) {
    for (const entry of m.entries) {
      if (entry.status === 2)
        continue
      const df = entry.data_file
      if (df.content !== 0)
        continue
      const part = df.partition as Record<string, unknown>
      if (part.site_id !== opts.siteId)
        continue
      if (part.search_type !== opts.searchType)
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
  const targets = tables
    ?? (await restCatalogListTables(conn.catalog, { namespace: conn.namespace })
      .then(list => list.map(t => t.name), () => []))
  const results: IcebergTableOpResult[] = []
  for (const table of targets) {
    await icebergDropTable({
      catalog: conn.catalog,
      namespace: conn.namespace,
      table,
      purgeRequested: true,
    }).then(
      () => results.push({ table, ok: true }),
      (e: unknown) => results.push({ table, ok: false, error: String(e) }),
    )
  }
  return results
}

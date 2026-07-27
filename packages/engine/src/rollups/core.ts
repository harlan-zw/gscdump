// Pre-aggregated rollups computed post-sync. KB-sized JSON files served
// directly by the dashboard so the most-common widgets (totals, sparklines,
// top-N) avoid the parquet + DuckDB-WASM cold-start tax.
//
// Each rollup is rebuilt per-tenant by running a SQL aggregation over the
// fact tables (via `engine.runSQL`) and writing the result as a JSON
// document under `u_<userId>/<siteId>/rollups/<id>.json`. Rollup output is
// content-addressable via `__v<ts>.json` versioning; readers fetch via
// HEAD-pointer-style indirection or by listing the prefix.
//
// Format choice: JSON for small/simple rollups; parquet rollups (top-N
// tables that the dashboard wants to filter by date range) are a planned
// follow-up — they need a flexible-schema variant of `encodeRowsToParquet`.

import type { TenantCtx } from '@gscdump/contracts'
import type { SearchType } from 'gscdump/query'
import type { DataSource, FileSetRef, Row, TableName } from '../contracts'
import type { EngineError } from '../errors'
import type { ColumnDef } from '../schema'
import { encodeJsonBigintSafe } from '@gscdump/lakehouse/bigint'
import { encodeRowsToParquetFlex } from '../adapters/hyparquet'
import { engineErrors } from '../errors'
import { isoDateToUtcMs } from './dates'

export interface RollupCtx extends TenantCtx {
  /** When the rollup was built. Stamped into payload + filename. */
  builtAt: number
}

/**
 * Tenant-scoped engine surface a rollup builder needs. Subset of
 * `StorageEngine.runSQL` so rollups stay testable without a full engine.
 */
export interface RollupEngine {
  runSQL: (opts: {
    ctx: TenantCtx
    fileSets: Record<string, FileSetRef>
    table?: TableName
    sql: string
    params?: unknown[]
    /**
     * Restrict every manifest lookup to a single GSC search-type slice. The
     * rollup runner forwards `RebuildRollupsOptions.searchType` so the
     * aggregated facts never mix web + non-web rows. Undefined preserves
     * the legacy cross-type union (web-only tenants).
     */
    searchType?: SearchType
  }) => Promise<{ rows: Row[] }>
  /**
   * Read the live manifest for a (tenant, table[, searchType]) cohort —
   * cheap, no parquet decode. Builders use this to chunk a full-history scan
   * into byte-bounded windows (see `WINDOW_BYTE_BUDGET`) so a single `runSQL`
   * call never ships an oversized Arrow IPC payload across the Workers
   * service-binding RPC (32MiB hard cap).
   */
  listPartitions: (opts: {
    ctx: TenantCtx
    table: TableName
    searchType?: SearchType
  }) => Promise<Array<{ partition: string, bytes: number }>>
}

/**
 * One rollup definition. Build runs SQL over the tenant's facts and/or reads
 * from entity stores via `dataSource`, returning a JSON-serializable payload
 * that the runner timestamps + writes.
 */
export interface RollupDef {
  id: string
  /**
   * Window in days the rollup covers. `null` means full history. Used by
   * the runner to populate `windowDays` in the payload metadata so readers
   * can validate freshness.
   */
  windowDays: number | null
  /**
   * Storage format. `'json'` (default) wraps the build payload in a
   * `RollupEnvelope` and writes as a JSON blob. `'parquet'` expects `build`
   * to return rows matching `parquetColumns` and writes a parquet file plus
   * a tiny JSON sidecar envelope that points at it, so metadata
   * (`builtAt` / `windowDays`) stays readable without decoding parquet.
   */
  format?: 'json' | 'parquet'
  /**
   * Column schema for parquet output. Required when `format === 'parquet'`.
   * Types map the same way as the fact-table encoder: VARCHAR / DATE go
   * through BYTE_ARRAY/UTF8; BIGINT → INT64; INTEGER → INT32; DOUBLE → DOUBLE.
   */
  parquetColumns?: readonly ColumnDef[]
  /** Sort-key column names for parquet row-group stats. Optional. */
  parquetSortKey?: readonly string[]
  /**
   * When true, this rollup's payload is independent of GSC slice (e.g. entity
   * rollups sourced from sitemap / indexing snapshots, not slice-partitioned
   * fact tables). The runner rejects calls that pass `searchType` alongside
   * a slice-orthogonal def so the output never lands under a per-slice prefix
   * that the read path won't look at.
   */
  sliceOrthogonal?: boolean
  build: (deps: {
    engine: RollupEngine
    ctx: TenantCtx
    /**
     * Tenant-scoped object store. Rollups that aggregate over entity
     * snapshots (e.g. indexing metadata) read JSON docs through this.
     * Pure-SQL rollups can ignore it.
     */
    dataSource: DataSource
    /**
     * UTC millis the trailing window anchors to — its inclusive END. Equals
     * the newest synced/finalized data date when the runner is given
     * `dataEndDate`, otherwise wall-clock build time. Builders derive window
     * cutoffs from this (e.g. the trailing-28d boundary) and inline a date
     * literal so the SQL stays portable across DuckDB builds without the ICU
     * extension (Workers DuckDB — `CURRENT_DATE` lives in ICU).
     */
    windowAnchorMs: number
    /**
     * GSC search-type slice the runner was invoked for. Builders forward
     * this to every `engine.runSQL` call so the aggregated facts come
     * from one cohort. Undefined preserves the legacy cross-type union
     * (used by web-only tenants and admin paths).
     */
    searchType?: SearchType
  }) => Promise<unknown>
}

/**
 * Wire shape persisted to R2/disk. Readers can rely on the `version` + `builtAt`.
 * Parquet rollups write this envelope as a sidecar whose `payload` points at
 * the co-located `.parquet` object via `{ parquetKey, rowCount }`.
 */
export interface RollupEnvelope<T = unknown> {
  version: 1
  id: string
  builtAt: number
  windowDays: number | null
  payload: T
}

export interface ParquetRollupPointer {
  parquetKey: string
  rowCount: number
  /**
   * MULTI-FILE rollup: when set, the rollup is the UNION of these parquet keys
   * (disjoint by the grain's partition column, e.g. `date` for the resumable
   * `query_canonical_daily` build). Readers MUST union all keys; `parquetKey`
   * stays populated (the first part) for single-file readers. Avoids a JS
   * merge/re-encode of the whole rollup — the scaling bottleneck for a
   * cross-invocation resumable build.
   */
  parquetKeys?: string[]
}

function rollupPrefix(ctx: TenantCtx, searchType?: SearchType): string {
  const base = ctx.siteId
    ? `u_${ctx.userId}/${ctx.siteId}/rollups`
    : `u_${ctx.userId}/rollups`
  // Web is the implicit default and stays at the legacy path so existing
  // readers + rollup pointer URLs keep working. Non-web slices land under
  // a per-type segment so cross-type rollup outputs never collide.
  return searchType !== undefined && searchType !== 'web'
    ? `${base}/${searchType}`
    : base
}

export function rollupKey(ctx: TenantCtx, id: string, builtAt: number, searchType?: SearchType): string {
  return `${rollupPrefix(ctx, searchType)}/${id}__v${builtAt}.json`
}

export function rollupParquetKey(ctx: TenantCtx, id: string, builtAt: number, searchType?: SearchType): string {
  return `${rollupPrefix(ctx, searchType)}/${id}__v${builtAt}.parquet`
}

const ROLLUP_FILE_RE = /^(?<id>[a-z0-9_]+)__v(?<ts>\d+)\.json$/

// Minimal bucket shape — structurally satisfied by Cloudflare's `R2Bucket`,
// any S3-compatible adapter, or an in-memory fake.
//
// `list` mirrors the Cloudflare `R2Bucket.list` cursor protocol: a single call
// may return a `truncated` page with a `cursor` to resume from. Callers must
// loop until `truncated` is false (see `readLatestRollup`).
export interface RollupBucket {
  list: (opts: { prefix: string, cursor?: string }) => Promise<{
    objects: Array<{ key: string }>
    truncated?: boolean
    cursor?: string
  }>
  get: (key: string) => Promise<{ text: () => Promise<string> } | null>
}

// Inverse of `rollupKey`: locate and parse the newest JSON envelope for an
// `(ctx, id)` pair. Returns null when no envelope exists (first-sync site,
// or rollup id never built) so callers can fall back to another source.
// `searchType` scopes the prefix the same way `rollupKey` does — undefined
// reads the legacy/web path.
export async function readLatestRollup<T = unknown>(
  bucket: RollupBucket,
  ctx: TenantCtx,
  id: string,
  searchType?: SearchType,
): Promise<RollupEnvelope<T> | null> {
  const prefix = `${rollupPrefix(ctx, searchType)}/`
  let newest: { ts: number, key: string } | null = null
  // Prefix LIST is paginated: R2 returns a bounded page plus a `cursor` when
  // `truncated`. Loop the whole keyspace so the newest envelope is found even
  // when it lands on a later page than the first.
  let cursor: string | undefined
  do {
    // A LIST failure is a real failure, NOT "no rollup": the bucket signals
    // absence with an empty `objects` array, never by rejecting. Swallowing the
    // rejection here would make a network/auth blip look like a first-sync site.
    const listing = await bucket.list({ prefix, cursor })
    for (const obj of listing.objects) {
      const m = ROLLUP_FILE_RE.exec(obj.key.slice(prefix.length))
      if (!m?.groups || m.groups.id !== id)
        continue
      const ts = Number(m.groups.ts)
      if (!newest || ts > newest.ts)
        newest = { ts, key: obj.key }
    }
    cursor = listing.truncated ? listing.cursor : undefined
  } while (cursor !== undefined)
  if (!newest)
    return null
  // `get` returns `null` for an absent key — that's the only legitimate "no
  // rollup" signal. A rejection is a real GET failure and must surface, not be
  // collapsed into the same `null` as a missing object.
  const obj = await bucket.get(newest.key)
  if (!obj)
    return null
  return JSON.parse(await obj.text()) as RollupEnvelope<T>
}

export interface RebuildRollupsOptions {
  engine: RollupEngine
  dataSource: DataSource
  ctx: TenantCtx
  defs: readonly RollupDef[]
  now?: () => number
  /**
   * Build rollups for a single GSC search-type slice. Threads into every
   * builder's `engine.runSQL` call so the aggregated facts come from one
   * cohort, and namespaces the output object keys under a `<searchType>/`
   * segment so per-slice rollups coexist without overwriting each other.
   * Undefined preserves the legacy cross-type behaviour (one rollup over
   * the union of all slices, written to the legacy path) — fine for web-
   * only tenants and explicit cross-type admin views.
   */
  searchType?: SearchType
  /**
   * ISO date (`YYYY-MM-DD`) of the newest synced/finalized day. Trailing-
   * window rollups (28d/90d) anchor their window END here instead of
   * wall-clock build time, so a "last 28 days" rollup covers the 28 days of
   * data that actually exist — not 28 days back from whenever the job ran,
   * which would include GSC's 2-3 day empty tail. Omit for the legacy
   * wall-clock behaviour.
   */
  dataEndDate?: string
}

export interface RebuildRollupResult {
  id: string
  /** JSON envelope key. For parquet rollups this is the sidecar pointer. */
  objectKey: string
  /** Parquet payload key. Present only when `format === 'parquet'`. */
  parquetKey?: string
  /** Envelope byte size; for parquet rollups does NOT include parquet bytes. */
  bytes: number
  /** Parquet payload byte size when `format === 'parquet'`. */
  parquetBytes?: number
  builtAt: number
  /**
   * Set when this def's build/encode/write failed. The runner records the
   * failure and continues with the remaining defs so one bad rollup never
   * aborts the rest. Successful defs have no `error`. The human-readable
   * message (including the stack when available) lives on `error.message`.
   */
  error?: EngineError
}

export async function rebuildRollups(
  opts: RebuildRollupsOptions,
): Promise<RebuildRollupResult[]> {
  const now = opts.now ?? (() => Date.now())
  const dataEndMs = opts.dataEndDate !== undefined ? isoDateToUtcMs(opts.dataEndDate) : null
  const results: RebuildRollupResult[] = []
  for (const def of opts.defs) {
    const builtAt = now()
    // `builtAt` versions the object key; `windowAnchorMs` is what trailing
    // windows anchor to. They differ only when the runner supplies a
    // `dataEndDate` — otherwise the window ends at wall-clock build time.
    const windowAnchorMs = dataEndMs ?? builtAt
    // Slice-orthogonal defs (entity-store sourced) are independent of the GSC
    // slice — they always build once at the legacy/web path so their output
    // never lands under a per-slice prefix the read path won't look at. Slice-
    // aware defs honour the requested searchType.
    const defSearchType = def.sliceOrthogonal === true ? undefined : opts.searchType
    try {
      const payload = await def.build({
        engine: opts.engine,
        ctx: opts.ctx,
        dataSource: opts.dataSource,
        windowAnchorMs,
        ...(defSearchType !== undefined ? { searchType: defSearchType } : {}),
      })
      if (def.format === 'parquet') {
        if (!def.parquetColumns || def.parquetColumns.length === 0)
          throw new Error(`rollup '${def.id}' declared format='parquet' without parquetColumns`)
        const rows = (payload ?? []) as readonly Row[]
        const parquetBytes = encodeRowsToParquetFlex(rows, {
          columns: def.parquetColumns,
          sortKey: def.parquetSortKey,
        })
        const parquetKey = rollupParquetKey(opts.ctx, def.id, builtAt, defSearchType)
        await opts.dataSource.write(parquetKey, parquetBytes)
        const pointer: ParquetRollupPointer = { parquetKey, rowCount: rows.length }
        const envelope: RollupEnvelope<ParquetRollupPointer> = {
          version: 1,
          id: def.id,
          builtAt,
          windowDays: def.windowDays,
          payload: pointer,
        }
        const envelopeBytes = encodeJsonBigintSafe(envelope)
        const key = rollupKey(opts.ctx, def.id, builtAt, defSearchType)
        await opts.dataSource.write(key, envelopeBytes)
        results.push({
          id: def.id,
          objectKey: key,
          parquetKey,
          bytes: envelopeBytes.byteLength,
          parquetBytes: parquetBytes.byteLength,
          builtAt,
        })
        continue
      }
      const envelope: RollupEnvelope = {
        version: 1,
        id: def.id,
        builtAt,
        windowDays: def.windowDays,
        payload,
      }
      const bytes = encodeJsonBigintSafe(envelope)
      const key = rollupKey(opts.ctx, def.id, builtAt, defSearchType)
      await opts.dataSource.write(key, bytes)
      results.push({ id: def.id, objectKey: key, bytes: bytes.byteLength, builtAt })
    }
    catch (err) {
      // One failing def must never abort the rest. Record the error and move
      // on — callers split results into built (no `error`) vs failed.
      results.push({
        id: def.id,
        objectKey: '',
        bytes: 0,
        builtAt,
        error: engineErrors.rollupBuildFailed(def.id, err),
      })
    }
  }
  return results
}

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
import type { DataSource, FileSetRef, Row, TableName } from './contracts'
import type { EngineError } from './errors'
import type { ColumnDef } from './schema'
import { MS_PER_DAY } from 'gscdump'
import { encodeRowsToParquetFlex } from './adapters/hyparquet'
import { createIndexingMetadataStore, createSitemapStore, inspectionParquetKey, sitemapUrlsIndexPrefix } from './entities'
import { engineErrors } from './errors'
import { DEFAULT_SEARCH_TYPE } from './layout'
import { createQueryDimStore } from './query-dim'

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
    table?: import('@gscdump/engine/contracts').TableName
    sql: string
    params?: unknown[]
    /**
     * Restrict every manifest lookup to a single GSC search-type slice. The
     * rollup runner forwards `RebuildRollupsOptions.searchType` so the
     * aggregated facts never mix web + non-web rows. Undefined preserves
     * the legacy cross-type union (web-only tenants).
     */
    searchType?: SearchType
  }) => Promise<{ rows: import('@gscdump/engine/contracts').Row[] }>
  /**
   * Read the live manifest for a (tenant, table[, searchType]) cohort —
   * cheap, no parquet decode. Builders use this to chunk a full-history scan
   * into byte-bounded windows (see `WINDOW_BYTE_BUDGET`) so a single `runSQL`
   * call never ships an oversized Arrow IPC payload across the Workers
   * service-binding RPC (32MiB hard cap).
   */
  listPartitions: (opts: {
    ctx: TenantCtx
    table: import('@gscdump/engine/contracts').TableName
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
        const envelopeBytes = new TextEncoder().encode(JSON.stringify(envelope))
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
      const json = JSON.stringify(envelope)
      const bytes = new TextEncoder().encode(json)
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

// ISO-date `YYYY-MM-DD` that's `days` days before `at` (UTC). Used by rollup
// builders to inline a trailing-window cutoff into SQL instead of relying on
// `CURRENT_DATE`, which lives in the ICU extension and isn't available in
// every DuckDB build (notably Workers DuckDB).
// Parse an ISO `YYYY-MM-DD` date to UTC-midnight millis. Anchors trailing
// rollup windows to a data date rather than wall-clock time.
function isoDateToUtcMs(iso: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso)
  if (!m)
    throw new Error(`dataEndDate must be ISO YYYY-MM-DD, got: ${iso}`)
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
}

function utcDateMinusDays(at: number, days: number): string {
  const d = new Date(at - days * MS_PER_DAY)
  const y = d.getUTCFullYear()
  const m = String(d.getUTCMonth() + 1).padStart(2, '0')
  const day = String(d.getUTCDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

// ---------------------------------------------------------------------------
// Windowed rollup builds — chunk full-history scans so a single runSQL never
// ships an oversized Arrow IPC payload across the Workers RPC (32MiB cap).
// ---------------------------------------------------------------------------

/**
 * Per-window budget, measured in *parquet* bytes (manifest `bytes`), used by
 * `planRollupWindows` to chunk a full-history scan.
 *
 * The executor decodes a window's parquet and ships it as an Arrow IPC stream
 * over the service binding; that IPC is hard-guarded at 28MiB
 * (`IPC_PLACEHOLDER_BUDGET` in @gscdump/cloudflare). Parquet is compressed and
 * the IPC stream is not, so a window inflates on the wire — keep this
 * conservatively below the guard. Re-measure the parquet→IPC ratio against
 * production and raise if headroom allows.
 */
export const WINDOW_BYTE_BUDGET = 10 * 1024 * 1024

/**
 * Per-page OUTPUT row cap for key-paginated rollups (`runWindowed({ paginate })`
 * and `runPagedQuery`). `planRollupWindows` bounds the *input* parquet bytes a
 * window scans, which is a fine proxy for output size on fact aggregations whose
 * grain matches the input (one output row per input date). It is NOT a proxy for
 * aggregations that COLLAPSE to a smaller-cardinality grain whose row count is
 * driven by a high-cardinality GROUP key — `(query_canonical × date)` and
 * `(query_canonical)` — where output rows scale with distinct canonicals, not
 * input bytes. For those, each `runSQL` result (shipped as an Arrow IPC stream
 * over the Workers service-binding RPC; 28MiB guard in `@gscdump/cloudflare`,
 * duckdb-worker `assertResultBudget` at 24MiB / 100k rows) must be bounded by
 * paging the OUTPUT, independent of how the input is windowed.
 *
 * Narrow rows — `(canonical, date, 3 metrics)` — page at 50k (≈16MiB at the
 * worker's `cols×64` heuristic, well under both guards). WIDE rows carry a
 * `GROUP_CONCAT` variants string (up to ~10 variants × ~60 chars) the heuristic
 * under-counts, so they page smaller to keep the real IPC payload bounded.
 */
export const ROLLUP_PAGE_ROWS = 50_000
export const ROLLUP_PAGE_ROWS_WIDE = 20_000
// Daily canonical rollup: `(query_canonical, date, clicks, impressions,
// sum_position)` = 5 columns. The duckdb-worker result guard rejects a page whose
// estimate `rows × cols × 64` exceeds its 24MiB service-binding budget — and that
// estimate is intentionally PESSIMISTIC (64B/col regardless of real width), NOT
// the ~50B real row size. So the ceiling is 24MiB / (5 × 64) ≈ 78,643 rows; 90k
// (5 × 64 × 90k = 28.8MB) tripped it on a high-cardinality site whose window
// filled a full page (comparaja.pt). Page at 70k (≈21.4MiB estimate) with margin.
export const ROLLUP_PAGE_ROWS_DAILY = 70_000
// Day-span cap for the daily rollup's windows: keeps each window's
// `(query_canonical × date)` output under one page on a high-cardinality site so
// the build is single-pass (no OFFSET re-aggregation). The per-window pager is the
// safety net for any window that still over-produces.
export const DAILY_MAX_WINDOW_DAYS = 7

const DAY_RE = /^daily\/(\d{4})-(\d{2})-(\d{2})$/
const WEEK_RE = /^weekly\/(\d{4})-(\d{2})-(\d{2})$/
const MONTH_RE = /^monthly\/(\d{4})-(\d{2})$/
const QUARTER_RE = /^quarterly\/(\d{4})-Q([1-4])$/

function isoDate(ms: number): string {
  const d = new Date(ms)
  const y = d.getUTCFullYear()
  const m = String(d.getUTCMonth() + 1).padStart(2, '0')
  const day = String(d.getUTCDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

/**
 * UTC day-aligned [startMs, endMs] span a partition covers. Returns null for
 * `hourly/` partitions and anything unrecognised — those are excluded from
 * windowed planning.
 */
export function partitionDaySpan(partition: string): { startMs: number, endMs: number } | null {
  const day = DAY_RE.exec(partition)
  if (day) {
    const ms = Date.UTC(Number(day[1]), Number(day[2]) - 1, Number(day[3]))
    return { startMs: ms, endMs: ms }
  }
  const week = WEEK_RE.exec(partition)
  if (week) {
    const ms = Date.UTC(Number(week[1]), Number(week[2]) - 1, Number(week[3]))
    return { startMs: ms, endMs: ms + 6 * MS_PER_DAY }
  }
  const month = MONTH_RE.exec(partition)
  if (month) {
    const y = Number(month[1])
    const m = Number(month[2]) - 1
    const startMs = Date.UTC(y, m, 1)
    const endMs = Date.UTC(y, m + 1, 1) - MS_PER_DAY
    return { startMs, endMs }
  }
  const quarter = QUARTER_RE.exec(partition)
  if (quarter) {
    const y = Number(quarter[1])
    const q = Number(quarter[2])
    const startMonth = (q - 1) * 3
    const startMs = Date.UTC(y, startMonth, 1)
    const endMs = Date.UTC(y, startMonth + 3, 1) - MS_PER_DAY
    return { startMs, endMs }
  }
  return null
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n))
}

/**
 * Plan byte-bounded windows over a partition set. Each window names the
 * partitions whose span intersects it; a coarse tier file can land in two
 * windows, so every windowed SQL MUST also date-filter to the window bounds.
 */
export function planRollupWindows(
  parts: Array<{ partition: string, bytes: number }>,
  clampRange?: { start: string, end: string },
  // Hard upper bound on a window's day span, INDEPENDENT of the byte budget. The
  // byte budget bounds INPUT scan size, but a rollup whose OUTPUT row count scales
  // with cardinality × days (e.g. `query_canonical × date`) can over-produce per
  // window on a high-cardinality site even within a byte budget, forcing OFFSET
  // output-paging that RE-RUNS the aggregation per page (the canonical-daily
  // timeout). Capping the day span keeps each window's output under the page cap
  // → one page → single-pass, no re-aggregation. Smaller-but-more windows; the
  // total input scan is unchanged (windows are disjoint).
  maxWindowDays?: number,
): Array<{ start: string, end: string, partitions: string[] }> {
  const clampStartMs = clampRange ? Date.parse(`${clampRange.start}T00:00:00Z`) : undefined
  const clampEndMs = clampRange ? Date.parse(`${clampRange.end}T00:00:00Z`) : undefined
  const spans: Array<{ partition: string, bytes: number, startMs: number, endMs: number }> = []
  for (const p of parts) {
    const span = partitionDaySpan(p.partition)
    if (!span)
      continue
    if (clampStartMs !== undefined && clampEndMs !== undefined) {
      if (span.endMs < clampStartMs || span.startMs > clampEndMs)
        continue
    }
    spans.push({ partition: p.partition, bytes: p.bytes, startMs: span.startMs, endMs: span.endMs })
  }
  if (spans.length === 0)
    return []

  let rangeStartMs = Math.min(...spans.map(s => s.startMs))
  let rangeEndMs = Math.max(...spans.map(s => s.endMs))
  if (clampStartMs !== undefined)
    rangeStartMs = Math.max(rangeStartMs, clampStartMs)
  if (clampEndMs !== undefined)
    rangeEndMs = Math.min(rangeEndMs, clampEndMs)

  const totalBytes = spans.reduce((a, s) => a + s.bytes, 0)
  const spanDays = Math.floor((rangeEndMs - rangeStartMs) / MS_PER_DAY) + 1
  const bytesPerDay = Math.max(1, totalBytes / spanDays)
  const byteWindowDays = clamp(Math.floor(WINDOW_BYTE_BUDGET / bytesPerDay), 7, 400)
  // Apply the output-cardinality cap on top of the byte budget (min wins). Floor
  // at 1 so a tiny cap still makes progress.
  const windowDays = maxWindowDays != null ? Math.max(1, Math.min(byteWindowDays, maxWindowDays)) : byteWindowDays

  const windows: Array<{ start: string, end: string, partitions: string[] }> = []
  let cursorMs = rangeStartMs
  while (cursorMs <= rangeEndMs) {
    const windowEndMs = Math.min(cursorMs + (windowDays - 1) * MS_PER_DAY, rangeEndMs)
    const partitions = spans
      .filter(s => s.endMs >= cursorMs && s.startMs <= windowEndMs)
      .map(s => s.partition)
    if (partitions.length > 0)
      windows.push({ start: isoDate(cursorMs), end: isoDate(windowEndMs), partitions })
    cursorMs = windowEndMs + MS_PER_DAY
  }
  return windows
}

/** Partition strings whose span intersects the inclusive [start, end] date range. */
export function partitionsInRange(
  parts: Array<{ partition: string, bytes: number }>,
  start: string,
  end: string,
): string[] {
  const startMs = Date.parse(`${start}T00:00:00Z`)
  const endMs = Date.parse(`${end}T00:00:00Z`)
  const out: string[] = []
  for (const p of parts) {
    const span = partitionDaySpan(p.partition)
    if (!span)
      continue
    if (span.endMs >= startMs && span.startMs <= endMs)
      out.push(p.partition)
  }
  return out
}

/**
 * Run one aggregation over a FIXED file set, paging the OUTPUT by appending
 * `ORDER BY <orderBy> LIMIT <pageRows> OFFSET <n>` until a short page. Bounds
 * each `runSQL` result — and thus the Arrow IPC payload shipped over the Workers
 * service-binding RPC — regardless of GROUP cardinality (see `ROLLUP_PAGE_ROWS`).
 *
 * Contract: `coreSql` MUST be a complete `SELECT … GROUP BY …` with NO trailing
 * `ORDER BY`/`LIMIT` (they're appended here), and `orderBy` MUST be a TOTAL order
 * over the result (a superkey of the GROUP grain) so offset paging is
 * gap/overlap-free. OFFSET paging re-runs the aggregation per page; that's
 * acceptable for a post-sync background build, and the common case is a single
 * short page (no extra scans).
 */
async function runPagedQuery(opts: {
  engine: RollupEngine
  ctx: TenantCtx
  table: TableName
  searchType?: SearchType
  fileSets: Record<string, FileSetRef>
  coreSql: string
  orderBy: string
  pageRows: number
}): Promise<Row[]> {
  const out: Row[] = []
  for (let offset = 0; ; offset += opts.pageRows) {
    const result = await opts.engine.runSQL({
      ctx: opts.ctx,
      table: opts.table,
      fileSets: opts.fileSets,
      sql: `${opts.coreSql}\nORDER BY ${opts.orderBy}\nLIMIT ${opts.pageRows} OFFSET ${offset}`,
      ...(opts.searchType !== undefined ? { searchType: opts.searchType } : {}),
    })
    out.push(...result.rows)
    if (result.rows.length < opts.pageRows)
      break
  }
  return out
}

/**
 * Run a full-history aggregation in byte-bounded windows and concat the rows.
 * Each window's SQL MUST date-filter to `[w.start, w.end]` (see `sqlFor`) so a
 * tier file spanning a window boundary doesn't double-count calendar dates.
 *
 * `paginate` additionally pages each window's OUTPUT (see `runPagedQuery`) so a
 * window whose GROUP cardinality is high — `(query_canonical × date)` on a large
 * site — can't ship an oversized result even though its input bytes fit a window.
 * Date-windowing bounds the per-query scan; output paging bounds the IPC payload.
 * The two are orthogonal and compose. When `paginate` is set, `sqlFor` MUST emit
 * no trailing `ORDER BY`/`LIMIT` and `paginate.orderBy` MUST be a total order.
 */
export async function runWindowed(opts: {
  engine: RollupEngine
  ctx: TenantCtx
  table: TableName
  searchType?: SearchType
  sqlFor: (w: { start: string, end: string }) => string
  /**
   * Extra named file sets merged into every window's `runSQL` (alongside the
   * windowed `FILES`). Use to JOIN a non-windowed sidecar (e.g. the query
   * dimension parquet via `{ QUERY_DIM: { keys: [...] } }`) inside `sqlFor`.
   */
  extraFileSets?: Record<string, FileSetRef>
  /** Page each window's output by a total-order key. See `runPagedQuery`. */
  paginate?: { orderBy: string, pageRows: number }
  /** Cap each window's day span (output-cardinality bound). See `planRollupWindows`. */
  maxWindowDays?: number
}): Promise<Row[]> {
  const parts = await opts.engine.listPartitions({
    ctx: opts.ctx,
    table: opts.table,
    ...(opts.searchType !== undefined ? { searchType: opts.searchType } : {}),
  })
  const windows = planRollupWindows(parts, undefined, opts.maxWindowDays)
  const rows: Row[] = []
  for (const w of windows) {
    const fileSets = { FILES: { table: opts.table, partitions: w.partitions }, ...opts.extraFileSets }
    if (opts.paginate) {
      rows.push(...await runPagedQuery({
        engine: opts.engine,
        ctx: opts.ctx,
        table: opts.table,
        ...(opts.searchType !== undefined ? { searchType: opts.searchType } : {}),
        fileSets,
        coreSql: opts.sqlFor(w),
        orderBy: opts.paginate.orderBy,
        pageRows: opts.paginate.pageRows,
      }))
      continue
    }
    const result = await opts.engine.runSQL({
      ctx: opts.ctx,
      table: opts.table,
      fileSets,
      sql: opts.sqlFor(w),
      ...(opts.searchType !== undefined ? { searchType: opts.searchType } : {}),
    })
    rows.push(...result.rows)
  }
  return rows
}

// ---------------------------------------------------------------------------
// Default rollup definitions
// ---------------------------------------------------------------------------

/**
 * Daily totals across the full history. One row per (date, table) with
 * clicks + impressions + position. Powers sparklines and headline totals.
 *
 * Includes `anonymizedImpressionsPct` per day computed as
 *   1 - sum(query_grained_impressions) / sum(page_grained_impressions)
 * — surfaces GSC's anonymous-query gap so the dashboard can warn users not
 * to trust query-grained breakdowns as comprehensive.
 */
export const dailyTotalsRollup: RollupDef = {
  id: 'daily_totals',
  windowDays: null,
  async build({ engine, ctx, searchType }) {
    const pageRows = await runWindowed({
      engine,
      ctx,
      table: 'pages',
      ...(searchType !== undefined ? { searchType } : {}),
      sqlFor: w => `
        SELECT
          date,
          SUM(clicks)::BIGINT AS clicks,
          SUM(impressions)::BIGINT AS impressions,
          SUM(sum_position)::DOUBLE AS sum_position
        FROM read_parquet({{FILES}}, union_by_name = true)
        WHERE date >= '${w.start}' AND date <= '${w.end}'
        GROUP BY date
        ORDER BY date
      `,
    })
    const queryRows = await runWindowed({
      engine,
      ctx,
      table: 'queries',
      ...(searchType !== undefined ? { searchType } : {}),
      sqlFor: w => `
        SELECT
          date,
          SUM(impressions)::BIGINT AS impressions
        FROM read_parquet({{FILES}}, union_by_name = true)
        WHERE date >= '${w.start}' AND date <= '${w.end}'
        GROUP BY date
      `,
    })
    // Windows are date-disjoint, but merge defensively by date in case a tier
    // file straddling a boundary slipped a date through twice.
    const pagesByDate = new Map<string, { date: string, clicks: bigint, impressions: bigint, sum_position: number }>()
    for (const r of pageRows) {
      const date = String(r.date)
      const cur = pagesByDate.get(date) ?? { date, clicks: BigInt(0), impressions: BigInt(0), sum_position: 0 }
      cur.clicks += BigInt(r.clicks as bigint | number)
      cur.impressions += BigInt(r.impressions as bigint | number)
      cur.sum_position += Number(r.sum_position)
      pagesByDate.set(date, cur)
    }
    const queryImpressionsByDate = new Map<string, bigint>()
    for (const r of queryRows) {
      const date = String(r.date)
      queryImpressionsByDate.set(
        date,
        (queryImpressionsByDate.get(date) ?? BigInt(0)) + BigInt(r.impressions as bigint | number),
      )
    }
    return Array.from(pagesByDate.values()).sort((a, b) => (a.date < b.date ? -1 : 1)).map((r) => {
      const totalImpressions = BigInt(r.impressions as bigint | number)
      const queryImpressions = queryImpressionsByDate.get(String(r.date)) ?? BigInt(0)
      const anonymized = totalImpressions === BigInt(0)
        ? 0
        : 1 - Number(queryImpressions) / Number(totalImpressions)
      return {
        date: r.date,
        clicks: Number(r.clicks),
        impressions: Number(r.impressions),
        sum_position: Number(r.sum_position),
        anonymizedImpressionsPct: Math.max(0, Math.min(1, anonymized)),
      }
    })
  },
}

/** Weekly totals, ISO week aligned. Cheap and stable for trend widgets. */
export const weeklyTotalsRollup: RollupDef = {
  id: 'weekly_totals',
  windowDays: null,
  async build({ engine, ctx, searchType }) {
    const rows = await runWindowed({
      engine,
      ctx,
      table: 'pages',
      ...(searchType !== undefined ? { searchType } : {}),
      sqlFor: w => `
        SELECT
          strftime(date_trunc('week', date::DATE), '%Y-%m-%d') AS week,
          SUM(clicks)::BIGINT AS clicks,
          SUM(impressions)::BIGINT AS impressions,
          SUM(sum_position)::DOUBLE AS sum_position
        FROM read_parquet({{FILES}}, union_by_name = true)
        WHERE date >= '${w.start}' AND date <= '${w.end}'
        GROUP BY 1
        ORDER BY 1
      `,
    })
    // A calendar week can straddle a window boundary, so the same `week`
    // appears in two adjacent windows. Merge by week, summing every metric.
    const byWeek = new Map<string, { week: string, clicks: number, impressions: number, sum_position: number }>()
    for (const r of rows) {
      const week = String(r.week)
      const cur = byWeek.get(week) ?? { week, clicks: 0, impressions: 0, sum_position: 0 }
      cur.clicks += Number(r.clicks)
      cur.impressions += Number(r.impressions)
      cur.sum_position += Number(r.sum_position)
      byWeek.set(week, cur)
    }
    return Array.from(byWeek.values()).sort((a, b) => (a.week < b.week ? -1 : 1))
  },
}

/**
 * Top 1000 pages by clicks over the trailing 28-day window. JSON for v1;
 * promote to parquet (`top_pages_28d.parquet`) when the dashboard needs
 * server-side WHERE filtering on this rollup.
 */
export const topPages28dRollup: RollupDef = {
  id: 'top_pages_28d',
  windowDays: 28,
  async build({ engine, ctx, windowAnchorMs, searchType }) {
    const cutoff = utcDateMinusDays(windowAnchorMs, 28)
    const parts = await engine.listPartitions({
      ctx,
      table: 'pages',
      ...(searchType !== undefined ? { searchType } : {}),
    })
    const partitions = partitionsInRange(parts, cutoff, utcDateMinusDays(windowAnchorMs, 0))
    if (partitions.length === 0)
      return []
    const result = await engine.runSQL({
      ctx,
      table: 'pages',
      fileSets: { FILES: { table: 'pages', partitions } },
      ...(searchType !== undefined ? { searchType } : {}),
      sql: `
        SELECT
          url,
          SUM(clicks)::BIGINT AS clicks,
          SUM(impressions)::BIGINT AS impressions,
          SUM(sum_position)::DOUBLE AS sum_position
        FROM read_parquet({{FILES}}, union_by_name = true)
        WHERE date >= '${cutoff}'
        GROUP BY url
        ORDER BY clicks DESC
        LIMIT 1000
      `,
    })
    return result.rows.map(r => ({
      url: r.url,
      clicks: Number(r.clicks),
      impressions: Number(r.impressions),
      sum_position: Number(r.sum_position),
    }))
  },
}

/**
 * Top 250 countries by clicks over the trailing 28-day window. Countries
 * cardinality is bounded (~250 ISO codes), so the list fits in a tiny JSON
 * payload regardless of traffic shape. Powers a geo-overview widget without
 * spinning up DuckDB-WASM.
 */
export const topCountries28dRollup: RollupDef = {
  id: 'top_countries_28d',
  windowDays: 28,
  async build({ engine, ctx, windowAnchorMs, searchType }) {
    const cutoff = utcDateMinusDays(windowAnchorMs, 28)
    const parts = await engine.listPartitions({
      ctx,
      table: 'countries',
      ...(searchType !== undefined ? { searchType } : {}),
    })
    const partitions = partitionsInRange(parts, cutoff, utcDateMinusDays(windowAnchorMs, 0))
    if (partitions.length === 0)
      return []
    const result = await engine.runSQL({
      ctx,
      table: 'countries',
      fileSets: { FILES: { table: 'countries', partitions } },
      ...(searchType !== undefined ? { searchType } : {}),
      sql: `
        SELECT
          country,
          SUM(clicks)::BIGINT AS clicks,
          SUM(impressions)::BIGINT AS impressions,
          SUM(sum_position)::DOUBLE AS sum_position
        FROM read_parquet({{FILES}}, union_by_name = true)
        WHERE date >= '${cutoff}'
        GROUP BY country
        ORDER BY clicks DESC
        LIMIT 250
      `,
    })
    return result.rows.map(r => ({
      country: r.country,
      clicks: Number(r.clicks),
      impressions: Number(r.impressions),
      sum_position: Number(r.sum_position),
    }))
  },
}

/** Top 1000 keywords by clicks over the trailing 28-day window. */
export const topKeywords28dRollup: RollupDef = {
  id: 'top_keywords_28d',
  windowDays: 28,
  async build({ engine, ctx, windowAnchorMs, searchType }) {
    const cutoff = utcDateMinusDays(windowAnchorMs, 28)
    const parts = await engine.listPartitions({
      ctx,
      table: 'queries',
      ...(searchType !== undefined ? { searchType } : {}),
    })
    const partitions = partitionsInRange(parts, cutoff, utcDateMinusDays(windowAnchorMs, 0))
    if (partitions.length === 0)
      return []
    const result = await engine.runSQL({
      ctx,
      table: 'queries',
      fileSets: { FILES: { table: 'queries', partitions } },
      ...(searchType !== undefined ? { searchType } : {}),
      sql: `
        SELECT
          query,
          SUM(clicks)::BIGINT AS clicks,
          SUM(impressions)::BIGINT AS impressions,
          SUM(sum_position)::DOUBLE AS sum_position
        FROM read_parquet({{FILES}}, union_by_name = true)
        WHERE date >= '${cutoff}'
        GROUP BY query
        ORDER BY clicks DESC
        LIMIT 1000
      `,
    })
    return result.rows.map(r => ({
      query: r.query,
      clicks: Number(r.clicks),
      impressions: Number(r.impressions),
      sum_position: Number(r.sum_position),
    }))
  },
}

/**
 * Parquet-format companion to `topKeywords28dRollup`. Same shape, but persists
 * as a parquet object plus JSON sidecar pointer so widgets that need
 * server-side WHERE (filter by prefix, by clicks threshold, paginate) can scan
 * it directly with DuckDB-WASM instead of loading all 1000 rows into JS.
 *
 * Opt-in: include in the caller's rollup def list alongside (or instead of)
 * the JSON variant; the runner treats the two as independent ids so they can
 * coexist during a migration.
 */
export const topKeywords28dParquetRollup: RollupDef = {
  id: 'top_keywords_28d_parquet',
  windowDays: 28,
  format: 'parquet',
  parquetColumns: [
    { name: 'query', type: 'VARCHAR', nullable: false },
    { name: 'clicks', type: 'BIGINT', nullable: false },
    { name: 'impressions', type: 'BIGINT', nullable: false },
    { name: 'sum_position', type: 'DOUBLE', nullable: false },
  ],
  parquetSortKey: ['clicks'],
  async build({ engine, ctx, windowAnchorMs, searchType }) {
    const cutoff = utcDateMinusDays(windowAnchorMs, 28)
    const parts = await engine.listPartitions({
      ctx,
      table: 'queries',
      ...(searchType !== undefined ? { searchType } : {}),
    })
    const partitions = partitionsInRange(parts, cutoff, utcDateMinusDays(windowAnchorMs, 0))
    if (partitions.length === 0)
      return []
    const result = await engine.runSQL({
      ctx,
      table: 'queries',
      fileSets: { FILES: { table: 'queries', partitions } },
      ...(searchType !== undefined ? { searchType } : {}),
      sql: `
        SELECT
          query,
          SUM(clicks)::BIGINT AS clicks,
          SUM(impressions)::BIGINT AS impressions,
          SUM(sum_position)::DOUBLE AS sum_position
        FROM read_parquet({{FILES}}, union_by_name = true)
        WHERE date >= '${cutoff}'
        GROUP BY query
        ORDER BY clicks DESC
        LIMIT 1000
      `,
    })
    return result.rows.map(r => ({
      query: String(r.query),
      clicks: BigInt(r.clicks as bigint | number),
      impressions: BigInt(r.impressions as bigint | number),
      sum_position: Number(r.sum_position),
    }))
  },
}

/**
 * Materialises canonical-query variant grouping so the read path
 * (`buildExtrasQueries` in `resolver/compile.ts`) becomes a passthrough scan
 * instead of two window passes (`ROW_NUMBER`/`COUNT` over `PARTITION BY
 * query_canonical`) plus a `GROUP_CONCAT` over the whole `queries` table on
 * every request — work that is single-threaded under DuckDB-WASM/Workers and
 * scales with table size. See ADR-0017.
 *
 * One row per `query_canonical` group, columns named 1:1 with the live query's
 * output (`joinKey`, `variantCount`, `canonicalName`, `variants`) so
 * `mergeExtras` consumes either source unchanged. `variants` packs the top-10
 * variants as `query:::clicks:::impressions:::position` joined by `||`,
 * identical to the live composer.
 *
 * Full history (`windowDays: null`), not a trailing window: grouping metadata
 * is global (which variant is canonical, how many variants exist) and stays
 * stable across requests rather than shifting with each query's date range.
 * Reflects the last sync/compaction, not the live tail — readers that need the
 * tail can layer a recent-overlay later (the envelope carries `builtAt`).
 */
export const queryCanonicalVariantsRollup: RollupDef = {
  id: 'query_canonical_variants',
  windowDays: null,
  format: 'parquet',
  parquetColumns: [
    { name: 'joinKey', type: 'VARCHAR', nullable: false },
    { name: 'variantCount', type: 'BIGINT', nullable: false },
    { name: 'canonicalName', type: 'VARCHAR', nullable: true },
    { name: 'variants', type: 'VARCHAR', nullable: true },
  ],
  parquetSortKey: ['joinKey'],
  async build({ engine, ctx, dataSource, searchType }) {
    const parts = await engine.listPartitions({
      ctx,
      table: 'queries',
      ...(searchType !== undefined ? { searchType } : {}),
    })
    if (parts.length === 0)
      return []
    const partitions = parts.map(p => p.partition)
    // Per-VARIANT (one row per distinct `query`) clicks/impressions/sum_pos over
    // full history, KEYSET-paged by `query`. `query` is the table's physical
    // clusterKey (TABLE_METADATA.queries.clusterKey = ['query','date']), so
    // `query > cursor` lets DuckDB PRUNE every row group whose max(query) <= cursor
    // → each page scans only its query slice → ~one pass total. The OLD shape ran a
    // full-table `PARTITION BY canonical` window aggregation re-executed per OFFSET
    // page (N× full scans), which blew the 300s job reservation on high-cardinality
    // sites (plan §8; 60dbadbb). Paging by the RAW query (not the derived canonical
    // joinKey) is SAFE because we emit per-variant rows and regroup by canonical in
    // JS below — a canonical whose variants straddle a page boundary is reassembled.
    interface Variant { query: string, clicks: number, impressions: number, sumPos: number }
    const byCanonical = new Map<string, Variant[]>()
    const dimStore = createQueryDimStore({ dataSource })
    const useDim = (await dimStore.loadMeta(ctx)) !== null
    const canonExpr = useDim ? 'COALESCE(qd.query_canonical, q.query)' : 'q.query'
    let cursor: string | null = null
    for (;;) {
      const after = cursor === null ? '' : `AND q.query > '${cursor.replace(/'/g, '\'\'')}'`
      const fileSets: Record<string, FileSetRef> = { FILES: { table: 'queries', partitions } }
      if (useDim)
        fileSets.QUERY_DIM = { table: 'queries', keys: [dimStore.parquetKey(ctx)] }
      const { rows } = await engine.runSQL({
        ctx,
        table: 'queries',
        ...(searchType !== undefined ? { searchType } : {}),
        fileSets,
        sql: `
          SELECT
            ${canonExpr} AS joinKey,
            q.query AS query,
            SUM(q.clicks) AS clicks,
            SUM(q.impressions) AS impressions,
            SUM(q.sum_position) AS sum_pos
          FROM read_parquet({{FILES}}, union_by_name = true) q
          ${useDim ? 'LEFT JOIN read_parquet({{QUERY_DIM}}, union_by_name = true) qd ON q.query = qd.query' : ''}
          WHERE q.query IS NOT NULL ${after}
          GROUP BY ${canonExpr}, q.query
          ORDER BY q.query
          LIMIT ${ROLLUP_PAGE_ROWS_WIDE}
        `,
      })
      for (const r of rows) {
        const joinKey = String(r.joinKey)
        const list = byCanonical.get(joinKey)
        const v: Variant = { query: String(r.query), clicks: Number(r.clicks), impressions: Number(r.impressions), sumPos: Number(r.sum_pos) }
        if (list)
          list.push(v)
        else
          byCanonical.set(joinKey, [v])
      }
      if (rows.length < ROLLUP_PAGE_ROWS_WIDE)
        break
      cursor = String(rows[rows.length - 1]!.query)
    }

    // Final per-canonical format (in JS over the merged variants): rank by clicks
    // desc with a `query` tiebreak for deterministic output across rebuilds, then
    // pack the top-10 as `query:::clicks:::impressions:::position` joined by `||`,
    // identical to the old GROUP_CONCAT. `variantCount` counts ALL variants;
    // `canonicalName` is the top variant; a 0-impression variant is dropped from
    // the string (matching the old NULL-position omission) but still counted.
    const out: Array<{ joinKey: string, variantCount: bigint, canonicalName: string | null, variants: string | null }> = []
    for (const [joinKey, variants] of byCanonical) {
      variants.sort((a, b) => b.clicks - a.clicks || a.query.localeCompare(b.query))
      const canonicalName = variants[0]?.query ?? null
      const top = variants.slice(0, 10).filter(v => v.impressions > 0)
      const variantsStr = top.length === 0
        ? null
        : top.map(v => `${v.query}:::${v.clicks}:::${v.impressions}:::${(v.sumPos / v.impressions + 1).toFixed(1)}`).join('||')
      out.push({ joinKey, variantCount: BigInt(variants.length), canonicalName, variants: variantsStr })
    }
    return out
  },
}

const CANONICAL_DAILY_ROLLUP_FINAL_ID = 'query_canonical_daily'
const CANONICAL_DAILY_PART_STEM = 'query_canonical_daily__part'

/**
 * Canonical-grained fact aggregate (ADR-0018 Gap 2): pre-sums the raw
 * `(query × date)` query rows to `(query_canonical × date)`, so canonical-
 * primary top/gaining/losing reads a small pre-aggregated table instead of
 * re-collapsing variants on every request. Metrics are additive, so summing
 * these per-date sums over a window is exact — identical to aggregating the raw
 * rows.
 *
 * Null-free by construction: groups by the versioned query dimension when it
 * exists, with raw query as the fallback, so the rollup never carries a NULL/''
 * canonical bucket and the read path can treat the rollup's `query_canonical`
 * column as already-derived.
 *
 * Date-grained full history (`windowDays: null`): one rollup serves every date
 * range (reads filter by `date`) and both windows of a comparison. Opt-in (not
 * in `DEFAULT_ROLLUPS`); the host points the main query's file set at it for
 * queries the rollup covers (see `canonicalRollupCovers` /
 * `RunOptimizedQueryOptions.canonicalSource`).
 */
export const queryCanonicalDailyRollup: RollupDef = {
  id: 'query_canonical_daily',
  windowDays: null,
  format: 'parquet',
  parquetColumns: [
    { name: 'query_canonical', type: 'VARCHAR', nullable: false },
    { name: 'date', type: 'DATE', nullable: false },
    { name: 'clicks', type: 'BIGINT', nullable: false },
    { name: 'impressions', type: 'BIGINT', nullable: false },
    { name: 'sum_position', type: 'DOUBLE', nullable: false },
  ],
  parquetSortKey: ['date', 'query_canonical'],
  async build({ engine, ctx, dataSource, searchType }) {
    // Prefer the versioned query dimension when present: derive canonical from
    // it (JOIN on raw query) so the rollup reflects the CURRENT normalizer
    // version without re-ingesting facts — a rebuild of the small dimension is
    // enough. Falls back to raw query grouping when the dimension is absent.
    // See ADR-0019 / ADR-0020.
    const dimStore = createQueryDimStore({ dataSource })
    const useDim = (await dimStore.loadMeta(ctx)) !== null
    const canonExpr = useDim
      ? `COALESCE(qd.query_canonical, q.query)`
      : `query`

    // Byte-bounded date windows: `(query_canonical × date)` is unbounded for a
    // large site, so a single scan could exceed the Workers service-binding RPC
    // cap (32MiB Arrow). Each window date-filters and the grain is keyed by
    // date, so a date lands in exactly one window — the concat is exact.
    const rows = await runWindowed({
      engine,
      ctx,
      table: 'queries',
      ...(searchType !== undefined ? { searchType } : {}),
      ...(useDim ? { extraFileSets: { QUERY_DIM: { table: 'queries', keys: [dimStore.parquetKey(ctx)] } } } : {}),
      // `(query_canonical × date)` row count scales with distinct canonicals, not
      // input bytes, so a byte-sized window can still over-produce on a high-
      // cardinality site (GSCDUMP-P: 20.5k rows tripped the old 10k cap). Page the
      // output by its unique (date, query_canonical) grain so each runSQL stays
      // bounded regardless of cardinality.
      paginate: { orderBy: 'date, query_canonical', pageRows: ROLLUP_PAGE_ROWS_DAILY },
      maxWindowDays: DAILY_MAX_WINDOW_DAYS,
      sqlFor: dailyWindowSqlFor(useDim, canonExpr),
    })
    return rows.map(mapDailyRow)
  },
}

// Shared between the one-shot `queryCanonicalDailyRollup.build` and the resumable
// `rebuildCanonicalDailyResumable` builder so the two can't drift.
function dailyWindowSqlFor(useDim: boolean, canonExpr: string): (w: { start: string, end: string }) => string {
  return useDim
    ? w => `
        SELECT
          ${canonExpr} AS query_canonical,
          CAST(q.date AS VARCHAR) AS date,
          SUM(q.clicks)::BIGINT AS clicks,
          SUM(q.impressions)::BIGINT AS impressions,
          SUM(q.sum_position)::DOUBLE AS sum_position
        FROM read_parquet({{FILES}}, union_by_name = true) q
        LEFT JOIN read_parquet({{QUERY_DIM}}, union_by_name = true) qd ON q.query = qd.query
        WHERE q.date >= '${w.start}' AND q.date <= '${w.end}'
        GROUP BY ${canonExpr}, q.date
      `
    : w => `
        SELECT
          ${canonExpr} AS query_canonical,
          CAST(date AS VARCHAR) AS date,
          SUM(clicks)::BIGINT AS clicks,
          SUM(impressions)::BIGINT AS impressions,
          SUM(sum_position)::DOUBLE AS sum_position
        FROM read_parquet({{FILES}}, union_by_name = true)
        WHERE date >= '${w.start}' AND date <= '${w.end}'
        GROUP BY ${canonExpr}, date
      `
}

function mapDailyRow(r: Row): Row {
  return {
    query_canonical: String(r.query_canonical),
    date: String(r.date),
    clicks: BigInt(r.clicks as bigint | number),
    impressions: BigInt(r.impressions as bigint | number),
    sum_position: Number(r.sum_position),
  }
}

/**
 * Resumable, cross-invocation build of `query_canonical_daily` for a high-
 * cardinality site whose full windowed build exceeds one job reservation (300s).
 *
 * Each call builds from `(windowOffset, pageOffset)` until `deadlineMs`, writes
 * that batch's rows to a PART parquet, and returns `{ done:false, nextWindowOffset,
 * nextPageOffset }` for the caller to re-enqueue. When the last window is fully
 * paged it publishes a multi-file envelope listing every part (parts are disjoint
 * by `(query_canonical, date)`, so the read path just unions them — no merge),
 * returning `{ done:true }`. `builtAt` MUST be stable across the continuation chain
 * (it versions both the part keys and the final rollup key).
 *
 * INTRA-WINDOW resumability: the deadline is checked between OUTPUT PAGES, not just
 * between windows. A single high-cardinality window's paged aggregation can exceed
 * one 300s reservation on its own; checking only between windows let that window
 * run unbounded and stale-reservation-loop forever (huuto.net/comparaja.pt never
 * completed window 0). `pageOffset` lets a continuation resume the SAME window at
 * the next page, so no single invocation runs past the deadline by more than one
 * page. Parts are keyed by `(windowOffset, pageOffset)` so a mid-window pause and
 * its continuation write disjoint, non-colliding files.
 */
export async function rebuildCanonicalDailyResumable(opts: {
  engine: RollupEngine
  ctx: TenantCtx
  dataSource: DataSource
  searchType?: SearchType
  builtAt: number
  windowOffset: number
  /** Resume the `windowOffset` window at this output-page offset (0 = window start). */
  pageOffset?: number
  /** Output rows per page (default `ROLLUP_PAGE_ROWS_DAILY`). Injectable for tests. */
  pageRows?: number
  deadlineMs: number
}): Promise<{ done: boolean, nextWindowOffset: number, nextPageOffset: number, windowsTotal: number, windowsBuilt: number, rowsWritten: number }> {
  const { engine, ctx, dataSource, searchType, builtAt, windowOffset, deadlineMs } = opts
  const sType = searchType !== undefined ? { searchType } : {}
  const startPageOffset = opts.pageOffset ?? 0
  const pageRows = opts.pageRows ?? ROLLUP_PAGE_ROWS_DAILY

  const parts = await engine.listPartitions({ ctx, table: 'queries', ...sType })
  const windows = planRollupWindows(parts.map(p => ({ partition: p.partition, bytes: p.bytes })), undefined, DAILY_MAX_WINDOW_DAYS)
  const windowsTotal = windows.length

  const dimStore = createQueryDimStore({ dataSource })
  const useDim = (await dimStore.loadMeta(ctx)) !== null
  const canonExpr = useDim
    ? `COALESCE(qd.query_canonical, q.query)`
    : `query`
  const extraFileSets = useDim ? { QUERY_DIM: { table: 'queries' as TableName, keys: [dimStore.parquetKey(ctx)] } } : undefined
  const sqlFor = dailyWindowSqlFor(useDim, canonExpr)
  const cols = queryCanonicalDailyRollup.parquetColumns!
  const sortKey = queryCanonicalDailyRollup.parquetSortKey

  // Build from (windowOffset, startPageOffset), paging each window's output until
  // the deadline (or all windows done). Each page is FLUSHED to its own PART
  // immediately, so orchestrator memory stays bounded to a single page regardless
  // of window size or invocation length — accumulating a whole invocation's rows
  // and encoding one part at the end OOM/CPU-killed the isolate on the largest
  // sites (`largemirage`: the daily encode crashed after ~170s of paging). Parts
  // are keyed by (window, page) and disjoint by `(query_canonical, date)`, so they
  // union with no merge. The deadline is honoured BETWEEN PAGES so neither time nor
  // memory can blow the 300s reservation.
  let i = windowOffset
  // `page` is the FIRST window's resume cursor; every later window starts at 0.
  let page = startPageOffset
  // Resume coordinates when we stop early. Default to "all done".
  let nextWindowOffset = windowsTotal
  let nextPageOffset = 0
  let rowsWritten = 0
  const flushPage = async (windowIdx: number, pageOffset: number, rows: Row[]): Promise<void> => {
    if (rows.length === 0)
      return
    const key = rollupParquetKey(ctx, `${CANONICAL_DAILY_PART_STEM}__w${windowIdx}_p${pageOffset}`, builtAt, searchType)
    await dataSource.write(key, encodeRowsToParquetFlex(rows, { columns: cols, sortKey }))
    rowsWritten += rows.length
  }
  windowLoop: for (; i < windowsTotal; i++) {
    const w = windows[i]!
    const coreSql = sqlFor(w)
    for (;;) {
      const result = await engine.runSQL({
        ctx,
        table: 'queries',
        ...sType,
        fileSets: { FILES: { table: 'queries', partitions: w.partitions }, ...extraFileSets },
        sql: `${coreSql}\nORDER BY date, query_canonical\nLIMIT ${pageRows} OFFSET ${page}`,
      })
      await flushPage(i, page, result.rows.map(mapDailyRow))
      const windowDone = result.rows.length < pageRows
      page += pageRows
      if (windowDone) {
        page = 0 // next window starts fresh
        break
      }
      if (Date.now() > deadlineMs) {
        // Pause mid-window; the continuation resumes THIS window at `page`.
        nextWindowOffset = i
        nextPageOffset = page
        break windowLoop
      }
    }
    // Full window built. Honour the deadline before starting the next one.
    if (Date.now() > deadlineMs) {
      nextWindowOffset = i + 1
      nextPageOffset = 0
      break
    }
  }

  if (nextWindowOffset < windowsTotal || nextPageOffset > 0)
    return { done: false, nextWindowOffset, nextPageOffset, windowsTotal, windowsBuilt: nextWindowOffset - windowOffset, rowsWritten }

  // FINAL window built → publish a MULTI-FILE envelope listing every part for this
  // builtAt. The read path unions the parts (disjoint dates). No decode+re-encode
  // of the whole rollup (the scaling bottleneck that timed out the merge): the
  // build is now genuinely O(rows) across invocations with no quadratic finalize.
  // Old-builtAt parts are orphaned; a GC sweep can prune them — the read path only
  // follows the latest envelope's `parquetKeys`.
  const partPrefixDir = rollupParquetKey(ctx, CANONICAL_DAILY_PART_STEM, builtAt, searchType).replace(/[^/]*$/, '')
  const partKeys = (await dataSource.list(partPrefixDir))
    .filter(k => k.includes(`${CANONICAL_DAILY_PART_STEM}__w`) && k.endsWith(`__v${builtAt}.parquet`))
    .sort()
  // Per-page flush writes nothing for empty pages, so a slice with zero rows would
  // leave no parts. Guarantee ≥1 file so the envelope always has a valid pointer.
  if (partKeys.length === 0) {
    const emptyKey = rollupParquetKey(ctx, `${CANONICAL_DAILY_PART_STEM}__w0_p0`, builtAt, searchType)
    await dataSource.write(emptyKey, encodeRowsToParquetFlex([], { columns: cols, sortKey }))
    partKeys.push(emptyKey)
  }
  const envelope: RollupEnvelope<ParquetRollupPointer> = {
    version: 1,
    id: CANONICAL_DAILY_ROLLUP_FINAL_ID,
    builtAt,
    windowDays: queryCanonicalDailyRollup.windowDays,
    payload: { parquetKey: partKeys[0]!, parquetKeys: partKeys, rowCount: 0 },
  }
  await dataSource.write(rollupKey(ctx, CANONICAL_DAILY_ROLLUP_FINAL_ID, builtAt, searchType), new TextEncoder().encode(JSON.stringify(envelope)))
  return { done: true, nextWindowOffset, nextPageOffset, windowsTotal, windowsBuilt: nextWindowOffset - windowOffset, rowsWritten }
}

/**
 * Aggregates the per-URL Indexing API metadata entity store (populated by
 * `gscdump entities indexing snapshot`) into daily counts of `URL_UPDATED`
 * and `URL_REMOVED` notifications. Covers the third entity-snapshot shape
 * without needing its own parquet family — publish events are sparse and
 * aggregate cleanly into a small JSON rollup.
 *
 * Safe no-op when the entity store is empty: returns `{ totals: {...}, days: [] }`
 * so downstream readers don't have to special-case first-run sites.
 */
export const indexingMetadataRollup: RollupDef = {
  id: 'indexing_metadata',
  windowDays: null,
  async build({ dataSource, ctx }) {
    const store = createIndexingMetadataStore({ dataSource })
    const index = await store.loadIndex(ctx)
    const records = Object.values(index.records)

    const updatesByDay = new Map<string, number>()
    const removesByDay = new Map<string, number>()
    let totalUpdates = 0
    let totalRemoves = 0
    let latestUpdate: string | undefined
    let latestRemove: string | undefined

    for (const r of records) {
      if (r.latestUpdateAt) {
        totalUpdates++
        const day = r.latestUpdateAt.slice(0, 10)
        updatesByDay.set(day, (updatesByDay.get(day) ?? 0) + 1)
        if (!latestUpdate || r.latestUpdateAt > latestUpdate)
          latestUpdate = r.latestUpdateAt
      }
      if (r.latestRemoveAt) {
        totalRemoves++
        const day = r.latestRemoveAt.slice(0, 10)
        removesByDay.set(day, (removesByDay.get(day) ?? 0) + 1)
        if (!latestRemove || r.latestRemoveAt > latestRemove)
          latestRemove = r.latestRemoveAt
      }
    }

    const days = new Set<string>([...updatesByDay.keys(), ...removesByDay.keys()])
    const perDay = Array.from(days)
      .sort()
      .map(day => ({
        day,
        updates: updatesByDay.get(day) ?? 0,
        removes: removesByDay.get(day) ?? 0,
      }))

    return {
      totals: {
        urls: records.length,
        updates: totalUpdates,
        removes: totalRemoves,
        latestUpdateAt: latestUpdate ?? null,
        latestRemoveAt: latestRemove ?? null,
      },
      days: perDay,
    }
  },
}

// ---------------------------------------------------------------------------
// §C: Indexing & sitemap rollups (replaces D1 timeseries tables)
// ---------------------------------------------------------------------------

/**
 * Indexing-API health by day: per `inspectedAt` date, counts of indexed,
 * soft-404, redirect, not-found, mobile passes, rich-results passes, and
 * canonical mismatches. Sourced from the inspections parquet sidecar
 * (`InspectionStore.parquetUri`), which holds the latest record per URL.
 *
 * Empty-payload no-op when the sidecar URI is unavailable (in-memory
 * `DataSource`, or before `materialize` has run).
 */
export const indexingHealthRollup: RollupDef = {
  id: 'indexing_health',
  windowDays: 90,
  sliceOrthogonal: true,
  async build({ engine, ctx, dataSource, windowAnchorMs }) {
    // Skip when the parquet sidecar hasn't been materialized yet. We probe
    // with `head` (cheap; no body) rather than `parquetUri` because we now
    // route the read through `fileSets.keys` so DuckDB pre-fetches bytes —
    // the URI itself is no longer the gate.
    const key = inspectionParquetKey(ctx)
    const exists = await dataSource.head?.(key)
    if (!exists)
      return { days: [] }
    const cutoff = utcDateMinusDays(windowAnchorMs, 90)
    // `read_parquet({{INSPECTIONS}}, union_by_name = true)` flows through the
    // executor's prefetch path: bytes are read via the `DataSource` (R2
    // binding) and registered as a virtual file before query. Crucial under
    // the duckdb-worker, whose httpfs path bypasses `r2://` URIs (see
    // docs/repros/ducklings-r2-httpfs.md).
    //
    // Explicit `CAST(... AS VARCHAR)` per string column: DuckDB-WASM
    // (ducklings) mis-types all-null UTF8 parquet columns as INT32, which
    // makes `<col> = 'PASS'` fail with a string-to-INT32 conversion error on
    // small sites where every row's verdict is null. The cast forces the
    // string interpretation regardless of inference.
    const sql = `
      SELECT
        substr(CAST(inspectedAt AS VARCHAR), 1, 10) AS date,
        COUNT(*)::BIGINT AS total_urls,
        SUM(CASE WHEN CAST(indexStatus AS VARCHAR) = 'PASS' THEN 1 ELSE 0 END)::BIGINT AS indexed_count,
        SUM(CASE WHEN CAST(pageFetchState AS VARCHAR) = 'SOFT_404' THEN 1 ELSE 0 END)::BIGINT AS soft_404,
        SUM(CASE WHEN CAST(pageFetchState AS VARCHAR) = 'REDIRECT_ERROR' THEN 1 ELSE 0 END)::BIGINT AS redirect,
        SUM(CASE WHEN CAST(pageFetchState AS VARCHAR) = 'NOT_FOUND' THEN 1 ELSE 0 END)::BIGINT AS not_found,
        SUM(CASE WHEN CAST(mobileUsabilityVerdict AS VARCHAR) = 'PASS' THEN 1 ELSE 0 END)::BIGINT AS mobile_passes,
        SUM(CASE WHEN CAST(richResultsVerdict AS VARCHAR) = 'PASS' THEN 1 ELSE 0 END)::BIGINT AS rich_results_passes,
        SUM(CASE WHEN userCanonical IS NOT NULL AND googleCanonical IS NOT NULL AND CAST(userCanonical AS VARCHAR) <> CAST(googleCanonical AS VARCHAR) THEN 1 ELSE 0 END)::BIGINT AS canonical_mismatches
      FROM read_parquet({{INSPECTIONS}}, union_by_name = true)
      WHERE substr(CAST(inspectedAt AS VARCHAR), 1, 10) >= '${cutoff}'
      GROUP BY 1
      ORDER BY 1
    `
    const result = await engine.runSQL({
      ctx,
      table: 'pages',
      fileSets: { INSPECTIONS: { table: 'pages', keys: [key] } },
      sql,
    })
    return {
      days: result.rows.map(r => ({
        date: String(r.date),
        total_urls: Number(r.total_urls),
        indexed_count: Number(r.indexed_count),
        soft_404: Number(r.soft_404),
        redirect: Number(r.redirect),
        not_found: Number(r.not_found),
        mobile_passes: Number(r.mobile_passes),
        rich_results_passes: Number(r.rich_results_passes),
        canonical_mismatches: Number(r.canonical_mismatches),
      })),
    }
  },
}

/**
 * Per-day index-percent: ratio of (sitemap URLs that received GSC clicks on
 * that date) / (total live sitemap URLs). Uses a DuckDB JOIN between the
 * sitemap urls parquet (`SitemapStore.urlsParquetUri`) and the `pages` fact
 * parquet. Total denominator is the count of live URLs in the urls index;
 * numerator is per-day distinct loc count where pages.clicks > 0.
 */
export const indexPercentRollup: RollupDef = {
  id: 'index_percent',
  windowDays: 90,
  sliceOrthogonal: true,
  async build({ engine, ctx, dataSource, windowAnchorMs, searchType }) {
    // The URLs index is partitioned one parquet per feedpath; list every
    // per-feedpath file and read them as a set. `read_parquet` over the key
    // list unions them, and routing via `fileSets.keys` lets DuckDB pre-fetch
    // bytes — the path that works under the duckdb-worker bypass.
    const urlsKeys = await dataSource.list(sitemapUrlsIndexPrefix(ctx))
    if (urlsKeys.length === 0)
      return { totalSitemapUrls: 0, days: [] }
    const cutoff = utcDateMinusDays(windowAnchorMs, 90)
    // Numerator: per-day distinct sitemap URLs with clicks>0. This rollup is
    // written at the legacy path, so omitted searchType means the web slice,
    // not a cross-type union. URLS is a direct-keys
    // sidecar (entity store, not slice-partitioned) so searchType doesn't
    // apply to it.
    const factSearchType = searchType ?? DEFAULT_SEARCH_TYPE
    const pagesParts = await engine.listPartitions({
      ctx,
      table: 'pages',
      searchType: factSearchType,
    })
    const pagesPartitions = partitionsInRange(pagesParts, cutoff, utcDateMinusDays(windowAnchorMs, 0))
    const numerator = await engine.runSQL({
      ctx,
      table: 'pages',
      fileSets: {
        PAGES: { table: 'pages', partitions: pagesPartitions },
        URLS: { table: 'pages', keys: urlsKeys },
      },
      searchType: factSearchType,
      sql: `
        SELECT
          p.date AS date,
          COUNT(DISTINCT p.url)::BIGINT AS clicked_urls
        FROM read_parquet({{PAGES}}, union_by_name = true) p
        INNER JOIN read_parquet({{URLS}}, union_by_name = true) s
          ON s.loc = p.url AND s.removed_at IS NULL
        WHERE p.clicks > 0 AND p.date >= '${cutoff}'
        GROUP BY p.date
        ORDER BY p.date
      `,
    })
    // Denominator: total live sitemap URLs
    const denom = await engine.runSQL({
      ctx,
      table: 'pages',
      fileSets: { URLS: { table: 'pages', keys: urlsKeys } },
      sql: `
        SELECT COUNT(*)::BIGINT AS total
        FROM read_parquet({{URLS}}, union_by_name = true)
        WHERE removed_at IS NULL
      `,
    })
    const total = Number(denom.rows[0]?.total ?? 0)
    return {
      totalSitemapUrls: total,
      days: numerator.rows.map((r) => {
        const clicked = Number(r.clicked_urls)
        return {
          date: String(r.date),
          clicked_urls: clicked,
          total_sitemap_urls: total,
          ratio: total === 0 ? 0 : clicked / total,
        }
      }),
    }
  },
}

/**
 * Sitemap-health per-day series materialized from the sitemap-store JSON
 * index. Each `SitemapRecord` carries `urlCount`, `errors`, `warnings`,
 * `contentHash`, and `lastDownloaded`. We bucket records by the day of their
 * `capturedAt` (or `lastDownloaded` fallback) and emit per-day aggregates plus
 * a snapshot of per-feed stats at the most recent capture.
 */
export const sitemapHealthRollup: RollupDef = {
  id: 'sitemap_health',
  windowDays: 90,
  sliceOrthogonal: true,
  async build({ dataSource, ctx, windowAnchorMs }) {
    const store = createSitemapStore({ dataSource })
    const index = await store.loadIndex(ctx)
    const records = Object.values(index.records)
    const cutoff = utcDateMinusDays(windowAnchorMs, 90)

    interface DayBucket {
      day: string
      feeds: number
      total_urls: number
      errors: number
      warnings: number
    }
    const byDay = new Map<string, DayBucket>()
    const feeds: Array<{
      path: string
      urlCount: number
      errors: number
      warnings: number
      contentHash: string | null
      lastDownloaded: string | null
      capturedAt: string
    }> = []

    for (const r of records) {
      const day = (r.capturedAt ?? r.lastDownloaded ?? '').slice(0, 10)
      if (!day || day < cutoff)
        continue
      const errors = Number(r.errors ?? 0)
      const warnings = Number(r.warnings ?? 0)
      const urlCount = Number(r.urlCount ?? 0)
      const bucket = byDay.get(day) ?? { day, feeds: 0, total_urls: 0, errors: 0, warnings: 0 }
      bucket.feeds += 1
      bucket.total_urls += urlCount
      bucket.errors += errors
      bucket.warnings += warnings
      byDay.set(day, bucket)
      feeds.push({
        path: r.path,
        urlCount,
        errors,
        warnings,
        contentHash: r.contentHash ?? null,
        lastDownloaded: r.lastDownloaded ?? null,
        capturedAt: r.capturedAt,
      })
    }

    const days = Array.from(byDay.values()).sort((a, b) => (a.day < b.day ? -1 : 1))
    return { days, feeds }
  },
}

/**
 * Trailing-28-day sitemap URL changes: per-day per-feedpath {added, removed}
 * counts plus rolling top-200 added and removed URLs. Streams from
 * `SitemapStore.loadDeltas()` so it scales independently of how many feeds
 * exist on the site.
 */
export const sitemapChanges28dRollup: RollupDef = {
  id: 'sitemap_changes_28d',
  windowDays: 28,
  sliceOrthogonal: true,
  async build({ dataSource, ctx, windowAnchorMs }) {
    const store = createSitemapStore({ dataSource })
    const from = utcDateMinusDays(windowAnchorMs, 28)
    const to = utcDateMinusDays(windowAnchorMs, 0)

    interface DayKey {
      day: string
      feedpath: string
    }
    const counts = new Map<string, { day: string, feedpath: string, added: number, removed: number }>()
    const addedTop: Array<{ loc: string, feedpath: string, at: number }> = []
    const removedTop: Array<{ loc: string, feedpath: string, at: number }> = []

    function key(k: DayKey): string {
      return `${k.day}\x00${k.feedpath}`
    }

    for await (const d of store.loadDeltas(ctx, { from, to })) {
      const day = new Date(d.at).toISOString().slice(0, 10)
      const k = key({ day, feedpath: d.feedpath })
      const cur = counts.get(k) ?? { day, feedpath: d.feedpath, added: 0, removed: 0 }
      if (d.op === 'added') {
        cur.added += 1
        addedTop.push({ loc: d.loc, feedpath: d.feedpath, at: d.at })
      }
      else {
        cur.removed += 1
        removedTop.push({ loc: d.loc, feedpath: d.feedpath, at: d.at })
      }
      counts.set(k, cur)
    }

    const days = Array.from(counts.values()).sort((a, b) => {
      if (a.day !== b.day)
        return a.day < b.day ? -1 : 1
      return a.feedpath < b.feedpath ? -1 : 1
    })
    // Most-recent first, cap at 200.
    addedTop.sort((a, b) => b.at - a.at)
    removedTop.sort((a, b) => b.at - a.at)
    return {
      days,
      topAdded: addedTop.slice(0, 200),
      topRemoved: removedTop.slice(0, 200),
    }
  },
}

/**
 * Aggregate one day's `hourly_pages` partition into the daily `pages` shape
 * and write it to the daily Discover partition. After this runs for date D,
 * the daily query path serves D from `pages/.../daily/D` and the `hourly/D`
 * partition becomes read-only / GC-only.
 *
 * `(position - 1)` weighting matches the storage convention encoded by
 * `toSumPosition`: `sum_position = SUM((position - 1) * impressions)`, so a
 * downstream `SUM(sum_position) / SUM(impressions) + 1` recovers the mean.
 *
 * searchType-scoped: only call with `searchType: 'discover'`. The hourly
 * partition lives under `hourly_pages` and the output lands under `pages` so
 * existing dashboard queries (which read `pages`) see the rolled-up day
 * transparently.
 */
export interface RebuildDailyFromHourlyOptions {
  engine: RollupEngine & {
    writeDay: (scope: TenantCtx & { table: TableTypeName, date: string, searchType?: SearchType }, rows: Row[]) => Promise<void>
  }
  ctx: TenantCtx
  /** PT calendar day to roll up. */
  date: string
  searchType: 'discover'
}

// Local alias to avoid the cross-module type-only import collision.
type TableTypeName = import('@gscdump/contracts').TableName

export async function rebuildDailyFromHourly(opts: RebuildDailyFromHourlyOptions): Promise<{ rowsWritten: number }> {
  const { engine, ctx, date, searchType } = opts
  const result = await engine.runSQL({
    ctx,
    table: 'hourly_pages' as TableTypeName,
    fileSets: { FILES: { table: 'hourly_pages' as TableTypeName, partitions: [`hourly/${date}`] } },
    searchType,
    sql: `
      SELECT
        url,
        DATE '${date}' AS date,
        SUM(clicks)::BIGINT AS clicks,
        SUM(impressions)::BIGINT AS impressions,
        SUM(sum_position)::DOUBLE AS sum_position
      FROM read_parquet({{FILES}}, union_by_name = true)
      WHERE date = '${date}'
      GROUP BY url
    `,
  })
  const rows: Row[] = result.rows.map(r => ({
    url: r.url,
    date,
    clicks: Number(r.clicks),
    impressions: Number(r.impressions),
    sum_position: Number(r.sum_position),
  }))
  await engine.writeDay({
    userId: ctx.userId,
    siteId: ctx.siteId,
    table: 'pages' as TableTypeName,
    date,
    searchType,
  }, rows)
  return { rowsWritten: rows.length }
}

export const DEFAULT_ROLLUPS: readonly RollupDef[] = [
  dailyTotalsRollup,
  weeklyTotalsRollup,
  topPages28dRollup,
  topKeywords28dRollup,
  topCountries28dRollup,
  indexingMetadataRollup,
  indexingHealthRollup,
  indexPercentRollup,
  sitemapHealthRollup,
  sitemapChanges28dRollup,
]

/**
 * Canonical-primary rollups (ADR-0017 / ADR-0018). Opt-in — kept out of
 * `DEFAULT_ROLLUPS` because they only pay off once the consumer queries by
 * `queryCanonical` and wires the read seams (`resolveExtra` /
 * `canonicalSource`). Hosts opt in by concatenating these onto their def list
 * (CLI: `gscdump rollups --with-canonical`).
 */
export const CANONICAL_ROLLUPS: readonly RollupDef[] = [
  queryCanonicalVariantsRollup,
  queryCanonicalDailyRollup,
]

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
import type { DataSource, FileSetRef, Row } from './contracts'
import type { ColumnDef } from './schema'
import { MS_PER_DAY } from 'gscdump'
import { encodeRowsToParquetFlex } from './adapters/hyparquet'
import { createIndexingMetadataStore, createSitemapStore, inspectionParquetKey, sitemapUrlsIndexKey } from './entities'

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
     * Wall-clock millis when the runner started this rollup. Use for
     * derived window cutoffs (e.g. trailing-28d boundary) so the SQL can
     * inline a date literal and stay portable across DuckDB builds that
     * don't bundle the ICU extension (Workers DuckDB, for one — CURRENT_DATE
     * lives in ICU).
     */
    builtAt: number
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
export interface RollupBucket {
  list: (opts: { prefix: string }) => Promise<{ objects: Array<{ key: string }> }>
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
  const listing = await bucket.list({ prefix }).catch(() => null)
  if (!listing)
    return null
  let newest: { ts: number, key: string } | null = null
  for (const obj of listing.objects) {
    const m = ROLLUP_FILE_RE.exec(obj.key.slice(prefix.length))
    if (!m?.groups || m.groups.id !== id)
      continue
    const ts = Number(m.groups.ts)
    if (!newest || ts > newest.ts)
      newest = { ts, key: obj.key }
  }
  if (!newest)
    return null
  const obj = await bucket.get(newest.key).catch(() => null)
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
}

export async function rebuildRollups(
  opts: RebuildRollupsOptions,
): Promise<RebuildRollupResult[]> {
  const now = opts.now ?? (() => Date.now())
  const results: RebuildRollupResult[] = []
  const searchType = opts.searchType
  if (searchType !== undefined) {
    for (const def of opts.defs) {
      if (def.sliceOrthogonal === true) {
        throw new Error(`rollup def '${def.id}' is slice-orthogonal; do not pass searchType`)
      }
    }
  }
  for (const def of opts.defs) {
    const builtAt = now()
    const payload = await def.build({
      engine: opts.engine,
      ctx: opts.ctx,
      dataSource: opts.dataSource,
      builtAt,
      ...(searchType !== undefined ? { searchType } : {}),
    })
    if (def.format === 'parquet') {
      if (!def.parquetColumns || def.parquetColumns.length === 0)
        throw new Error(`rollup '${def.id}' declared format='parquet' without parquetColumns`)
      const rows = (payload ?? []) as readonly Row[]
      const parquetBytes = encodeRowsToParquetFlex(rows, {
        columns: def.parquetColumns,
        sortKey: def.parquetSortKey,
      })
      const parquetKey = rollupParquetKey(opts.ctx, def.id, builtAt, searchType)
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
      const key = rollupKey(opts.ctx, def.id, builtAt, searchType)
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
    const key = rollupKey(opts.ctx, def.id, builtAt, searchType)
    await opts.dataSource.write(key, bytes)
    results.push({ id: def.id, objectKey: key, bytes: bytes.byteLength, builtAt })
  }
  return results
}

// ISO-date `YYYY-MM-DD` that's `days` days before `at` (UTC). Used by rollup
// builders to inline a trailing-window cutoff into SQL instead of relying on
// `CURRENT_DATE`, which lives in the ICU extension and isn't available in
// every DuckDB build (notably Workers DuckDB).
function utcDateMinusDays(at: number, days: number): string {
  const d = new Date(at - days * MS_PER_DAY)
  const y = d.getUTCFullYear()
  const m = String(d.getUTCMonth() + 1).padStart(2, '0')
  const day = String(d.getUTCDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
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
    const pages = await engine.runSQL({
      ctx,
      table: 'pages',
      fileSets: { FILES: { table: 'pages' } },
      sql: `
        SELECT
          date,
          SUM(clicks)::BIGINT AS clicks,
          SUM(impressions)::BIGINT AS impressions,
          SUM(sum_position)::DOUBLE AS sum_position
        FROM read_parquet({{FILES}}, union_by_name = true)
        GROUP BY date
        ORDER BY date
      `,
      ...(searchType !== undefined ? { searchType } : {}),
    })
    const keywords = await engine.runSQL({
      ctx,
      table: 'keywords',
      fileSets: { FILES: { table: 'keywords' } },
      sql: `
        SELECT
          date,
          SUM(impressions)::BIGINT AS impressions
        FROM read_parquet({{FILES}}, union_by_name = true)
        GROUP BY date
      `,
      ...(searchType !== undefined ? { searchType } : {}),
    })
    const keywordImpressionsByDate = new Map<string, bigint>()
    for (const r of keywords.rows)
      keywordImpressionsByDate.set(String(r.date), BigInt(r.impressions as bigint | number))
    return pages.rows.map((r) => {
      const totalImpressions = BigInt(r.impressions as bigint | number)
      const queryImpressions = keywordImpressionsByDate.get(String(r.date)) ?? BigInt(0)
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
    const result = await engine.runSQL({
      ctx,
      table: 'pages',
      fileSets: { FILES: { table: 'pages' } },
      ...(searchType !== undefined ? { searchType } : {}),
      sql: `
        SELECT
          strftime(date_trunc('week', date::DATE), '%Y-%m-%d') AS week,
          SUM(clicks)::BIGINT AS clicks,
          SUM(impressions)::BIGINT AS impressions,
          SUM(sum_position)::DOUBLE AS sum_position
        FROM read_parquet({{FILES}}, union_by_name = true)
        GROUP BY 1
        ORDER BY 1
      `,
    })
    return result.rows.map(r => ({
      week: r.week,
      clicks: Number(r.clicks),
      impressions: Number(r.impressions),
      sum_position: Number(r.sum_position),
    }))
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
  async build({ engine, ctx, builtAt, searchType }) {
    const cutoff = utcDateMinusDays(builtAt, 28)
    const result = await engine.runSQL({
      ctx,
      table: 'pages',
      fileSets: { FILES: { table: 'pages' } },
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
  async build({ engine, ctx, builtAt, searchType }) {
    const cutoff = utcDateMinusDays(builtAt, 28)
    const result = await engine.runSQL({
      ctx,
      table: 'countries',
      fileSets: { FILES: { table: 'countries' } },
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
  async build({ engine, ctx, builtAt, searchType }) {
    const cutoff = utcDateMinusDays(builtAt, 28)
    const result = await engine.runSQL({
      ctx,
      table: 'keywords',
      fileSets: { FILES: { table: 'keywords' } },
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
  async build({ engine, ctx, builtAt, searchType }) {
    const cutoff = utcDateMinusDays(builtAt, 28)
    const result = await engine.runSQL({
      ctx,
      table: 'keywords',
      fileSets: { FILES: { table: 'keywords' } },
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
  async build({ engine, ctx, dataSource, builtAt }) {
    // Skip when the parquet sidecar hasn't been materialized yet. We probe
    // with `head` (cheap; no body) rather than `parquetUri` because we now
    // route the read through `fileSets.keys` so DuckDB pre-fetches bytes —
    // the URI itself is no longer the gate.
    const key = inspectionParquetKey(ctx)
    const exists = await dataSource.head?.(key)
    if (!exists)
      return { days: [] }
    const cutoff = utcDateMinusDays(builtAt, 90)
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
  async build({ engine, ctx, dataSource, builtAt, searchType }) {
    // Probe directly for the urls/index.parquet — `urlsParquetUri` returns
    // a URI even when the file's missing on backends with a synchronous
    // `uri()`. We route reads via `fileSets.keys` so DuckDB pre-fetches
    // bytes; that path is what works under the duckdb-worker bypass.
    const urlsKey = sitemapUrlsIndexKey(ctx)
    const urlsExist = await dataSource.head?.(urlsKey)
    if (!urlsExist)
      return { totalSitemapUrls: 0, days: [] }
    const cutoff = utcDateMinusDays(builtAt, 90)
    // Numerator: per-day distinct sitemap URLs with clicks>0. PAGES goes
    // through the manifest so forward searchType; URLS is a direct-keys
    // sidecar (entity store, not slice-partitioned) so searchType doesn't
    // apply to it.
    const numerator = await engine.runSQL({
      ctx,
      table: 'pages',
      fileSets: {
        PAGES: { table: 'pages' },
        URLS: { table: 'pages', keys: [urlsKey] },
      },
      ...(searchType !== undefined ? { searchType } : {}),
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
      fileSets: { URLS: { table: 'pages', keys: [urlsKey] } },
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
  async build({ dataSource, ctx, builtAt }) {
    const store = createSitemapStore({ dataSource })
    const index = await store.loadIndex(ctx)
    const records = Object.values(index.records)
    const cutoff = utcDateMinusDays(builtAt, 90)

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
  async build({ dataSource, ctx, builtAt }) {
    const store = createSitemapStore({ dataSource })
    const from = utcDateMinusDays(builtAt, 28)
    const to = utcDateMinusDays(builtAt, 0)

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

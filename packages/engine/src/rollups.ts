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

import type { TenantCtx } from 'gscdump/contracts'
import type { DataSource, Row } from './contracts'
import type { ColumnDef } from './schema'
import { MS_PER_DAY } from 'gscdump'
import { encodeRowsToParquetFlex } from './adapters/hyparquet'
import { createIndexingMetadataStore } from './entities'

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
    fileSets: Record<string, { table: import('@gscdump/engine/contracts').TableName, partitions?: string[] }>
    table?: import('@gscdump/engine/contracts').TableName
    sql: string
    params?: unknown[]
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

function rollupPrefix(ctx: TenantCtx): string {
  return ctx.siteId
    ? `u_${ctx.userId}/${ctx.siteId}/rollups`
    : `u_${ctx.userId}/rollups`
}

export function rollupKey(ctx: TenantCtx, id: string, builtAt: number): string {
  return `${rollupPrefix(ctx)}/${id}__v${builtAt}.json`
}

export function rollupParquetKey(ctx: TenantCtx, id: string, builtAt: number): string {
  return `${rollupPrefix(ctx)}/${id}__v${builtAt}.parquet`
}

export interface RebuildRollupsOptions {
  engine: RollupEngine
  dataSource: DataSource
  ctx: TenantCtx
  defs: readonly RollupDef[]
  now?: () => number
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
  for (const def of opts.defs) {
    const builtAt = now()
    const payload = await def.build({
      engine: opts.engine,
      ctx: opts.ctx,
      dataSource: opts.dataSource,
      builtAt,
    })
    if (def.format === 'parquet') {
      if (!def.parquetColumns || def.parquetColumns.length === 0)
        throw new Error(`rollup '${def.id}' declared format='parquet' without parquetColumns`)
      const rows = (payload ?? []) as readonly Row[]
      const parquetBytes = encodeRowsToParquetFlex(rows, {
        columns: def.parquetColumns,
        sortKey: def.parquetSortKey,
      })
      const parquetKey = rollupParquetKey(opts.ctx, def.id, builtAt)
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
      const key = rollupKey(opts.ctx, def.id, builtAt)
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
    const key = rollupKey(opts.ctx, def.id, builtAt)
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
  async build({ engine, ctx }) {
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
  async build({ engine, ctx }) {
    const result = await engine.runSQL({
      ctx,
      table: 'pages',
      fileSets: { FILES: { table: 'pages' } },
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
  async build({ engine, ctx, builtAt }) {
    const cutoff = utcDateMinusDays(builtAt, 28)
    const result = await engine.runSQL({
      ctx,
      table: 'pages',
      fileSets: { FILES: { table: 'pages' } },
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
  async build({ engine, ctx, builtAt }) {
    const cutoff = utcDateMinusDays(builtAt, 28)
    const result = await engine.runSQL({
      ctx,
      table: 'countries',
      fileSets: { FILES: { table: 'countries' } },
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
  async build({ engine, ctx, builtAt }) {
    const cutoff = utcDateMinusDays(builtAt, 28)
    const result = await engine.runSQL({
      ctx,
      table: 'keywords',
      fileSets: { FILES: { table: 'keywords' } },
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
  async build({ engine, ctx, builtAt }) {
    const cutoff = utcDateMinusDays(builtAt, 28)
    const result = await engine.runSQL({
      ctx,
      table: 'keywords',
      fileSets: { FILES: { table: 'keywords' } },
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

export const DEFAULT_ROLLUPS: readonly RollupDef[] = [
  dailyTotalsRollup,
  weeklyTotalsRollup,
  topPages28dRollup,
  topKeywords28dRollup,
  topCountries28dRollup,
  indexingMetadataRollup,
]

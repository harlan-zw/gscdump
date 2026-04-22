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
import type { DataSource } from './storage'
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
    fileSets: Record<string, { table: import('./storage').TableName, partitions?: string[] }>
    table?: import('./storage').TableName
    sql: string
    params?: unknown[]
  }) => Promise<{ rows: import('./storage').Row[] }>
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

/** Wire shape persisted to R2/disk. Readers can rely on the `version` + `builtAt`. */
export interface RollupEnvelope<T = unknown> {
  version: 1
  id: string
  builtAt: number
  windowDays: number | null
  payload: T
}

export function rollupKey(ctx: TenantCtx, id: string, builtAt: number): string {
  const prefix = ctx.siteId
    ? `u_${ctx.userId}/${ctx.siteId}/rollups`
    : `u_${ctx.userId}/rollups`
  return `${prefix}/${id}__v${builtAt}.json`
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
  objectKey: string
  bytes: number
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
  const d = new Date(at - days * 86_400_000)
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
  indexingMetadataRollup,
]

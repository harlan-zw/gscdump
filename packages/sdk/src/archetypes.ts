/**
 * CONTRACT — the 10 GSC query archetypes as a typed surface (Wave-2, frozen).
 *
 * Every consumer query (the `pro-gsc` layer, the analyzer composable, the
 * server tail) is one of these 10 shapes. Each archetype is tagged with its
 * EXECUTION CLASS — whether the server tail can answer it in R2 SQL, or needs
 * DuckDB-over-Iceberg-files (window functions). The Iceberg fact tables are
 * the final five: `pages`, `queries`, `countries`, `page_queries`, `dates`.
 *
 * POC findings 2026-05-22 (Spike 4): R2 SQL has GROUP BY + aggregates but NO
 * window functions, NO JOINs, NO `FROM` subqueries, `COUNT(*)` only,
 * restricted `ORDER BY`. 8/10 archetypes are R2-SQL-expressible (some only in
 * a pre-resolved form); archetype 9 needs DuckDB; archetype 10 is not an
 * Iceberg query at all.
 *
 * Inputs build on the existing `BuilderState` from `gscdump/query` — they do
 * NOT reinvent the query model. An archetype query is `{ archetype, builder,
 * ...archetype-specific shaping }`.
 *
 * TYPES ONLY — no query construction or execution logic.
 */

import type { BuilderState, Dimension, Metric, SearchType } from 'gscdump/query'

/** The archetype identifiers. */
export type QueryArchetype
  = | 'site-daily-timeseries' // 1
    | 'entity-daily-timeseries' // 2
    | 'entity-daily-sparkline' // 3
    | 'top-n-breakdown' // 4
    | 'single-row-lookup' // 5
    | 'multi-series-stacked-daily' // 6
    | 'two-dimension-detail' // 8
    | 'arbitrary-sql' // 9
    | 'aux-cloud-only' // 10

/**
 * Where an archetype can run.
 * - `r2-sql`     — expressible in R2 SQL directly (plain GROUP BY + aggregate).
 * - `r2-sql-resolved` — R2-SQL-expressible only AFTER the resolver pre-resolves
 *                  entity selections to a literal `IN` list (no `FROM`
 *                  subquery in R2 SQL). Archetypes 2, 3, 4.
 * - `duckdb`     — needs window functions / `QUALIFY` / `COUNT(DISTINCT)` /
 *                  `OFFSET`; server tail must use DuckDB-over-Iceberg-files.
 * - `cloud-only` — not an Iceberg query (aux data: canonicals, sitemaps,
 *                  indexing). Always served by the existing cloud endpoints.
 */
export type ArchetypeExecutionClass = 'r2-sql' | 'r2-sql-resolved' | 'duckdb' | 'cloud-only'

/** Static execution-class tag per archetype. The server-tail router reads this. */
export const ARCHETYPE_EXECUTION_CLASS: Record<QueryArchetype, ArchetypeExecutionClass> = {
  'site-daily-timeseries': 'r2-sql',
  'entity-daily-timeseries': 'r2-sql-resolved',
  'entity-daily-sparkline': 'r2-sql-resolved',
  'top-n-breakdown': 'r2-sql-resolved',
  'single-row-lookup': 'r2-sql',
  'multi-series-stacked-daily': 'r2-sql',
  'two-dimension-detail': 'r2-sql',
  'arbitrary-sql': 'duckdb',
  'aux-cloud-only': 'cloud-only',
}

/** Date window every archetype query is scoped to. */
export interface DateRange {
  /** `YYYY-MM-DD` inclusive. */
  start: string
  /** `YYYY-MM-DD` inclusive. */
  end: string
}

/**
 * A post-window predicate layered onto an archetype's `WHERE` clause, on top of
 * the site/searchType/date partition. The cross-cutting facet mechanism behind
 * the dashboard's Country/Device/Brand filters:
 * - `eq`       — exact column match (e.g. `country = 'ind'`, `device = 'MOBILE'`).
 * - `regex`    — case-insensitive regex on a text column, e.g. brand
 *                classification on `query`. DuckDB `regexp_matches(LOWER(col), …)`.
 * - `notRegex` — its negation (non-brand traffic).
 *
 * `regex`/`notRegex` require DuckDB execution — R2 SQL has no regex — so the
 * router escalates any query carrying one to the `duckdb` class.
 */
export interface ArchetypeFacet {
  column: Dimension
  op: 'eq' | 'regex' | 'notRegex'
  value: string
}

/** Fields common to every archetype query input. */
export interface ArchetypeQueryBase {
  archetype: QueryArchetype
  siteId: string
  searchType: SearchType
  range: DateRange
  /**
   * Optional prior window for YoY / period-over-period comparison. Widest
   * supported total span is ~24 months (12-month period + YoY).
   */
  compareRange?: DateRange
  /**
   * Cross-cutting Country/Device/Brand filters applied as extra `WHERE`
   * predicates. Applied by `top-n-breakdown` and the daily-timeseries
   * archetypes; ignored by fully-specified shapes (`single-row-lookup`).
   */
  facets?: readonly ArchetypeFacet[]
}

// ── 1. Site-level daily timeseries ──────────────────────────────────────────
/**
 * Whole-site metrics grouped by date. Reads `dates`, the authoritative daily
 * total table (site totals + anonymized impressions + device pivot).
 * R2 SQL: `GROUP BY date`.
 */
export interface SiteDailyTimeseriesQuery extends ArchetypeQueryBase {
  archetype: 'site-daily-timeseries'
  metrics: readonly Metric[]
}

// ── 2. Per-entity daily timeseries ──────────────────────────────────────────
/**
 * Daily metrics for ONE resolved entity (a page or query). The resolver must
 * resolve `entity.value` to a literal before hitting R2 SQL.
 */
export interface EntityDailyTimeseriesQuery extends ArchetypeQueryBase {
  archetype: 'entity-daily-timeseries'
  entity: { dimension: Extract<Dimension, 'page' | 'query'>, value: string }
  metrics: readonly Metric[]
}

// ── 3. Per-entity daily sparkline ────────────────────────────────────────────
/**
 * Compact daily series for the top-N entities at once (sparkline column in a
 * table). Resolver pre-resolves the top-N entity list to a literal `IN`.
 */
export interface EntityDailySparklineQuery extends ArchetypeQueryBase {
  archetype: 'entity-daily-sparkline'
  dimension: Extract<Dimension, 'page' | 'query'>
  /** Entity values already resolved by the resolver layer. */
  entities: readonly string[]
  /** Single metric the sparkline plots. */
  metric: Metric
}

// ── 4. Top-N breakdown table ─────────────────────────────────────────────────
/**
 * Ranked breakdown over one dimension. `GROUP BY` + `ORDER BY` + `LIMIT`.
 * Device breakdowns read the wide `dates` table and unpivot its device columns
 * (`clicks_desktop`, `impressions_mobile`, etc.) at query time.
 * `offset` pagination is UNVERIFIED in R2 SQL (POC) — when set, the router
 * may escalate to `duckdb`.
 */
export interface TopNBreakdownQuery extends ArchetypeQueryBase {
  archetype: 'top-n-breakdown'
  dimension: Dimension
  metrics: readonly Metric[]
  /** Sort column + direction. */
  orderBy: { metric: Metric, dir: 'asc' | 'desc' }
  limit: number
  /** Pagination offset. Non-zero may force `duckdb` execution. */
  offset?: number
}

// ── 5. Single-row lookup ─────────────────────────────────────────────────────
/** One aggregated row for a fully-specified filter. `WHERE` + `GROUP BY`. */
export interface SingleRowLookupQuery extends ArchetypeQueryBase {
  archetype: 'single-row-lookup'
  /** Exact dimension-value filters identifying the row. */
  match: Partial<Record<Dimension, string>>
  metrics: readonly Metric[]
}

// ── 6. Multi-series stacked daily ────────────────────────────────────────────
/**
 * Daily metrics split by a secondary dimension. `GROUP BY date, <dim>`.
 * Device split charts read `dates` and unpivot the wide device columns.
 */
export interface MultiSeriesStackedDailyQuery extends ArchetypeQueryBase {
  archetype: 'multi-series-stacked-daily'
  /** The series dimension, e.g. `device` or `country`. */
  seriesDimension: Dimension
  metric: Metric
}

// ── 7. (retired) Preset analyzer ─────────────────────────────────────────────
// The `preset-analyzer` archetype was a striking-distance stub that ignored
// `presetId` and dropped analyzer `meta`. Analysis presets now run through the
// analyzer registry directly (`analyze({ type })`). See ADR-0044.

// ── 8. Two-dimension (page × query) detail ───────────────────────────────────
/**
 * The whale archetype — `page_queries` grouped by `(url, query)`. The query ×
 * page cross no longer reads the retired `page_keywords` table name. This is
 * the reason the server tail exists. R2-SQL-expressible
 * (`GROUP BY url, query`).
 */
export interface TwoDimensionDetailQuery extends ArchetypeQueryBase {
  archetype: 'two-dimension-detail'
  metrics: readonly Metric[]
  /** Optional page or query prefilter to narrow the cross. */
  filter?: { page?: string, query?: string }
  orderBy?: { metric: Metric, dir: 'asc' | 'desc' }
  limit?: number
}

// ── 9. Arbitrary SQL ─────────────────────────────────────────────────────────
/**
 * Escape hatch — caller-supplied SQL (moving averages, ranks, window
 * functions). ALWAYS `duckdb` on the server tail; R2 SQL cannot express it.
 * In the browser, runs against the attached DuckDB-WASM views directly.
 */
export interface ArbitrarySqlQuery extends ArchetypeQueryBase {
  archetype: 'arbitrary-sql'
  /** SQL referencing the attached table views by their `IcebergTableName`. */
  sql: string
  params?: readonly unknown[]
}

// ── 10. Aux cloud-only ───────────────────────────────────────────────────────
/**
 * Non-fact-table data: canonicals, sitemaps, indexing status. Not an Iceberg
 * query — served by the existing cloud endpoints. Present in the union so the
 * archetype router can recognise and route it without a special case.
 */
export interface AuxCloudOnlyQuery {
  archetype: 'aux-cloud-only'
  siteId: string
  /** Which aux dataset. */
  dataset: 'canonicals' | 'sitemaps' | 'indexing'
  params?: Record<string, unknown>
}

/** Discriminated union of every archetype query input. */
export type ArchetypeQuery
  = | SiteDailyTimeseriesQuery
    | EntityDailyTimeseriesQuery
    | EntityDailySparklineQuery
    | TopNBreakdownQuery
    | SingleRowLookupQuery
    | MultiSeriesStackedDailyQuery
    | TwoDimensionDetailQuery
    | ArbitrarySqlQuery
    | AuxCloudOnlyQuery

/** A single result row — dimension values plus metric values, all flat. */
export type ArchetypeResultRow = Record<string, string | number | null>

/** Where the result was actually computed (for diagnostics + UX). */
export type ArchetypeResultSource = 'browser' | 'server-r2-sql' | 'server-duckdb' | 'cloud'

/** Uniform result envelope returned for any archetype. */
export interface ArchetypeResult<R extends ArchetypeResultRow = ArchetypeResultRow> {
  archetype: QueryArchetype
  rows: R[]
  source: ArchetypeResultSource
  meta?: {
    rowCount: number
    queryMs: number
    /** Set when `compareRange` was supplied — the comparison-period rows. */
    compareRows?: R[]
    truncated?: boolean
  }
}

/**
 * Bridge: an archetype query also carries (or resolves to) a `BuilderState`,
 * so the existing query-resolver / `buildLogicalPlan` path stays the executor.
 * The resolver layer attaches this. Implementation agents: DO NOT bypass
 * `BuilderState` — the archetype is the typed front door, `BuilderState` the
 * shared backend.
 */
export interface ResolvedArchetypeQuery {
  query: ArchetypeQuery
  /** Undefined only for `aux-cloud-only`, which has no `BuilderState`. */
  builder?: BuilderState
  executionClass: ArchetypeExecutionClass
}

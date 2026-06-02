// Archetype → SQL translation, shared by the R2 SQL client and the DuckDB
// executor.
//
// Both server-tail engines run the SAME logical query against the SAME 5
// Iceberg fact tables; only the dialect and table-reference syntax differ.
// This module produces a dialect-neutral `ArchetypeSqlPlan` — a SQL string
// with `{{TABLE}}` standing in for the table reference, plus the param list —
// and each engine substitutes its own table reference.
//
// SQL shape rules, derived from the locked contracts + POC Spike 4:
//  - Stored metric columns are `clicks`, `impressions`, `sum_position` only.
//    `ctr` and `position` are DERIVED at read time:
//      ctr      = SUM(clicks) / NULLIF(SUM(impressions), 0)
//      position = SUM(sum_position) / NULLIF(SUM(impressions), 0)
//  - Dimension → column: `page`→`url`, `queryCanonical`→`query_canonical`,
//    everything else identity (`query`, `country`, `device`, `date`).
//  - Every query is scoped by the three partition columns: `site_id`,
//    `search_type`, and a `date` BETWEEN range — this is what prunes the
//    Iceberg partitions.
//  - R2 SQL has no window functions / no `FROM` subqueries; the
//    `r2-sql-resolved` archetypes (2,3,4) carry their entities pre-resolved as
//    a literal `IN` list, which this builder emits inline (string-escaped).
//  - `arbitrary-sql` (archetype 9) is NOT translated here — its SQL is
//    caller-supplied and runs verbatim on DuckDB.

import type { IcebergTableName } from '@gscdump/engine/iceberg'
import type {
  ArchetypeFacet,
  ArchetypeQuery,
  EntityDailySparklineQuery,
  EntityDailyTimeseriesQuery,
  MultiSeriesStackedDailyQuery,
  SingleRowLookupQuery,
  SiteDailyTimeseriesQuery,
  TopNBreakdownQuery,
  TwoDimensionDetailQuery,
} from '@gscdump/sdk'
import type { Dimension, Metric } from 'gscdump/query'
import { inferTable } from '@gscdump/engine'

/** Placeholder substituted for the engine-specific table reference. */
export const TABLE_PLACEHOLDER = '{{TABLE}}'

/** A dialect-neutral SQL plan. */
export interface ArchetypeSqlPlan {
  /** SQL with `{{TABLE}}` standing in for the table reference. */
  sql: string
  /** Bound parameters, in `?`-order. */
  params: unknown[]
  /** The Iceberg fact table this query reads. */
  table: IcebergTableName
}

/** SQL identifier for a builder `Dimension`. */
function dimColumn(dim: Dimension): string {
  if (dim === 'page')
    return 'url'
  if (dim === 'queryCanonical')
    return 'query_canonical'
  return dim
}

/**
 * Metric → aggregate SQL expression. `ctr` / `position` are not stored; they
 * are computed from the stored sums. Aliased to the metric name so result
 * rows are uniform regardless of engine.
 */
function metricExpr(metric: Metric): string {
  switch (metric) {
    case 'clicks':
      return 'SUM(clicks) AS clicks'
    case 'impressions':
      return 'SUM(impressions) AS impressions'
    case 'ctr':
      return 'SUM(clicks) / NULLIF(SUM(impressions), 0) AS ctr'
    case 'position':
      return 'SUM(sum_position) / NULLIF(SUM(impressions), 0) AS position'
  }
}

const DEVICE_SUFFIXES = ['desktop', 'mobile', 'tablet'] as const

function metricExprForSource(metric: Metric, source: {
  clicks: string
  impressions: string
  sumPosition: string
}): string {
  switch (metric) {
    case 'clicks':
      return `SUM(${source.clicks}) AS clicks`
    case 'impressions':
      return `SUM(${source.impressions}) AS impressions`
    case 'ctr':
      return `SUM(${source.clicks}) / NULLIF(SUM(${source.impressions}), 0) AS ctr`
    case 'position':
      return `SUM(${source.sumPosition}) / NULLIF(SUM(${source.impressions}), 0) AS position`
  }
}

function deviceSource(suffix: typeof DEVICE_SUFFIXES[number]): {
  clicks: string
  impressions: string
  sumPosition: string
} {
  return {
    clicks: `clicks_${suffix}`,
    impressions: `impressions_${suffix}`,
    sumPosition: `sum_position_${suffix}`,
  }
}

/**
 * Escape a string for an inline SQL literal. Used only for the pre-resolved
 * entity `IN` lists of the `r2-sql-resolved` archetypes — R2 SQL cannot bind
 * a variable-length `IN`, and these values originate from our own resolver,
 * not raw user input. Standard SQL single-quote doubling.
 */
function sqlStringLiteral(value: string): string {
  return `'${value.replace(/'/g, '\'\'')}'`
}

/** The mandatory partition-pruning WHERE prefix. Always 4 bound params. */
function partitionWhere(q: { siteId: string, searchType: string, range: { start: string, end: string } }): {
  clause: string
  params: unknown[]
} {
  return {
    clause: 'site_id = ? AND search_type = ? AND date BETWEEN ? AND ?',
    params: [q.siteId, q.searchType, q.range.start, q.range.end],
  }
}

/**
 * Cross-cutting facet predicates (Country/Device/Brand), mirroring the browser
 * builder's `facetPredicate` (`@gscdump/engine-duckdb-wasm`) so server-tail and
 * browser-DuckDB emit byte-identical filtered SQL. `eq` → `col = ?`;
 * `regex`/`notRegex` → `regexp_matches(LOWER(col), ?)` (brand classification on
 * `query`). Returns a leading ` AND …` fragment appended after the partition
 * predicate. SAFE on the shared builder: a `regex`/`notRegex` facet forces the
 * dispatcher to route the query to the DuckDB engine (R2 SQL has no regex), so
 * the R2 SQL client never receives the `regexp_matches` SQL this emits.
 */
function facetPredicate(query: ArchetypeQuery): { sql: string, params: unknown[] } {
  const facets = (query as { facets?: readonly ArchetypeFacet[] }).facets
  if (!facets?.length)
    return { sql: '', params: [] }
  const parts: string[] = []
  const params: unknown[] = []
  for (const f of facets) {
    const col = dimColumn(f.column)
    switch (f.op) {
      case 'eq':
        parts.push(`${col} = ?`)
        params.push(f.value)
        break
      case 'regex':
        parts.push(`regexp_matches(LOWER(${col}), ?)`)
        params.push(f.value)
        break
      case 'notRegex':
        parts.push(`NOT regexp_matches(LOWER(${col}), ?)`)
        params.push(f.value)
        break
      default:
        throw new Error(`[archetype-sql] unknown facet op: ${(f as { op: string }).op}`)
    }
  }
  return { sql: parts.length ? ` AND ${parts.join(' AND ')}` : '', params }
}

// ── per-archetype builders ───────────────────────────────────────────────────

function buildSiteDailyTimeseries(q: SiteDailyTimeseriesQuery): ArchetypeSqlPlan {
  const w = partitionWhere(q)
  const metrics = q.metrics.map(metricExpr).join(', ')
  // `dates` carries true site totals (incl. anonymized impressions) keyed by
  // (site, search_type, date) — the authoritative timeseries source.
  return {
    table: 'dates',
    params: w.params,
    sql: `SELECT date, ${metrics} FROM ${TABLE_PLACEHOLDER} WHERE ${w.clause} GROUP BY date ORDER BY date ASC`,
  }
}

function buildEntityDailyTimeseries(q: EntityDailyTimeseriesQuery): ArchetypeSqlPlan {
  const table = inferTable([q.entity.dimension]) as IcebergTableName
  const w = partitionWhere(q)
  const col = dimColumn(q.entity.dimension)
  const metrics = q.metrics.map(metricExpr).join(', ')
  return {
    table,
    params: [...w.params, q.entity.value],
    sql: `SELECT date, ${metrics} FROM ${TABLE_PLACEHOLDER} WHERE ${w.clause} AND ${col} = ? GROUP BY date ORDER BY date ASC`,
  }
}

function buildEntityDailySparkline(q: EntityDailySparklineQuery): ArchetypeSqlPlan {
  const table = inferTable([q.dimension]) as IcebergTableName
  const w = partitionWhere(q)
  const col = dimColumn(q.dimension)
  // Entities are pre-resolved by the resolver layer to a literal IN list —
  // R2 SQL cannot bind a variable-length IN, so they are inlined (escaped).
  if (q.entities.length === 0)
    throw new Error('entity-daily-sparkline: empty entities — resolver must pre-resolve the top-N list')
  const inList = q.entities.map(sqlStringLiteral).join(', ')
  return {
    table,
    params: w.params,
    sql: `SELECT date, ${col}, ${metricExpr(q.metric)} FROM ${TABLE_PLACEHOLDER} `
      + `WHERE ${w.clause} AND ${col} IN (${inList}) GROUP BY date, ${col} ORDER BY date ASC`,
  }
}

function buildTopNBreakdown(q: TopNBreakdownQuery): ArchetypeSqlPlan {
  const table = inferTable([q.dimension]) as IcebergTableName
  const w = partitionWhere(q)
  if (q.dimension === 'device') {
    const metricList = q.metrics.includes(q.orderBy.metric)
      ? q.metrics
      : [...q.metrics, q.orderBy.metric]
    const order = `${q.orderBy.metric} ${q.orderBy.dir.toUpperCase()}`
    const selects = DEVICE_SUFFIXES.map((suffix) => {
      const source = deviceSource(suffix)
      const metrics = metricList.map(m => metricExprForSource(m, source)).join(', ')
      return `SELECT '${suffix.toUpperCase()}' AS device, ${metrics} FROM ${TABLE_PLACEHOLDER} WHERE ${w.clause}`
    })
    let sql = `${selects.join(' UNION ALL ')} ORDER BY ${order} LIMIT ${Math.max(0, Math.floor(q.limit))}`
    if (q.offset && q.offset > 0)
      sql += ` OFFSET ${Math.floor(q.offset)}`
    return {
      table,
      params: DEVICE_SUFFIXES.flatMap(() => w.params),
      sql,
    }
  }
  const col = dimColumn(q.dimension)
  // Select the order metric too (when not already requested) and ORDER BY its
  // alias — recomputing the aggregate in ORDER BY makes DataFusion (R2 SQL) emit
  // a duplicate unqualified field name and reject the query (40004). Mirrors the
  // device branch above + the browser builder (engine-duckdb-wasm).
  const metricList = q.metrics.includes(q.orderBy.metric) ? q.metrics : [...q.metrics, q.orderBy.metric]
  const metrics = metricList.map(metricExpr).join(', ')
  const order = `${q.orderBy.metric} ${q.orderBy.dir.toUpperCase()}`
  const facet = facetPredicate(q)
  let sql = `SELECT ${col}, ${metrics} FROM ${TABLE_PLACEHOLDER} WHERE ${w.clause}${facet.sql} `
    + `GROUP BY ${col} ORDER BY ${order} LIMIT ${Math.max(0, Math.floor(q.limit))}`
  if (q.offset && q.offset > 0)
    sql += ` OFFSET ${Math.floor(q.offset)}`
  return { table, params: [...w.params, ...facet.params], sql }
}

function buildSingleRowLookup(q: SingleRowLookupQuery): ArchetypeSqlPlan {
  const dims = Object.keys(q.match) as Dimension[]
  const table = inferTable(dims) as IcebergTableName
  const w = partitionWhere(q)
  const params = [...w.params]
  let clause = w.clause
  for (const dim of dims) {
    clause += ` AND ${dimColumn(dim)} = ?`
    params.push(q.match[dim])
  }
  const metrics = q.metrics.map(metricExpr).join(', ')
  // GROUP BY the matched dimensions so the engines agree on shape; with a full
  // match this collapses to one row.
  const groupBy = dims.length > 0 ? ` GROUP BY ${dims.map(dimColumn).join(', ')}` : ''
  const select = dims.length > 0 ? `${dims.map(dimColumn).join(', ')}, ${metrics}` : metrics
  return {
    table,
    params,
    sql: `SELECT ${select} FROM ${TABLE_PLACEHOLDER} WHERE ${clause}${groupBy}`,
  }
}

function buildMultiSeriesStackedDaily(q: MultiSeriesStackedDailyQuery): ArchetypeSqlPlan {
  const table = inferTable([q.seriesDimension]) as IcebergTableName
  const w = partitionWhere(q)
  if (q.seriesDimension === 'device') {
    const selects = DEVICE_SUFFIXES.map((suffix) => {
      const source = deviceSource(suffix)
      return `SELECT date, '${suffix.toUpperCase()}' AS device, ${metricExprForSource(q.metric, source)} `
        + `FROM ${TABLE_PLACEHOLDER} WHERE ${w.clause} GROUP BY date`
    })
    return {
      table,
      params: DEVICE_SUFFIXES.flatMap(() => w.params),
      sql: `${selects.join(' UNION ALL ')} ORDER BY date ASC, device ASC`,
    }
  }
  const col = dimColumn(q.seriesDimension)
  return {
    table,
    params: w.params,
    sql: `SELECT date, ${col}, ${metricExpr(q.metric)} FROM ${TABLE_PLACEHOLDER} `
      + `WHERE ${w.clause} GROUP BY date, ${col} ORDER BY date ASC`,
  }
}

function buildTwoDimensionDetail(q: TwoDimensionDetailQuery): ArchetypeSqlPlan {
  const w = partitionWhere(q)
  const params = [...w.params]
  let clause = w.clause
  if (q.filter?.page) {
    clause += ` AND url = ?`
    params.push(q.filter.page)
  }
  if (q.filter?.query) {
    clause += ` AND query = ?`
    params.push(q.filter.query)
  }
  const facet = facetPredicate(q)
  clause += facet.sql
  params.push(...facet.params)
  // ORDER BY the selected metric alias (not a recomputed aggregate) for R2 SQL /
  // DataFusion compatibility — see buildTopNBreakdown. Ensure it's selected.
  const metricList = q.orderBy && !q.metrics.includes(q.orderBy.metric)
    ? [...q.metrics, q.orderBy.metric]
    : q.metrics
  const metrics = metricList.map(metricExpr).join(', ')
  let sql = `SELECT url, query, ${metrics} FROM ${TABLE_PLACEHOLDER} WHERE ${clause} GROUP BY url, query`
  if (q.orderBy)
    sql += ` ORDER BY ${q.orderBy.metric} ${q.orderBy.dir.toUpperCase()}`
  if (q.limit && q.limit > 0)
    sql += ` LIMIT ${Math.floor(q.limit)}`
  return { table: 'page_queries', params, sql }
}

/**
 * Translate an archetype query to a dialect-neutral SQL plan.
 *
 * Throws for `arbitrary-sql` (caller-supplied SQL, handled by the DuckDB
 * executor directly) and `aux-cloud-only` (not an Iceberg query).
 */
export function buildArchetypeSql(query: ArchetypeQuery): ArchetypeSqlPlan {
  switch (query.archetype) {
    case 'site-daily-timeseries':
      return buildSiteDailyTimeseries(query)
    case 'entity-daily-timeseries':
      return buildEntityDailyTimeseries(query)
    case 'entity-daily-sparkline':
      return buildEntityDailySparkline(query)
    case 'top-n-breakdown':
      return buildTopNBreakdown(query)
    case 'single-row-lookup':
      return buildSingleRowLookup(query)
    case 'multi-series-stacked-daily':
      return buildMultiSeriesStackedDaily(query)
    case 'two-dimension-detail':
      return buildTwoDimensionDetail(query)
    case 'arbitrary-sql':
      throw new Error('buildArchetypeSql: arbitrary-sql carries caller SQL — the DuckDB executor runs it verbatim')
    case 'aux-cloud-only':
      throw new Error('buildArchetypeSql: aux-cloud-only is not an Iceberg query')
  }
}

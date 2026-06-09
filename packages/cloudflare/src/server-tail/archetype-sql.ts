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

/** The four standard metrics emitted as previous-period columns when comparing. */
const STD_METRICS = ['clicks', 'impressions', 'ctr', 'position'] as const

/** `COALESCE(<src>.<metric>, 0) AS <alias>`, casting count metrics to DOUBLE. */
function coalesceMetric(metric: string, src: string, alias: string): string {
  const ref = `${src}.${metric}`
  return (metric === 'clicks' || metric === 'impressions')
    ? `CAST(COALESCE(${ref}, 0) AS DOUBLE) AS ${alias}`
    : `COALESCE(${ref}, 0) AS ${alias}`
}

/** `prev<Metric>` alias for a comparison column. */
function prevAlias(metric: string): string {
  return `prev${metric.charAt(0).toUpperCase()}${metric.slice(1)}`
}

/**
 * Movers re-ranking over the joined current (`c`) / previous (`p`) CTEs.
 * Mirrors the browser builder (`@gscdump/engine-duckdb-wasm`) byte-for-byte so
 * both engines agree. `improving`/`declining` rank by click delta; `new`/`lost`
 * filter on impressions appearing / disappearing.
 */
function moverClause(movers: string): { where: string, order: string } {
  const curClicks = 'COALESCE(c.clicks, 0)'
  const prevClicks = 'COALESCE(p.clicks, 0)'
  const curImpr = 'COALESCE(c.impressions, 0)'
  const prevImpr = 'COALESCE(p.impressions, 0)'
  switch (movers) {
    case 'improving':
      return { where: `${curClicks} > ${prevClicks}`, order: `(${curClicks} - ${prevClicks}) DESC` }
    case 'declining':
      return { where: `${curClicks} < ${prevClicks}`, order: `(${curClicks} - ${prevClicks}) ASC` }
    case 'new':
      return { where: `${prevImpr} = 0 AND ${curImpr} > 0`, order: `${curClicks} DESC, ${curImpr} DESC` }
    case 'lost':
      return { where: `${curImpr} = 0 AND ${prevImpr} > 0`, order: `${prevImpr} DESC` }
    default:
      throw new Error(`[archetype-sql] unknown movers mode: ${movers}`)
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
  const order = `${q.orderBy.metric} ${q.orderBy.dir.toUpperCase()}`
  const limit = `LIMIT ${Math.max(0, Math.floor(q.limit))}`
  const offset = q.offset && q.offset > 0 ? ` OFFSET ${Math.floor(q.offset)}` : ''
  const metricList = q.metrics.includes(q.orderBy.metric) ? q.metrics : [...q.metrics, q.orderBy.metric]
  // `queryCanonical` rows surface the count of distinct raw queries collapsed
  // under one canonical (the `{N}v` badge). Routed to DuckDB by the dispatcher.
  const variantSel = q.dimension === 'queryCanonical' ? ', COUNT(DISTINCT query) AS variantCount' : ''

  if (q.dimension === 'device') {
    if (q.compareRange) {
      // Join each device's previous-period totals so rows carry `prev*`.
      const wPrev = partitionWhere({ ...q, range: q.compareRange })
      const deviceSelects = (clause: string, ml: readonly string[]) => DEVICE_SUFFIXES.map((suffix) => {
        const source = deviceSource(suffix)
        const metrics = ml.map(m => metricExprForSource(m as Metric, source)).join(', ')
        return `SELECT '${suffix.toUpperCase()}' AS device, ${metrics} FROM ${TABLE_PLACEHOLDER} WHERE ${clause}`
      }).join(' UNION ALL ')
      const curCols = metricList.map(m => coalesceMetric(m, 'c', m)).join(', ')
      const prevCols = STD_METRICS.map(m => coalesceMetric(m, 'p', prevAlias(m))).join(', ')
      const sql = `WITH cur AS (${deviceSelects(w.clause, metricList)}), prev AS (${deviceSelects(wPrev.clause, STD_METRICS)}) `
        + `SELECT COALESCE(c.device, p.device) AS device, ${curCols}, ${prevCols} `
        + `FROM cur c FULL OUTER JOIN prev p ON c.device = p.device ORDER BY ${order} ${limit}${offset}`
      return {
        table,
        params: [...DEVICE_SUFFIXES.flatMap(() => w.params), ...DEVICE_SUFFIXES.flatMap(() => wPrev.params)],
        sql,
      }
    }
    const selects = DEVICE_SUFFIXES.map((suffix) => {
      const source = deviceSource(suffix)
      const metrics = metricList.map(m => metricExprForSource(m, source)).join(', ')
      return `SELECT '${suffix.toUpperCase()}' AS device, ${metrics} FROM ${TABLE_PLACEHOLDER} WHERE ${w.clause}`
    })
    const sql = `${selects.join(' UNION ALL ')} ORDER BY ${order} ${limit}${offset}`
    return { table, params: DEVICE_SUFFIXES.flatMap(() => w.params), sql }
  }
  const col = dimColumn(q.dimension)
  const facet = facetPredicate(q)
  // Full group count for load-more tables. `COUNT(*) OVER()` is a window
  // function, so a query reaching this column has already been escalated to the
  // DuckDB executor by the dispatcher (R2 SQL cannot run it).
  const totalCol = q.includeTotal ? ', COUNT(*) OVER() AS __total' : ''

  if (q.compareRange) {
    // Current + previous grouped CTEs joined per dimension key so every current
    // row carries its TRUE previous-period metrics (`prev*`), independent of
    // whether it ranked in the previous period's top-N. Window/CTE/JOIN shape →
    // dispatcher escalates this to the DuckDB executor (R2 SQL cannot run it).
    const wPrev = partitionWhere({ ...q, range: q.compareRange })
    const curMetrics = metricList.map(metricExpr).join(', ')
    const prevMetrics = STD_METRICS.map(m => metricExpr(m as Metric)).join(', ')
    const curCols = metricList.map(m => coalesceMetric(m, 'c', m)).join(', ')
    const prevCols = STD_METRICS.map(m => coalesceMetric(m, 'p', prevAlias(m))).join(', ')
    const variantOut = q.dimension === 'queryCanonical' ? ', c.variantCount AS variantCount' : ''
    // Movers re-rank by period-over-period movement (Growing/Declining/New/
    // Lost); otherwise rank by the requested metric.
    const mover = q.movers ? moverClause(q.movers) : null
    const moverWhere = mover ? `WHERE ${mover.where} ` : ''
    const orderSql = mover ? `ORDER BY ${mover.order}` : `ORDER BY ${order}`
    const sql = `WITH cur AS (SELECT ${col} AS k, ${curMetrics}${variantSel} FROM ${TABLE_PLACEHOLDER} WHERE ${w.clause}${facet.sql} GROUP BY ${col}), `
      + `prev AS (SELECT ${col} AS k, ${prevMetrics} FROM ${TABLE_PLACEHOLDER} WHERE ${wPrev.clause}${facet.sql} GROUP BY ${col}) `
      + `SELECT COALESCE(c.k, p.k) AS ${q.dimension}, ${curCols}, ${prevCols}${variantOut}${totalCol} `
      + `FROM cur c FULL OUTER JOIN prev p ON c.k = p.k ${moverWhere}${orderSql} ${limit}${offset}`
    return { table, params: [...w.params, ...facet.params, ...wPrev.params, ...facet.params], sql }
  }

  // Select the order metric too (when not already requested) and ORDER BY its
  // alias — recomputing the aggregate in ORDER BY makes DataFusion (R2 SQL) emit
  // a duplicate unqualified field name and reject the query (40004). Mirrors the
  // device branch above + the browser builder (engine-duckdb-wasm).
  const metrics = metricList.map(metricExpr).join(', ')
  const sql = `SELECT ${col}, ${metrics}${variantSel}${totalCol} FROM ${TABLE_PLACEHOLDER} WHERE ${w.clause}${facet.sql} `
    + `GROUP BY ${col} ORDER BY ${order} ${limit}${offset}`
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

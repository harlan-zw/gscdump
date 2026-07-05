import type { Dimension, Metric } from '@gscdump/contracts'
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
} from '@gscdump/contracts/archetypes'

export const TABLE_PLACEHOLDER = '{{TABLE}}'

export type ArchetypeFactTable = 'pages' | 'queries' | 'countries' | 'page_queries' | 'dates'

export interface ArchetypeSqlPlan {
  sql: string
  params: unknown[]
  table: ArchetypeFactTable
}

export type PartitionPredicateMode = 'bare' | 'r2-sql-concat'
export type PartitionKeyEncoding = 'int' | 'string'

export interface BuildArchetypeSqlOptions {
  /**
   * Set by the DuckDB file-list executor, which reads raw Iceberg parquet
   * directly via `read_parquet([...])`, bypassing the catalog metadata layer
   * that synthesizes the identity-partition columns. `site_id` / `search_type`
   * are partition identities NOT materialized in the data files (see engine
   * `iceberg/schema.ts`: "carried implicitly in the object-key prefix"), so a
   * `WHERE site_id = ?` predicate fails with `Referenced column "site_id" not
   * found in FROM clause`. Those files are already pruned to (site_id,
   * search_type) at resolution time, so the predicate is redundant — emit only
   * the row-level `date` range (a real stored column; `month(date)` is the
   * partition transform, not `date` itself).
   *
   * The R2 SQL catalog path (default `false`) exposes partition columns as
   * virtual columns and needs the full predicate.
   */
  partitionPruned?: boolean
  /**
   * Int-partition catalogs are the default and use bare equality. Legacy
   * string-partition catalogs can request CONCAT-wrapped predicates directly
   * instead of post-processing generated SQL.
   */
  partitionPredicateMode?: PartitionPredicateMode
  /** Preferred input for new callers. Defaults to `'int'`. */
  partitionKeyEncoding?: PartitionKeyEncoding
}

function dimColumn(dim: Dimension): string {
  if (dim === 'page')
    return 'url'
  if (dim === 'queryCanonical')
    return 'COALESCE((SELECT qd.query_canonical FROM query_dim qd WHERE qd.query = query LIMIT 1), query)'
  return dim
}

function dimSelect(dim: Dimension): string {
  const col = dimColumn(dim)
  return dim === 'queryCanonical' ? `${col} AS queryCanonical` : col
}

function tableForDimensions(dims: readonly string[]): ArchetypeFactTable {
  const set = new Set(dims.filter(d => d !== 'date'))
  if (set.has('page') && (set.has('query') || set.has('queryCanonical')))
    return 'page_queries'
  if (set.has('query') || set.has('queryCanonical'))
    return 'queries'
  if (set.has('country'))
    return 'countries'
  if (set.has('device'))
    return 'dates'
  return 'pages'
}

function metricExpr(metric: Metric): string {
  switch (metric) {
    case 'clicks':
      return 'SUM(clicks) AS clicks'
    case 'impressions':
      return 'SUM(impressions) AS impressions'
    case 'ctr':
      return 'SUM(clicks) / NULLIF(SUM(impressions), 0) AS ctr'
    case 'position':
      // Fact-table convention: `sum_position = (position − 1) × impressions`
      // (engine `metrics.ts`), so the mean must be recovered with `+ 1` — the
      // omission served every archetype position exactly 1 low (the sole
      // remaining `archetype_seam.parity_diff` class, R2-FIXES G1).
      return 'SUM(sum_position) / NULLIF(SUM(impressions), 0) + 1 AS position'
    default:
      // A malformed caller metric would otherwise fall through to `undefined`
      // and be interpolated as the literal token `undefined`, producing R2 SQL
      // 40004 "No field named undefined". Fail loud instead (parity with the
      // engine-duckdb-wasm sibling's `metricExpr`).
      throw new Error(`[archetype-sql] unknown metric: ${JSON.stringify(metric)}`)
  }
}

// The metric doubles as the SELECT-list alias referenced by ORDER BY (`ORDER BY
// clicks DESC`). Validate it against the known set so a malformed value can't be
// interpolated as a bare `undefined`/injection token into the ORDER BY clause.
function metricAlias(metric: Metric): string {
  switch (metric) {
    case 'clicks':
    case 'impressions':
    case 'ctr':
    case 'position':
      return metric
    default:
      throw new Error(`[archetype-sql] unknown order metric: ${JSON.stringify(metric)}`)
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
      // Same `+ 1` recovery as `metricExpr` — device-suffixed sums share the
      // `(position − 1) × impressions` storage convention.
      return `SUM(${source.sumPosition}) / NULLIF(SUM(${source.impressions}), 0) + 1 AS position`
    default:
      throw new Error(`[archetype-sql] unknown metric: ${JSON.stringify(metric)}`)
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

const STD_METRICS = ['clicks', 'impressions', 'ctr', 'position'] as const

function coalesceMetric(metric: string, src: string, alias: string): string {
  const ref = `${src}.${metric}`
  return (metric === 'clicks' || metric === 'impressions')
    ? `CAST(COALESCE(${ref}, 0) AS DOUBLE) AS ${alias}`
    : `COALESCE(${ref}, 0) AS ${alias}`
}

function prevAlias(metric: string): string {
  return `prev${metric.charAt(0).toUpperCase()}${metric.slice(1)}`
}

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

function sqlStringLiteral(value: string): string {
  return `'${value.replace(/'/g, '\'\'')}'`
}

function partitionWhere(
  q: { siteId: string, searchType: string, range: { start: string, end: string } },
  partitionPruned = false,
  mode: PartitionPredicateMode = 'bare',
): {
  clause: string
  params: unknown[]
} {
  // File-list path: site_id/search_type are satisfied by file selection and
  // absent from the data files — keep only the row-level date predicate.
  if (partitionPruned) {
    return {
      clause: 'date BETWEEN ? AND ?',
      params: [q.range.start, q.range.end],
    }
  }
  const siteIdCol = mode === 'r2-sql-concat' ? 'CONCAT(site_id, \'\')' : 'site_id'
  const searchTypeCol = mode === 'r2-sql-concat' ? 'CONCAT(search_type, \'\')' : 'search_type'
  return {
    clause: `${siteIdCol} = ? AND ${searchTypeCol} = ? AND date BETWEEN ? AND ?`,
    params: [q.siteId, q.searchType, q.range.start, q.range.end],
  }
}

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

function buildSiteDailyTimeseries(q: SiteDailyTimeseriesQuery, pruned: boolean, mode: PartitionPredicateMode): ArchetypeSqlPlan {
  const w = partitionWhere(q, pruned, mode)
  const metrics = q.metrics.map(metricExpr).join(', ')
  return {
    table: 'dates',
    params: w.params,
    sql: `SELECT date, ${metrics} FROM ${TABLE_PLACEHOLDER} WHERE ${w.clause} GROUP BY date ORDER BY date ASC`,
  }
}

function buildEntityDailyTimeseries(q: EntityDailyTimeseriesQuery, pruned: boolean, mode: PartitionPredicateMode): ArchetypeSqlPlan {
  const table = tableForDimensions([q.entity.dimension])
  const w = partitionWhere(q, pruned, mode)
  const col = dimColumn(q.entity.dimension)
  const metrics = q.metrics.map(metricExpr).join(', ')
  return {
    table,
    params: [...w.params, q.entity.value],
    sql: `SELECT date, ${metrics} FROM ${TABLE_PLACEHOLDER} WHERE ${w.clause} AND ${col} = ? GROUP BY date ORDER BY date ASC`,
  }
}

function buildEntityDailySparkline(q: EntityDailySparklineQuery, pruned: boolean, mode: PartitionPredicateMode): ArchetypeSqlPlan {
  const table = tableForDimensions([q.dimension])
  const w = partitionWhere(q, pruned, mode)
  const col = dimColumn(q.dimension)
  if (q.entities.length === 0)
    throw new Error('entity-daily-sparkline: empty entities - resolver must pre-resolve the top-N list')
  const inList = q.entities.map(sqlStringLiteral).join(', ')
  return {
    table,
    params: w.params,
    sql: `SELECT date, ${dimSelect(q.dimension)}, ${metricExpr(q.metric)} FROM ${TABLE_PLACEHOLDER} `
      + `WHERE ${w.clause} AND ${col} IN (${inList}) GROUP BY date, ${col} ORDER BY date ASC`,
  }
}

function buildTopNBreakdown(q: TopNBreakdownQuery, pruned: boolean, mode: PartitionPredicateMode): ArchetypeSqlPlan {
  const table = tableForDimensions([q.dimension])
  const w = partitionWhere(q, pruned, mode)
  // `orderBy` is mandatory for this archetype; a missing/malformed one would
  // otherwise deref undefined (TypeError) or interpolate `ORDER BY undefined`
  // (R2 SQL 40004). Validate up front so the failure names the real cause.
  if (!q.orderBy || !q.orderBy.metric || !q.orderBy.dir)
    throw new Error(`[archetype-sql] top-n-breakdown requires orderBy.{metric,dir}, got: ${JSON.stringify(q.orderBy)}`)
  const order = `${metricAlias(q.orderBy.metric)} ${q.orderBy.dir.toUpperCase()}`
  // compareRange branches build `FROM cur c FULL OUTER JOIN prev p`, which
  // exposes the join-input column as qualified `c.clicks` while the SELECT list
  // re-aliases it back to the bare output name `clicks`. `ORDER BY clicks` is
  // then ambiguous under R2 SQL / DataFusion (40004: "qualified field name
  // c.clicks and unqualified field name clicks"). Order by the qualified,
  // coalesced current-range value instead — same ordering as the output alias
  // (COALESCE(c.metric, 0)), mirroring `moverClause`, but unambiguous.
  const compareOrder = `COALESCE(c.${metricAlias(q.orderBy.metric)}, 0) ${q.orderBy.dir.toUpperCase()}`
  const limit = `LIMIT ${Math.max(0, Math.floor(q.limit))}`
  const offset = q.offset && q.offset > 0 ? ` OFFSET ${Math.floor(q.offset)}` : ''
  const metricList = q.metrics.includes(q.orderBy.metric) ? q.metrics : [...q.metrics, q.orderBy.metric]
  const variantSel = q.dimension === 'queryCanonical' ? ', COUNT(DISTINCT query) AS variantCount' : ''

  if (q.dimension === 'device') {
    if (q.compareRange) {
      const wPrev = partitionWhere({ ...q, range: q.compareRange }, pruned, mode)
      const deviceSelects = (clause: string, ml: readonly Metric[]): string => DEVICE_SUFFIXES.map((suffix) => {
        const source = deviceSource(suffix)
        const metrics = ml.map(m => metricExprForSource(m, source)).join(', ')
        return `SELECT '${suffix.toUpperCase()}' AS device, ${metrics} FROM ${TABLE_PLACEHOLDER} WHERE ${clause}`
      }).join(' UNION ALL ')
      const curCols = metricList.map(m => coalesceMetric(m, 'c', m)).join(', ')
      const prevCols = STD_METRICS.map(m => coalesceMetric(m, 'p', prevAlias(m))).join(', ')
      const sql = `WITH cur AS (${deviceSelects(w.clause, metricList)}), prev AS (${deviceSelects(wPrev.clause, STD_METRICS)}) `
        + `SELECT COALESCE(c.device, p.device) AS device, ${curCols}, ${prevCols} `
        + `FROM cur c FULL OUTER JOIN prev p ON c.device = p.device ORDER BY ${compareOrder} ${limit}${offset}`
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
  const totalCol = q.includeTotal ? ', COUNT(*) OVER() AS __total' : ''

  if (q.compareRange) {
    const wPrev = partitionWhere({ ...q, range: q.compareRange }, pruned, mode)
    const curMetrics = metricList.map(metricExpr).join(', ')
    const prevMetrics = STD_METRICS.map(m => metricExpr(m)).join(', ')
    const curCols = metricList.map(m => coalesceMetric(m, 'c', m)).join(', ')
    const prevCols = STD_METRICS.map(m => coalesceMetric(m, 'p', prevAlias(m))).join(', ')
    const variantOut = q.dimension === 'queryCanonical' ? ', c.variantCount AS variantCount' : ''
    const mover = q.movers ? moverClause(q.movers) : null
    const moverWhere = mover ? `WHERE ${mover.where} ` : ''
    const orderSql = mover ? `ORDER BY ${mover.order}` : `ORDER BY ${compareOrder}`
    const sql = `WITH cur AS (SELECT ${col} AS k, ${curMetrics}${variantSel} FROM ${TABLE_PLACEHOLDER} WHERE ${w.clause}${facet.sql} GROUP BY ${col}), `
      + `prev AS (SELECT ${col} AS k, ${prevMetrics} FROM ${TABLE_PLACEHOLDER} WHERE ${wPrev.clause}${facet.sql} GROUP BY ${col}) `
      + `SELECT COALESCE(c.k, p.k) AS ${q.dimension}, ${curCols}, ${prevCols}${variantOut}${totalCol} `
      + `FROM cur c FULL OUTER JOIN prev p ON c.k = p.k ${moverWhere}${orderSql} ${limit}${offset}`
    return { table, params: [...w.params, ...facet.params, ...wPrev.params, ...facet.params], sql }
  }

  const metrics = metricList.map(metricExpr).join(', ')
  const sql = `SELECT ${dimSelect(q.dimension)}, ${metrics}${variantSel}${totalCol} FROM ${TABLE_PLACEHOLDER} WHERE ${w.clause}${facet.sql} `
    + `GROUP BY ${col} ORDER BY ${order} ${limit}${offset}`
  return { table, params: [...w.params, ...facet.params], sql }
}

function buildSingleRowLookup(q: SingleRowLookupQuery, pruned: boolean, mode: PartitionPredicateMode): ArchetypeSqlPlan {
  const dims = Object.keys(q.match) as Dimension[]
  const table = tableForDimensions(dims)
  const w = partitionWhere(q, pruned, mode)
  const params = [...w.params]
  let clause = w.clause
  for (const dim of dims) {
    clause += ` AND ${dimColumn(dim)} = ?`
    params.push(q.match[dim])
  }
  const metrics = q.metrics.map(metricExpr).join(', ')
  const groupBy = dims.length > 0 ? ` GROUP BY ${dims.map(dimColumn).join(', ')}` : ''
  const select = dims.length > 0 ? `${dims.map(dimSelect).join(', ')}, ${metrics}` : metrics
  return {
    table,
    params,
    sql: `SELECT ${select} FROM ${TABLE_PLACEHOLDER} WHERE ${clause}${groupBy}`,
  }
}

function buildMultiSeriesStackedDaily(q: MultiSeriesStackedDailyQuery, pruned: boolean, mode: PartitionPredicateMode): ArchetypeSqlPlan {
  const table = tableForDimensions([q.seriesDimension])
  const w = partitionWhere(q, pruned, mode)
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
    sql: `SELECT date, ${dimSelect(q.seriesDimension)}, ${metricExpr(q.metric)} FROM ${TABLE_PLACEHOLDER} `
      + `WHERE ${w.clause} GROUP BY date, ${col} ORDER BY date ASC`,
  }
}

function buildTwoDimensionDetail(q: TwoDimensionDetailQuery, pruned: boolean, mode: PartitionPredicateMode): ArchetypeSqlPlan {
  const w = partitionWhere(q, pruned, mode)
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
  const metricList = q.orderBy && !q.metrics.includes(q.orderBy.metric)
    ? [...q.metrics, q.orderBy.metric]
    : q.metrics
  const metrics = metricList.map(metricExpr).join(', ')
  let sql = `SELECT url, query, ${metrics} FROM ${TABLE_PLACEHOLDER} WHERE ${clause} GROUP BY url, query`
  if (q.orderBy)
    sql += ` ORDER BY ${metricAlias(q.orderBy.metric)} ${q.orderBy.dir.toUpperCase()}`
  if (q.limit && q.limit > 0)
    sql += ` LIMIT ${Math.floor(q.limit)}`
  return { table: 'page_queries', params, sql }
}

export function buildArchetypeSql(query: ArchetypeQuery, opts: BuildArchetypeSqlOptions = {}): ArchetypeSqlPlan {
  const pruned = opts.partitionPruned ?? false
  const mode = opts.partitionPredicateMode
    ?? (opts.partitionKeyEncoding === 'string' ? 'r2-sql-concat' : 'bare')
  switch (query.archetype) {
    case 'site-daily-timeseries':
      return buildSiteDailyTimeseries(query, pruned, mode)
    case 'entity-daily-timeseries':
      return buildEntityDailyTimeseries(query, pruned, mode)
    case 'entity-daily-sparkline':
      return buildEntityDailySparkline(query, pruned, mode)
    case 'top-n-breakdown':
      return buildTopNBreakdown(query, pruned, mode)
    case 'single-row-lookup':
      return buildSingleRowLookup(query, pruned, mode)
    case 'multi-series-stacked-daily':
      return buildMultiSeriesStackedDaily(query, pruned, mode)
    case 'two-dimension-detail':
      return buildTwoDimensionDetail(query, pruned, mode)
    case 'arbitrary-sql':
      throw new Error('buildArchetypeSql: arbitrary-sql carries caller SQL - the DuckDB executor runs it verbatim')
    case 'aux-cloud-only':
      throw new Error('buildArchetypeSql: aux-cloud-only is not an Iceberg query')
  }
}

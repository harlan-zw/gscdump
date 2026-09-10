/**
 * Dialect-neutral SQL composers for `BuilderState`. Ported from the original
 * gscdump.com resolver — parameterized via a {@link ResolverAdapter} so the
 * same composition runs against D1 (via `/sqlite`) or parquet-over-DuckDB
 * (via `/browser`). Site-scoping is optional: single-tenant parquet omits it.
 */

import type { SQL } from 'drizzle-orm'
import type {
  BuilderState,
  Dimension,
  InternalFilter,
  Metric,
} from 'gscdump/query'
import type {
  LogicalComparisonPlan,
  LogicalDimensionFilter,
  LogicalFilterNode,
  LogicalMetricFilter,
  LogicalQueryPlan,
} from 'gscdump/query/plan'
import type {
  ComparisonFilter,
  ExtraQuery,
  ResolvedComparisonSQL,
  ResolvedSQL,
  ResolvedSQLOptimized,
  ResolverOptions,
} from './types'

import { sql } from 'drizzle-orm'
import { and, gte, impressions } from 'gscdump/query'
import { buildLogicalComparisonPlan, buildLogicalPlan } from 'gscdump/query/plan'

const COMPARISON_FILTER_SQL: Record<ComparisonFilter, SQL> = {
  new: sql`AND COALESCE(p.impressions, 0) = 0 AND COALESCE(c.impressions, 0) > 0`,
  lost: sql`AND COALESCE(p.impressions, 0) > 0 AND COALESCE(c.impressions, 0) = 0`,
  improving: sql`AND COALESCE(c.clicks, 0) > COALESCE(p.clicks, 0)`,
  declining: sql`AND COALESCE(c.clicks, 0) < COALESCE(p.clicks, 0) AND COALESCE(p.clicks, 0) > 0`,
}

function collapseWs(s: string): string {
  return s.replace(/\s+/g, ' ').trim()
}

function joinAnd(parts: SQL[]): SQL {
  return sql.join(parts, sql` AND `)
}

function joinComma(parts: SQL[]): SQL {
  return sql.join(parts, sql`, `)
}

const ORDER_BY_HELPER_PREFIX = '__order_'

function withMinimumImpressions<TK extends string>(state: BuilderState, options: ResolverOptions<TK>): BuilderState {
  if (options.minimumImpressions === undefined)
    return state
  const minimum = Number(options.minimumImpressions)
  if (!Number.isFinite(minimum) || minimum < 0)
    throw new RangeError('minimumImpressions must be a finite non-negative number')
  const guard = gte(impressions, minimum)
  return { ...state, prefilter: state.prefilter ? and(state.prefilter, guard) : guard }
}

// ORDER BY is safe-stripped because `column` / `dir` come from `BuilderState`
// (typed union) but we still guard against raw strings reaching SQL.
function orderByClause(state: BuilderState, prefix: string = '', columnOverride?: string): SQL {
  if (state.orderBy) {
    const safeCol = (columnOverride ?? state.orderBy.column).replace(/\W/g, '')
    const safeDir = state.orderBy.dir.toUpperCase() === 'ASC' ? 'ASC' : 'DESC'
    return sql.raw(`ORDER BY ${prefix}${safeCol} ${safeDir}`)
  }
  return sql.raw(`ORDER BY ${prefix}clicks DESC`)
}

function limitOffsetClause(state: BuilderState): SQL {
  const rowLimit = Math.max(0, Math.floor(Number(state.rowLimit ?? 100)))
  const offset = state.startRow ? Math.max(0, Math.floor(Number(state.startRow))) : 0
  return sql.raw(offset > 0 ? `LIMIT ${rowLimit} OFFSET ${offset}` : `LIMIT ${rowLimit}`)
}

// Double-quote the alias so DuckDB preserves the original case in result row
// keys (DuckDB folds unquoted identifiers to lowercase). SQLite preserves
// case either way, so quoting is safe across both dialects.
function aliasRaw(name: string): SQL {
  const safe = name.replace(/\W/g, '')
  return sql.raw(`"${safe}"`)
}

interface BuiltScope<TK extends string> {
  plan: LogicalQueryPlan
  tableKey: TK
  groupByDims: Dimension[]
  hasDate: boolean
  metrics: readonly Metric[]
  wherePredicates: SQL[]
  having: SQL[]
  dimFilters: InternalFilter[]
  startDate?: string
  endDate?: string
  queryCanonicalUsed: boolean
}

function toInternalDimensionFilters(filters: LogicalDimensionFilter[]): InternalFilter[] {
  return filters.map(filter => ({
    dimension: filter.dimension,
    operator: filter.operator,
    expression: filter.expression,
    expression2: filter.expression2,
  }))
}

function toInternalMetricFilters(filters: LogicalMetricFilter[]): InternalFilter[] {
  return filters.map(filter => ({
    dimension: filter.metric,
    operator: filter.operator,
    expression: String(filter.expression),
    expression2: filter.expression2 == null ? undefined : String(filter.expression2),
  }))
}

function topLevelFilters(plan: LogicalQueryPlan): InternalFilter[] {
  if (!plan.specialFilters.topLevel)
    return []
  return [{ dimension: 'page', operator: 'topLevel', expression: '' }]
}

function logicalFilterToInternal(filter: LogicalDimensionFilter): InternalFilter {
  return {
    dimension: filter.dimension,
    operator: filter.operator,
    expression: filter.expression,
    expression2: filter.expression2,
  }
}

// Compile a dimension-filter tree into a single SQL expression that respects
// AND/OR group boundaries. Per-leaf SQL is delegated to the adapter's existing
// `dimensionPredicates` (called with a single-element list) so dialects don't
// need a new entry point.
function compileFilterTree<TK extends string>(
  node: LogicalFilterNode | undefined,
  adapter: ResolverOptions<TK>['adapter'],
  tableKey: TK,
): SQL | undefined {
  if (!node)
    return undefined

  if (node.kind === 'leaf') {
    const preds = adapter.dimensionPredicates([logicalFilterToInternal(node.filter)], tableKey)
    return preds[0]
  }

  const childSqls = node.children
    .map(child => compileFilterTree(child, adapter, tableKey))
    .filter((s): s is SQL => s !== undefined)
  if (childSqls.length === 0)
    return undefined
  if (childSqls.length === 1)
    return childSqls[0]
  const sep = node.groupType === 'or' ? sql` OR ` : sql` AND `
  return sql`(${sql.join(childSqls, sep)})`
}

function buildScope<TK extends string>(
  state: BuilderState,
  options: ResolverOptions<TK>,
): BuiltScope<TK> {
  const { adapter, siteId, searchType } = options
  const plan = buildLogicalPlan(state, adapter.capabilities)
  const tableKey = adapter.tableKeyForDataset(plan.dataset)

  const dimFilters = toInternalDimensionFilters(plan.dimensionFilters)
  const metricFilters = toInternalMetricFilters(plan.metricFilters)
  const prefilters = toInternalMetricFilters(plan.prefilters)
  const groupByDims = plan.groupByDimensions
  const hasDate = plan.hasDate
  const metrics = plan.metrics
  const queryCanonicalUsed = groupByDims.includes('queryCanonical')
    || plan.dimensionFilters.some(filter => filter.dimension === 'queryCanonical')

  const wherePredicates: SQL[] = []
  if (adapter.siteIdColRef && siteId != null)
    wherePredicates.push(sql`${adapter.siteIdColRef(tableKey)} = ${siteId}`)
  if (adapter.searchTypeColRef && searchType != null)
    wherePredicates.push(sql`${adapter.searchTypeColRef(tableKey)} = ${searchType}`)
  wherePredicates.push(sql`${adapter.dateColRef(tableKey)} >= ${plan.dateRange.startDate}`)
  wherePredicates.push(sql`${adapter.dateColRef(tableKey)} <= ${plan.dateRange.endDate}`)
  wherePredicates.push(...adapter.prefilterPredicates(prefilters, tableKey))
  // Prefer the tree (preserves OR groups); fall back to flat AND of leaves
  // for plans built without tree support (older callers).
  const dimSql = plan.dimensionFilterTree
    ? compileFilterTree(plan.dimensionFilterTree, adapter, tableKey)
    : undefined
  if (dimSql) {
    wherePredicates.push(dimSql)
  }
  else if (!plan.dimensionFilterTree) {
    wherePredicates.push(...adapter.dimensionPredicates(dimFilters, tableKey))
  }
  const tl = adapter.topLevelPredicate(topLevelFilters(plan), tableKey)
  if (tl)
    wherePredicates.push(tl)

  const having = adapter.havingPredicates(metricFilters, tableKey)

  return {
    plan,
    tableKey,
    groupByDims,
    hasDate,
    metrics,
    wherePredicates,
    having,
    dimFilters,
    startDate: plan.dateRange.startDate,
    endDate: plan.dateRange.endDate,
    queryCanonicalUsed,
  }
}

function buildComparisonPlan(
  current: BuilderState,
  previous: BuilderState,
  capabilities: ResolverOptions['adapter']['capabilities'],
): LogicalComparisonPlan {
  return buildLogicalComparisonPlan(
    current,
    previous,
    capabilities,
  )
}

function compileCollapsed<TK extends string>(
  adapter: ResolverOptions<TK>['adapter'],
  q: SQL,
): { sql: string, params: unknown[] } {
  const c = adapter.compile(q)
  return { sql: collapseWs(c.sql), params: c.params }
}

export function resolveToSQLOptimized<TK extends string>(
  state: BuilderState,
  options: ResolverOptions<TK>,
): ResolvedSQLOptimized {
  state = withMinimumImpressions(state, options)
  const { adapter } = options
  const { tableKey, groupByDims, hasDate, metrics, wherePredicates, having, queryCanonicalUsed } = buildScope(state, options)
  const table = adapter.fromSql(tableKey, { queryCanonical: queryCanonicalUsed })
  const schema = adapter.schema as Record<string, Record<string, SQL>>

  const cteSelect: SQL[] = []
  for (const d of groupByDims) {
    const expr = adapter.dimExprSql(d, tableKey)
    const colName = adapter.dimColumn(d, tableKey)
    if (d === 'page' || colName !== d)
      cteSelect.push(sql`${expr} as ${aliasRaw(d)}`)
    else
      cteSelect.push(expr)
  }
  if (hasDate)
    cteSelect.push(adapter.dateColRef(tableKey))
  const t = schema[tableKey]!
  // CAST AS DOUBLE: DuckDB returns SUM() over INTEGER as HUGEINT which fails to
  // serialize through the DUCKDB_SVC service binding (comes back as null).
  // Harmless on SQLite (becomes REAL semantically).
  cteSelect.push(sql`CAST(SUM(${t.clicks}) AS DOUBLE) as clicks`)
  cteSelect.push(sql`CAST(SUM(${t.impressions}) AS DOUBLE) as impressions`)
  cteSelect.push(sql`CAST(SUM(${t.sum_position}) AS DOUBLE) as sum_position`)

  const groupByExprs: SQL[] = groupByDims.map(d => adapter.dimExprSql(d, tableKey))
  if (hasDate)
    groupByExprs.push(adapter.dateColRef(tableKey))

  const outerSelect: SQL[] = []
  for (const d of groupByDims) outerSelect.push(aliasRaw(d))
  if (hasDate)
    outerSelect.push(sql.raw('date'))
  const outerTotals: SQL[] = []
  for (const m of metrics) {
    switch (m) {
      case 'clicks':
        outerSelect.push(sql.raw('clicks'))
        outerTotals.push(sql.raw('CAST(SUM(clicks) OVER() AS DOUBLE) as totalClicks'))
        break
      case 'impressions':
        outerSelect.push(sql.raw('impressions'))
        outerTotals.push(sql.raw('CAST(SUM(impressions) OVER() AS DOUBLE) as totalImpressions'))
        break
      case 'ctr':
        outerSelect.push(sql.raw('CAST(clicks AS REAL) / NULLIF(impressions, 0) as ctr'))
        outerTotals.push(sql.raw('CAST(SUM(clicks) OVER() AS REAL) / NULLIF(SUM(impressions) OVER(), 0) as totalCtr'))
        break
      case 'position':
        outerSelect.push(sql.raw('sum_position / NULLIF(impressions, 0) + 1 as position'))
        outerTotals.push(sql.raw('SUM(sum_position) OVER() / NULLIF(SUM(impressions) OVER(), 0) + 1 as totalPosition'))
        break
    }
  }
  let orderByColumnOverride: string | undefined
  const orderColumn = state.orderBy?.column
  if (orderColumn && orderColumn !== 'date' && !metrics.includes(orderColumn)) {
    orderByColumnOverride = `${ORDER_BY_HELPER_PREFIX}${orderColumn}`
    switch (orderColumn) {
      case 'clicks':
        outerSelect.push(sql.raw(`clicks as "${orderByColumnOverride}"`))
        break
      case 'impressions':
        outerSelect.push(sql.raw(`impressions as "${orderByColumnOverride}"`))
        break
      case 'ctr':
        outerSelect.push(sql.raw(`CAST(clicks AS REAL) / NULLIF(impressions, 0) as "${orderByColumnOverride}"`))
        break
      case 'position':
        outerSelect.push(sql.raw(`sum_position / NULLIF(impressions, 0) + 1 as "${orderByColumnOverride}"`))
        break
    }
  }
  outerSelect.push(sql.raw('COUNT(*) OVER() as totalCount'))
  for (const totalExpr of outerTotals) outerSelect.push(totalExpr)

  let cte = wherePredicates.length > 0
    ? sql`SELECT ${joinComma(cteSelect)} FROM ${table} WHERE ${joinAnd(wherePredicates)}`
    : sql`SELECT ${joinComma(cteSelect)} FROM ${table}`
  if (groupByExprs.length > 0)
    cte = sql`${cte} GROUP BY ${joinComma(groupByExprs)}`
  if (having.length > 0)
    cte = sql`${cte} HAVING ${joinAnd(having)}`

  const query = sql`WITH aggregated AS (${cte}) SELECT ${joinComma(outerSelect)} FROM aggregated ${orderByClause(state, '', orderByColumnOverride)} ${limitOffsetClause(state)}`
  return compileCollapsed(adapter, query)
}

export function resolveToSQL<TK extends string>(
  state: BuilderState,
  options: ResolverOptions<TK>,
): ResolvedSQL {
  state = withMinimumImpressions(state, options)
  const { adapter } = options
  const { tableKey, groupByDims, hasDate, metrics, wherePredicates, having, queryCanonicalUsed } = buildScope(state, options)
  const table = adapter.fromSql(tableKey, { queryCanonical: queryCanonicalUsed })

  const selectExprs: SQL[] = []
  for (const d of groupByDims) {
    const expr = adapter.dimExprSql(d, tableKey)
    const colName = adapter.dimColumn(d, tableKey)
    if (d === 'page' || colName !== d)
      selectExprs.push(sql`${expr} as ${aliasRaw(d)}`)
    else
      selectExprs.push(expr)
  }
  if (hasDate)
    selectExprs.push(adapter.dateColRef(tableKey))
  for (const m of metrics)
    selectExprs.push(sql`${adapter.metricSql(m, tableKey)} as ${aliasRaw(m)}`)

  const groupByExprs: SQL[] = groupByDims.map(d => adapter.dimExprSql(d, tableKey))
  if (hasDate)
    groupByExprs.push(adapter.dateColRef(tableKey))

  let body = wherePredicates.length > 0
    ? sql`SELECT ${joinComma(selectExprs)} FROM ${table} WHERE ${joinAnd(wherePredicates)}`
    : sql`SELECT ${joinComma(selectExprs)} FROM ${table}`
  if (groupByExprs.length > 0)
    body = sql`${body} GROUP BY ${joinComma(groupByExprs)}`
  if (having.length > 0)
    body = sql`${body} HAVING ${joinAnd(having)}`
  const mainQuery = sql`${body} ${orderByClause(state)} ${limitOffsetClause(state)}`

  let countQuery: SQL
  if (groupByExprs.length > 0) {
    let inner = wherePredicates.length > 0
      ? sql`SELECT ${joinComma(groupByExprs)} FROM ${table} WHERE ${joinAnd(wherePredicates)} GROUP BY ${joinComma(groupByExprs)}`
      : sql`SELECT ${joinComma(groupByExprs)} FROM ${table} GROUP BY ${joinComma(groupByExprs)}`
    if (having.length > 0)
      inner = sql`${inner} HAVING ${joinAnd(having)}`
    countQuery = sql`SELECT COUNT(*) as total FROM (${inner})`
  }
  else {
    countQuery = wherePredicates.length > 0
      ? sql`SELECT COUNT(*) as total FROM ${table} WHERE ${joinAnd(wherePredicates)}`
      : sql`SELECT COUNT(*) as total FROM ${table}`
  }

  const main = compileCollapsed(adapter, mainQuery)
  const count = compileCollapsed(adapter, countQuery)
  return { sql: main.sql, params: main.params, countSql: count.sql, countParams: count.params }
}

export function buildTotalsSql<TK extends string>(
  state: BuilderState,
  options: ResolverOptions<TK>,
): { sql: string, params: unknown[] } {
  state = withMinimumImpressions(state, options)
  const { adapter } = options
  const { tableKey, metrics, wherePredicates, queryCanonicalUsed } = buildScope(state, options)
  const table = adapter.fromSql(tableKey, { queryCanonical: queryCanonicalUsed })
  const selectExprs: SQL[] = metrics.map(m => sql`${adapter.metricSql(m, tableKey)} as ${aliasRaw(m)}`)
  const query = wherePredicates.length > 0
    ? sql`SELECT ${joinComma(selectExprs)} FROM ${table} WHERE ${joinAnd(wherePredicates)}`
    : sql`SELECT ${joinComma(selectExprs)} FROM ${table}`
  return compileCollapsed(adapter, query)
}

export function resolveComparisonSQL<TK extends string>(
  current: BuilderState,
  previous: BuilderState,
  options: ResolverOptions<TK>,
  comparisonFilter?: ComparisonFilter,
): ResolvedComparisonSQL {
  const { adapter, siteId, searchType } = options
  const comparisonPlan = buildComparisonPlan(current, previous, adapter.capabilities)
  const currentScope = buildScope(current, options)
  const previousScope = buildScope(previous, options)
  const { tableKey, groupByDims, metrics, wherePredicates: currentWhere, having } = currentScope
  const table = adapter.fromSql(tableKey, { queryCanonical: currentScope.queryCanonicalUsed || previousScope.queryCanonicalUsed })

  const dimSelectExprs: SQL[] = []
  for (const d of groupByDims) {
    const expr = adapter.dimExprSql(d, tableKey)
    const colName = adapter.dimColumn(d, tableKey)
    if (d === 'page' || colName !== d)
      dimSelectExprs.push(sql`${expr} as ${aliasRaw(d)}`)
    else
      dimSelectExprs.push(expr)
  }
  const currentSelect: SQL[] = [
    ...dimSelectExprs,
    ...metrics.map(m => sql`${adapter.metricSql(m, tableKey)} as ${aliasRaw(m)}`),
  ]
  const prevSelect: SQL[] = [
    ...dimSelectExprs,
    ...adapter.METRIC_NAMES.map(m => sql`${adapter.metricSql(m, tableKey)} as ${aliasRaw(m)}`),
  ]
  const groupByExprs = groupByDims.map(d => adapter.dimExprSql(d, tableKey))

  // Previous CTE reuses dimension filters + date window but drops HAVING /
  // top-level — totals for comparison are unfiltered by current metric
  // thresholds.
  const prevWhere: SQL[] = []
  if (adapter.siteIdColRef && siteId != null)
    prevWhere.push(sql`${adapter.siteIdColRef(tableKey)} = ${siteId}`)
  if (adapter.searchTypeColRef && searchType != null)
    prevWhere.push(sql`${adapter.searchTypeColRef(tableKey)} = ${searchType}`)
  if (previousScope.startDate)
    prevWhere.push(sql`${adapter.dateColRef(tableKey)} >= ${previousScope.startDate}`)
  if (previousScope.endDate)
    prevWhere.push(sql`${adapter.dateColRef(tableKey)} <= ${previousScope.endDate}`)
  const prevDimSql = comparisonPlan.current.dimensionFilterTree
    ? compileFilterTree(comparisonPlan.current.dimensionFilterTree, adapter, tableKey)
    : undefined
  if (prevDimSql) {
    prevWhere.push(prevDimSql)
  }
  else if (!comparisonPlan.current.dimensionFilterTree) {
    prevWhere.push(...adapter.dimensionPredicates(
      toInternalDimensionFilters(comparisonPlan.current.dimensionFilters),
      tableKey,
    ))
  }

  let currentCte = currentWhere.length > 0
    ? sql`SELECT ${joinComma(currentSelect)} FROM ${table} WHERE ${joinAnd(currentWhere)}`
    : sql`SELECT ${joinComma(currentSelect)} FROM ${table}`
  if (groupByExprs.length > 0)
    currentCte = sql`${currentCte} GROUP BY ${joinComma(groupByExprs)}`
  if (having.length > 0)
    currentCte = sql`${currentCte} HAVING ${joinAnd(having)}`

  let previousCte = prevWhere.length > 0
    ? sql`SELECT ${joinComma(prevSelect)} FROM ${table} WHERE ${joinAnd(prevWhere)}`
    : sql`SELECT ${joinComma(prevSelect)} FROM ${table}`
  if (groupByExprs.length > 0)
    previousCte = sql`${previousCte} GROUP BY ${joinComma(groupByExprs)}`

  const joinOn = groupByDims.length > 0
    ? sql.raw(groupByDims.map(d => `c.${d.replace(/\W/g, '')} = p.${d.replace(/\W/g, '')}`).join(' AND '))
    : sql.raw('1=1')

  const filterClause = comparisonFilter ? COMPARISON_FILTER_SQL[comparisonFilter] : sql.raw('')

  const orderSql = orderByClause(current, '')
  const limitSql = limitOffsetClause(current)

  // Outer SELECT enumerates columns explicitly (not `c.*`) and casts the
  // integer metrics to DOUBLE. The cast bridges a DuckDB-WASM serialization
  // quirk where SUM(integer)→BIGINT/HUGEINT columns surfaced via a CTE
  // arrive as null at the JS boundary; casting forces the result to a
  // DOUBLE column (always a finite Number in JS).
  const outerCurrentCols: SQL[] = []
  for (const d of groupByDims) {
    const colName = d.replace(/\W/g, '')
    outerCurrentCols.push(sql.raw(`COALESCE(c.${colName}, p.${colName}) as "${colName}"`))
  }
  outerCurrentCols.push(sql.raw('CAST(COALESCE(c.clicks, 0) AS DOUBLE) as "clicks"'))
  outerCurrentCols.push(sql.raw('CAST(COALESCE(c.impressions, 0) AS DOUBLE) as "impressions"'))
  outerCurrentCols.push(sql.raw('COALESCE(c.ctr, 0) as "ctr"'))
  outerCurrentCols.push(sql.raw('COALESCE(c.position, 0) as "position"'))

  const mainQuery = sql`WITH current AS (${currentCte}), previous AS (${previousCte}) SELECT ${joinComma(outerCurrentCols)}, COALESCE(CAST(p.clicks AS DOUBLE), 0) as "prevClicks", COALESCE(CAST(p.impressions AS DOUBLE), 0) as "prevImpressions", COALESCE(p.ctr, 0) as "prevCtr", COALESCE(p.position, 0) as "prevPosition" FROM current c FULL OUTER JOIN previous p ON ${joinOn} WHERE 1=1 ${filterClause} ${orderSql} ${limitSql}`

  const firstGroupBy = groupByDims[0] ? groupByDims[0].replace(/\W/g, '') : 'clicks'
  const countInnerSelect = groupByDims[0] ? sql.raw(`COALESCE(c.${firstGroupBy}, p.${firstGroupBy})`) : sql.raw(`c.${firstGroupBy}`)
  const countQuery = sql`WITH current AS (${currentCte}), previous AS (${previousCte}) SELECT COUNT(*) as total FROM (SELECT ${countInnerSelect} FROM current c FULL OUTER JOIN previous p ON ${joinOn} WHERE 1=1 ${filterClause})`

  const main = compileCollapsed(adapter, mainQuery)
  const count = compileCollapsed(adapter, countQuery)
  return { sql: main.sql, params: main.params, countSql: count.sql, countParams: count.params }
}

/**
 * Enrich Canonical Query groups with their raw variants.
 * Supply selected keys to limit aggregation to the current page.
 * An empty key list skips enrichment. Omit keys to enrich the full window.
 */
export function buildExtrasQueries<TK extends string>(
  state: BuilderState,
  options: ResolverOptions<TK>,
  queryCanonicalKeys?: readonly string[],
): ExtraQuery[] {
  const { adapter, siteId, searchType } = options
  const plan = buildLogicalPlan(state, adapter.capabilities)
  const dims = plan.groupByDimensions
  const extras: ExtraQuery[] = []

  const hasQueryCanonical = dims.includes('queryCanonical')
  if (!hasQueryCanonical || queryCanonicalKeys?.length === 0)
    return extras

  const queriesKey = adapter.tableKeyForDataset('queries') as TK
  const schema = adapter.schema as Record<string, Record<string, SQL>>
  const t = schema[queriesKey]!
  const table = adapter.fromSql(queriesKey, { queryCanonical: true })

  const whereParts: SQL[] = []
  if (adapter.siteIdColRef && siteId != null)
    whereParts.push(sql`${adapter.siteIdColRef(queriesKey)} = ${siteId}`)
  if (adapter.searchTypeColRef && searchType != null)
    whereParts.push(sql`${adapter.searchTypeColRef(queriesKey)} = ${searchType}`)
  whereParts.push(sql`${adapter.dateColRef(queriesKey)} >= ${plan.dateRange.startDate}`)
  whereParts.push(sql`${adapter.dateColRef(queriesKey)} <= ${plan.dateRange.endDate}`)

  const outerQueryCol = sql.raw('query')
  // Key on the total canonical derived from query_dim, with raw query as the
  // fallback. The live extras then share one key space with the main canonical
  // query and the `query_canonical_*` rollups.
  const canonKey = adapter.dimExprSql('queryCanonical', queriesKey)
  if (queryCanonicalKeys) {
    const keys = [...new Set(queryCanonicalKeys)].map(key => sql`${key}`)
    whereParts.push(sql`${canonKey} IN (${joinComma(keys)})`)
  }
  const whereExpr = whereParts.length > 0 ? sql`WHERE ${joinAnd(whereParts)}` : sql``
  const q = sql`WITH per_variant AS (SELECT ${canonKey} as joinKey, ${t.query} as query, SUM(${t.clicks}) as clicks, SUM(${t.impressions}) as impressions, SUM(${t.sum_position}) as sum_pos, ROW_NUMBER() OVER (PARTITION BY ${canonKey} ORDER BY SUM(${t.clicks}) DESC) as rn, COUNT(*) OVER (PARTITION BY ${canonKey}) as variantCount FROM ${table} ${whereExpr} GROUP BY ${canonKey}, ${t.query}) SELECT joinKey, MAX(variantCount) as variantCount, MAX(CASE WHEN rn = 1 THEN ${outerQueryCol} END) as canonicalName, STRING_AGG(CASE WHEN rn <= 10 THEN ${outerQueryCol} || ':::' || clicks || ':::' || impressions || ':::' || CAST(ROUND(CAST(sum_pos AS REAL) / NULLIF(impressions, 0) + 1, 1) AS TEXT) END, '||') as variants FROM per_variant GROUP BY joinKey`

  const compiled = compileCollapsed(adapter, q)
  extras.push({ key: 'canonicalExtras', sql: compiled.sql, params: compiled.params })
  return extras
}

export function mergeExtras(
  rows: Record<string, unknown>[],
  extrasResults: { key: string, results: Record<string, unknown>[] }[],
): Record<string, unknown>[] {
  if (extrasResults.length === 0)
    return rows

  interface CanonicalExtra { variantCount: unknown, variants: unknown, canonicalName: unknown }
  type LookupPlan
    = { kind: 'canonical', map: Map<string, CanonicalExtra> }
      | { kind: 'generic', key: string, map: Map<string, unknown> }
  const lookups: LookupPlan[] = []

  const parseVariants = (raw: string): Array<{ query: string | undefined, clicks: number, impressions: number, position: number }> => {
    if (raw.length === 0)
      return []
    const encoded = raw.split('||')
    const variants: Array<{ query: string | undefined, clicks: number, impressions: number, position: number }> = []
    for (const value of encoded) {
      if (value.length === 0)
        continue
      const parts = value.split(':::')
      variants.push({
        query: parts[0],
        clicks: Number(parts[1] || 0),
        impressions: Number(parts[2] || 0),
        position: Number(parts[3] || 0),
      })
    }
    return variants
  }

  for (const { key, results } of extrasResults) {
    if (key === 'canonicalExtras') {
      const map = new Map<string, CanonicalExtra>()
      for (const r of results) {
        const jk = String(r.joinKey)
        const raw = r.variants
        map.set(jk, {
          variantCount: r.variantCount,
          variants: typeof raw === 'string' ? parseVariants(raw) : [],
          canonicalName: r.canonicalName,
        })
      }
      lookups.push({ kind: 'canonical', map })
      continue
    }

    const map = new Map<string, unknown>()
    for (const r of results) {
      if (r.rn !== undefined && r.rn !== 1)
        continue
      let val = r[key]
      if (key === 'variants' && typeof val === 'string')
        val = parseVariants(val)
      map.set(String(r.joinKey), val)
    }
    lookups.push({ kind: 'generic', key, map })
  }

  return rows.map((row) => {
    const enriched = { ...row }
    for (const lookup of lookups) {
      if (lookup.kind === 'canonical') {
        const joinValue = String(row.queryCanonical ?? row.query_canonical ?? '')
        const extra = joinValue ? lookup.map.get(joinValue) : undefined
        enriched.variantCount = extra?.variantCount ?? null
        enriched.variants = extra?.variants ?? []
        enriched.canonicalName = extra?.canonicalName ?? null
        if (enriched.canonicalName)
          enriched.queryCanonical = enriched.canonicalName
        continue
      }

      const { key, map } = lookup
      const joinValue = key === 'variantCount' || key === 'variants' || key === 'canonicalName'
        ? String(row.queryCanonical ?? row.query_canonical ?? '')
        : undefined
      enriched[key] = (joinValue && map.get(joinValue)) ?? (key === 'variants' ? [] : null)
      if (key === 'canonicalName' && enriched[key])
        enriched.queryCanonical = enriched[key]
    }
    return enriched
  })
}

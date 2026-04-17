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
  FilterInput,
  InternalFilter,
  Metric,
} from 'gscdump/query'
import type {
  ComparisonFilter,
  ExtraQuery,
  ResolvedComparisonSQL,
  ResolvedSQL,
  ResolvedSQLOptimized,
  ResolverOptions,
} from './types'

import { sql } from 'drizzle-orm'
import {
  extractDateRange,
  extractMetricFilters,
  extractSpecialOperatorFilters,
} from 'gscdump/query'

const COMPARISON_FILTER_SQL: Record<ComparisonFilter, SQL> = {
  new: sql`AND (p.impressions IS NULL OR p.impressions = 0)`,
  lost: sql`AND p.impressions > 0 AND c.impressions = 0`,
  improving: sql`AND c.clicks > COALESCE(p.clicks, 0)`,
  declining: sql`AND c.clicks < p.clicks AND p.clicks > 0`,
}

function getInternalFilters(filter: FilterInput | undefined): InternalFilter[] {
  if (!filter || !('_filters' in filter))
    return []
  return filter._filters as InternalFilter[]
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

// ORDER BY is safe-stripped because `column` / `dir` come from `BuilderState`
// (typed union) but we still guard against raw strings reaching SQL.
function orderByClause(state: BuilderState, prefix: string = ''): SQL {
  if (state.orderBy) {
    const safeCol = state.orderBy.column.replace(/\W/g, '')
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

function aliasRaw(name: string): SQL {
  const safe = name.replace(/\W/g, '')
  return sql.raw(safe)
}

interface BuiltScope<TK extends string> {
  tableKey: TK
  groupByDims: Dimension[]
  hasDate: boolean
  metrics: readonly Metric[]
  wherePredicates: SQL[]
  having: SQL[]
  dimFilters: InternalFilter[]
  startDate?: string
  endDate?: string
}

// Shared scope extracted from a BuilderState + adapter. Optional siteId is
// appended to the WHERE set only when the adapter exposes `siteIdColRef`.
function buildScope<TK extends string>(
  state: BuilderState,
  options: ResolverOptions<TK>,
): BuiltScope<TK> {
  const { adapter, siteId } = options
  const { startDate, endDate } = extractDateRange(state.filter)
  const metricFilters = extractMetricFilters(state.filter)
  const specialFilters = extractSpecialOperatorFilters(state.filter)
  const allInternalFilters = getInternalFilters(state.filter)
  const dimFilters = allInternalFilters.filter(f =>
    f.dimension !== 'date'
    && !adapter.isMetricDimension(f.dimension)
    && f.operator !== 'topLevel'
    && !f.operator.startsWith('metric'),
  )
  const filterDims = dimFilters.map(f => f.dimension as Dimension)
  const tableKey = adapter.inferTable(state.dimensions, filterDims)

  const groupByDims = state.dimensions.filter(d => d !== 'date')
  const hasDate = state.dimensions.includes('date')
  const metrics = state.metrics ?? adapter.METRIC_NAMES

  const wherePredicates: SQL[] = []
  if (adapter.siteIdColRef && siteId != null)
    wherePredicates.push(sql`${adapter.siteIdColRef(tableKey)} = ${siteId}`)
  if (startDate)
    wherePredicates.push(sql`${adapter.dateColRef(tableKey)} >= ${startDate}`)
  if (endDate)
    wherePredicates.push(sql`${adapter.dateColRef(tableKey)} <= ${endDate}`)
  wherePredicates.push(...adapter.dimensionPredicates(dimFilters, tableKey))
  const tl = adapter.topLevelPredicate(specialFilters, tableKey)
  if (tl)
    wherePredicates.push(tl)

  const having = adapter.havingPredicates(metricFilters, tableKey)

  return {
    tableKey,
    groupByDims,
    hasDate,
    metrics,
    wherePredicates,
    having,
    dimFilters,
    startDate,
    endDate,
  }
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
  const { adapter } = options
  const { tableKey, groupByDims, hasDate, metrics, wherePredicates, having } = buildScope(state, options)
  const table = adapter.tableRef(tableKey)
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
  const t = schema[tableKey]
  cteSelect.push(sql`SUM(${t.clicks}) as clicks`)
  cteSelect.push(sql`SUM(${t.impressions}) as impressions`)
  cteSelect.push(sql`SUM(${t.sum_position}) as sum_position`)

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
        outerTotals.push(sql.raw('SUM(clicks) OVER() as totalClicks'))
        break
      case 'impressions':
        outerSelect.push(sql.raw('impressions'))
        outerTotals.push(sql.raw('SUM(impressions) OVER() as totalImpressions'))
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
  outerSelect.push(sql.raw('COUNT(*) OVER() as totalCount'))
  for (const totalExpr of outerTotals) outerSelect.push(totalExpr)

  let cte = wherePredicates.length > 0
    ? sql`SELECT ${joinComma(cteSelect)} FROM ${table} WHERE ${joinAnd(wherePredicates)}`
    : sql`SELECT ${joinComma(cteSelect)} FROM ${table}`
  if (groupByExprs.length > 0)
    cte = sql`${cte} GROUP BY ${joinComma(groupByExprs)}`
  if (having.length > 0)
    cte = sql`${cte} HAVING ${joinAnd(having)}`

  const query = sql`WITH aggregated AS (${cte}) SELECT ${joinComma(outerSelect)} FROM aggregated ${orderByClause(state)} ${limitOffsetClause(state)}`
  return compileCollapsed(adapter, query)
}

export function resolveToSQL<TK extends string>(
  state: BuilderState,
  options: ResolverOptions<TK>,
): ResolvedSQL {
  const { adapter } = options
  const { tableKey, groupByDims, hasDate, metrics, wherePredicates, having } = buildScope(state, options)
  const table = adapter.tableRef(tableKey)

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
  const { adapter } = options
  const { tableKey, metrics, wherePredicates } = buildScope(state, options)
  const table = adapter.tableRef(tableKey)
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
  const { adapter, siteId } = options
  const currentScope = buildScope(current, options)
  const previousScope = buildScope(previous, options)
  const { tableKey, groupByDims, metrics, wherePredicates: currentWhere, having } = currentScope
  const table = adapter.tableRef(tableKey)

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
  if (previousScope.startDate)
    prevWhere.push(sql`${adapter.dateColRef(tableKey)} >= ${previousScope.startDate}`)
  if (previousScope.endDate)
    prevWhere.push(sql`${adapter.dateColRef(tableKey)} <= ${previousScope.endDate}`)
  prevWhere.push(...adapter.dimensionPredicates(currentScope.dimFilters, tableKey))

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

  const orderSql = orderByClause(current, 'c.')
  const limitSql = limitOffsetClause(current)

  const mainQuery = sql`WITH current AS (${currentCte}), previous AS (${previousCte}) SELECT c.*, COALESCE(p.clicks, 0) as prevClicks, COALESCE(p.impressions, 0) as prevImpressions, COALESCE(p.ctr, 0) as prevCtr, COALESCE(p.position, 0) as prevPosition FROM current c LEFT JOIN previous p ON ${joinOn} WHERE 1=1 ${filterClause} ${orderSql} ${limitSql}`

  const firstGroupBy = groupByDims[0] ? groupByDims[0].replace(/\W/g, '') : 'clicks'
  const countInnerSelect = sql.raw(`c.${firstGroupBy}`)
  const countQuery = sql`WITH current AS (${currentCte}), previous AS (${previousCte}) SELECT COUNT(*) as total FROM (SELECT ${countInnerSelect} FROM current c LEFT JOIN previous p ON ${joinOn} WHERE 1=1 ${filterClause})`

  const main = compileCollapsed(adapter, mainQuery)
  const count = compileCollapsed(adapter, countQuery)
  return { sql: main.sql, params: main.params, countSql: count.sql, countParams: count.params }
}

// Canonical-variant enrichment — lazily fetched alongside the main query when
// `queryCanonical` appears in dimensions.
export function buildExtrasQueries<TK extends string>(
  state: BuilderState,
  options: ResolverOptions<TK>,
): ExtraQuery[] {
  const { adapter, siteId } = options
  const dims = state.dimensions.filter(d => d !== 'date')
  const { startDate, endDate } = extractDateRange(state.filter)
  const extras: ExtraQuery[] = []

  const hasQueryCanonical = dims.includes('queryCanonical')
  if (!hasQueryCanonical)
    return extras

  const keywordsKey = adapter.inferTable(['queryCanonical'] as Dimension[]) as TK
  const schema = adapter.schema as Record<string, Record<string, SQL>>
  const t = schema[keywordsKey]
  const table = adapter.tableRef(keywordsKey)

  const whereParts: SQL[] = []
  if (adapter.siteIdColRef && siteId != null)
    whereParts.push(sql`${adapter.siteIdColRef(keywordsKey)} = ${siteId}`)
  if (startDate)
    whereParts.push(sql`${adapter.dateColRef(keywordsKey)} >= ${startDate}`)
  if (endDate)
    whereParts.push(sql`${adapter.dateColRef(keywordsKey)} <= ${endDate}`)

  const whereExpr = whereParts.length > 0 ? sql`WHERE ${joinAnd(whereParts)}` : sql``
  const outerQueryCol = sql.raw('query')
  const q = sql`WITH per_variant AS (SELECT ${t.query_canonical} as joinKey, ${t.query} as query, SUM(${t.clicks}) as clicks, SUM(${t.impressions}) as impressions, SUM(${t.sum_position}) as sum_pos, ROW_NUMBER() OVER (PARTITION BY ${t.query_canonical} ORDER BY SUM(${t.clicks}) DESC) as rn, COUNT(*) OVER (PARTITION BY ${t.query_canonical}) as variantCount FROM ${table} ${whereExpr} GROUP BY ${t.query_canonical}, ${t.query}) SELECT joinKey, MAX(variantCount) as variantCount, MAX(CASE WHEN rn = 1 THEN ${outerQueryCol} END) as canonicalName, GROUP_CONCAT(CASE WHEN rn <= 10 THEN ${outerQueryCol} || ':::' || clicks || ':::' || impressions || ':::' || CAST(ROUND(CAST(sum_pos AS REAL) / NULLIF(impressions, 0) + 1, 1) AS TEXT) END, '||') as variants FROM per_variant GROUP BY joinKey`

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

  const lookups: { key: string, map: Map<string, unknown> }[] = []

  for (const { key, results } of extrasResults) {
    if (key === 'canonicalExtras') {
      const variantCountMap = new Map<string, unknown>()
      const variantsMap = new Map<string, unknown>()
      const canonicalNameMap = new Map<string, unknown>()
      for (const r of results) {
        const jk = String(r.joinKey)
        variantCountMap.set(jk, r.variantCount)
        canonicalNameMap.set(jk, r.canonicalName)
        const raw = r.variants
        variantsMap.set(jk, typeof raw === 'string'
          ? raw.split('||').filter(Boolean).map((v) => {
              const parts = v.split(':::')
              return { query: parts[0], clicks: Number(parts[1] || 0), impressions: Number(parts[2] || 0), position: Number(parts[3] || 0) }
            })
          : [])
      }
      lookups.push({ key: 'variantCount', map: variantCountMap })
      lookups.push({ key: 'variants', map: variantsMap })
      lookups.push({ key: 'canonicalName', map: canonicalNameMap })
      continue
    }

    const filtered = results.filter((r: any) => r.rn === undefined || r.rn === 1)
    const map = new Map<string, unknown>()
    for (const r of filtered) {
      let val = r[key]
      if (key === 'variants' && typeof val === 'string') {
        val = val.split('||').filter(Boolean).map((v) => {
          const parts = v.split(':::')
          return { query: parts[0], clicks: Number(parts[1] || 0), impressions: Number(parts[2] || 0), position: Number(parts[3] || 0) }
        })
      }
      map.set(String(r.joinKey), val)
    }
    lookups.push({ key, map })
  }

  return rows.map((row) => {
    const enriched = { ...row }
    for (const { key, map } of lookups) {
      let joinValue: string | undefined
      if (key === 'variantCount' || key === 'variants' || key === 'canonicalName')
        joinValue = String(row.queryCanonical ?? row.query_canonical ?? '')

      enriched[key] = (joinValue && map.get(joinValue)) ?? (key === 'variants' ? [] : null)

      if (key === 'canonicalName' && enriched[key])
        enriched.queryCanonical = enriched[key]
    }
    return enriched
  })
}

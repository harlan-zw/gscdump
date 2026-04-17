import type { BuilderState, Dimension, FilterInput, InternalFilter, Metric } from '../query/types'
import type { TableName } from './storage'
import { extractDateRange, extractMetricFilters, extractSpecialOperatorFilters } from '../query/resolver'
import { enumeratePartitions } from './compaction'
import { dimensionToColumn } from './schema'

export interface ResolvedQuery {
  sql: string
  params: unknown[]
  partitions: string[]
  table: TableName
  filesPlaceholder: string
}

export const FILES_PLACEHOLDER = '{{FILES}}'

const METRIC_NAMES: Metric[] = ['clicks', 'impressions', 'ctr', 'position']
// DuckDB SUM over INT32 returns BIGINT, which loses through the RPC+JSON
// boundary (BigInt isn't JSON-safe; Workers RPC delivers null). Cast
// everything JSON-safe at the SQL layer so consumers get plain numbers.
const METRIC_EXPR: Record<Metric, string> = {
  clicks: 'CAST(SUM(clicks) AS DOUBLE)',
  impressions: 'CAST(SUM(impressions) AS DOUBLE)',
  ctr: 'CAST(SUM(clicks) AS DOUBLE) / NULLIF(SUM(impressions), 0)',
  position: 'SUM(sum_position) / NULLIF(SUM(impressions), 0) + 1',
}

function isMetricDim(s: string): s is Metric {
  return METRIC_NAMES.includes(s as Metric)
}

function getInternalFilters(filter: FilterInput | undefined): InternalFilter[] {
  if (!filter || !('_filters' in filter))
    return []
  const flat = (filter._filters as InternalFilter[]) ?? []
  const nested = ('_nestedGroups' in filter && filter._nestedGroups)
    ? filter._nestedGroups.flatMap(g => getInternalFilters(g))
    : []
  return [...flat, ...nested]
}

function escapeLike(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_')
}

function buildDimensionWhere(
  filters: InternalFilter[],
  table: TableName,
): { clause: string, params: unknown[] } {
  const clauses: string[] = []
  const params: unknown[] = []

  for (const f of filters) {
    if (isMetricDim(f.dimension))
      continue
    if (f.dimension === 'date')
      continue
    if (f.operator === 'topLevel' || f.operator.startsWith('metric'))
      continue

    const col = dimensionToColumn(f.dimension, table)
    switch (f.operator) {
      case 'equals':
        clauses.push(`${col} = ?`)
        params.push(f.expression)
        break
      case 'notEquals':
        clauses.push(`${col} != ?`)
        params.push(f.expression)
        break
      case 'contains':
        clauses.push(`${col} LIKE ? ESCAPE '\\'`)
        params.push(`%${escapeLike(f.expression)}%`)
        break
      case 'notContains':
        clauses.push(`${col} NOT LIKE ? ESCAPE '\\'`)
        params.push(`%${escapeLike(f.expression)}%`)
        break
      case 'includingRegex':
        clauses.push(`regexp_matches(${col}, ?)`)
        params.push(f.expression)
        break
      case 'excludingRegex':
        clauses.push(`NOT regexp_matches(${col}, ?)`)
        params.push(f.expression)
        break
    }
  }

  return { clause: clauses.join(' AND '), params }
}

function buildTopLevelWhere(filters: InternalFilter[], table: TableName): string {
  const hasTopLevel = filters.some(f => f.operator === 'topLevel')
  if (!hasTopLevel)
    return ''
  const col = dimensionToColumn('page', table)
  return `LENGTH(${col}) - LENGTH(REPLACE(${col}, '/', '')) <= 1`
}

function buildHaving(filters: InternalFilter[]): { clause: string, params: unknown[] } {
  if (filters.length === 0)
    return { clause: '', params: [] }

  const clauses: string[] = []
  const params: unknown[] = []
  for (const f of filters) {
    const expr = METRIC_EXPR[f.dimension as Metric]
    if (!expr)
      continue
    switch (f.operator) {
      case 'metricGte':
        clauses.push(`${expr} >= ?`)
        params.push(Number(f.expression))
        break
      case 'metricGt':
        clauses.push(`${expr} > ?`)
        params.push(Number(f.expression))
        break
      case 'metricLte':
        clauses.push(`${expr} <= ?`)
        params.push(Number(f.expression))
        break
      case 'metricLt':
        clauses.push(`${expr} < ?`)
        params.push(Number(f.expression))
        break
      case 'metricBetween':
        clauses.push(`${expr} >= ? AND ${expr} <= ?`)
        params.push(Number(f.expression), Number(f.expression2!))
        break
    }
  }

  return {
    clause: clauses.length > 0 ? `HAVING ${clauses.join(' AND ')}` : '',
    params,
  }
}

export function resolveToSQL(state: BuilderState, table: TableName): ResolvedQuery {
  const { startDate, endDate } = extractDateRange(state.filter)
  if (!startDate || !endDate)
    throw new Error('query requires date range (use between(date, ...) or gte/lte)')

  const partitions = enumeratePartitions(startDate, endDate)
  const metricFilters = extractMetricFilters(state.filter)
  const specialFilters = extractSpecialOperatorFilters(state.filter)
  const allFilters = getInternalFilters(state.filter)

  const groupByDims = state.dimensions.filter((d): d is Dimension => d !== 'date')
  const hasDate = state.dimensions.includes('date')

  const metrics = state.metrics ?? METRIC_NAMES
  const metricSelects = metrics.map(m => `${METRIC_EXPR[m]} AS ${m}`)

  const dimSelects = groupByDims.map((d) => {
    const col = dimensionToColumn(d, table)
    return col !== d ? `${col} AS ${d}` : d
  })

  const whereClauses: string[] = ['date >= ?', 'date <= ?']
  const whereParams: unknown[] = [startDate, endDate]

  const dimWhere = buildDimensionWhere(allFilters, table)
  if (dimWhere.clause) {
    whereClauses.push(dimWhere.clause)
    whereParams.push(...dimWhere.params)
  }

  const topLevelClause = buildTopLevelWhere(specialFilters, table)
  if (topLevelClause)
    whereClauses.push(topLevelClause)

  const having = buildHaving(metricFilters)

  const groupByCols = [
    ...groupByDims.map(d => dimensionToColumn(d, table)),
    ...(hasDate ? ['date'] : []),
  ]
  const groupBy = groupByCols.length > 0 ? `GROUP BY ${groupByCols.join(', ')}` : ''

  const orderBy = state.orderBy
    ? `ORDER BY ${state.orderBy.column} ${state.orderBy.dir.toUpperCase()}`
    : 'ORDER BY clicks DESC'

  const rowLimit = state.rowLimit ?? 1000
  const limit = `LIMIT ${rowLimit}`
  const offset = state.startRow ? `OFFSET ${state.startRow}` : ''

  const selectCols = [
    ...dimSelects,
    ...(hasDate ? ['date'] : []),
    ...metricSelects,
  ]

  const sql = [
    `SELECT ${selectCols.join(', ')}`,
    `FROM read_parquet(${FILES_PLACEHOLDER}, union_by_name = true)`,
    `WHERE ${whereClauses.join(' AND ')}`,
    groupBy,
    having.clause,
    orderBy,
    limit,
    offset,
  ].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim()

  return {
    sql,
    params: [...whereParams, ...having.params],
    partitions,
    table,
    filesPlaceholder: FILES_PLACEHOLDER,
  }
}

function fileList(keys: string[]): string {
  return keys.length === 0
    ? '[]'
    : `[${keys.map(k => `'${k.replace(/'/g, '\'\'')}'`).join(', ')}]`
}

/**
 * Substitute named file-list placeholders in SQL.
 * Keys in `sets` become `{{KEY}}` placeholders (e.g. `{{FILES}}`, `{{FILES_PREV}}`).
 */
export function substituteNamedFiles(sql: string, sets: Record<string, string[]>): string {
  let out = sql
  for (const [name, keys] of Object.entries(sets))
    out = out.replace(new RegExp(`\\{\\{${name}\\}\\}`, 'g'), fileList(keys))
  return out
}

import type { BuilderState } from 'gscdump/query'
import type { LogicalDimensionFilter, LogicalMetricFilter, LogicalQueryPlan } from 'gscdump/query/plan'
import type { TableName } from './storage'

import { buildLogicalPlan } from 'gscdump/query/plan'
import { enumeratePartitions } from './compaction'
import { dimensionToColumn } from './schema'
import { escapeLike, METRIC_EXPR, topLevelPagePredicateSql } from './sql-fragments'

export interface ResolvedQuery {
  sql: string
  params: unknown[]
  partitions: string[]
  table: TableName
  filesPlaceholder: string
}

export const FILES_PLACEHOLDER = '{{FILES}}'

function buildDimensionWhere(
  filters: LogicalDimensionFilter[],
  table: TableName,
): { clause: string, params: unknown[] } {
  const clauses: string[] = []
  const params: unknown[] = []

  for (const filter of filters) {
    const column = dimensionToColumn(filter.dimension, table)
    switch (filter.operator) {
      case 'equals':
        clauses.push(`${column} = ?`)
        params.push(filter.expression)
        break
      case 'notEquals':
        clauses.push(`${column} != ?`)
        params.push(filter.expression)
        break
      case 'contains':
        clauses.push(`${column} LIKE ? ESCAPE '\\'`)
        params.push(`%${escapeLike(filter.expression)}%`)
        break
      case 'notContains':
        clauses.push(`${column} NOT LIKE ? ESCAPE '\\'`)
        params.push(`%${escapeLike(filter.expression)}%`)
        break
      case 'includingRegex':
        clauses.push(`regexp_matches(${column}, ?)`)
        params.push(filter.expression)
        break
      case 'excludingRegex':
        clauses.push(`NOT regexp_matches(${column}, ?)`)
        params.push(filter.expression)
        break
    }
  }

  return { clause: clauses.join(' AND '), params }
}

function buildTopLevelWhere(plan: LogicalQueryPlan, table: TableName): string {
  if (!plan.specialFilters.topLevel)
    return ''
  return topLevelPagePredicateSql(dimensionToColumn('page', table))
}

function buildHaving(filters: LogicalMetricFilter[]): { clause: string, params: unknown[] } {
  if (filters.length === 0)
    return { clause: '', params: [] }

  const clauses: string[] = []
  const params: unknown[] = []

  for (const filter of filters) {
    const expr = METRIC_EXPR[filter.metric]
    switch (filter.operator) {
      case 'metricGte':
        clauses.push(`${expr} >= ?`)
        params.push(filter.expression)
        break
      case 'metricGt':
        clauses.push(`${expr} > ?`)
        params.push(filter.expression)
        break
      case 'metricLte':
        clauses.push(`${expr} <= ?`)
        params.push(filter.expression)
        break
      case 'metricLt':
        clauses.push(`${expr} < ?`)
        params.push(filter.expression)
        break
      case 'metricBetween':
        clauses.push(`${expr} >= ? AND ${expr} <= ?`)
        params.push(filter.expression, filter.expression2 ?? filter.expression)
        break
    }
  }

  return {
    clause: clauses.length > 0 ? `HAVING ${clauses.join(' AND ')}` : '',
    params,
  }
}

export function compileLogicalQueryPlan(
  plan: LogicalQueryPlan,
  table: TableName = plan.dataset,
): ResolvedQuery {
  const partitions = enumeratePartitions(plan.dateRange.startDate, plan.dateRange.endDate)
  const metricSelects = plan.metrics.map(metric => `${METRIC_EXPR[metric]} AS ${metric}`)

  const dimSelects = plan.groupByDimensions.map((dimension) => {
    const column = dimensionToColumn(dimension, table)
    return column !== dimension ? `${column} AS ${dimension}` : dimension
  })

  const whereClauses: string[] = ['date >= ?', 'date <= ?']
  const whereParams: unknown[] = [plan.dateRange.startDate, plan.dateRange.endDate]

  const dimWhere = buildDimensionWhere(plan.dimensionFilters, table)
  if (dimWhere.clause) {
    whereClauses.push(dimWhere.clause)
    whereParams.push(...dimWhere.params)
  }

  const topLevelClause = buildTopLevelWhere(plan, table)
  if (topLevelClause)
    whereClauses.push(topLevelClause)

  const having = buildHaving(plan.metricFilters)

  const groupByCols = [
    ...plan.groupByDimensions.map(dimension => dimensionToColumn(dimension, table)),
    ...(plan.hasDate ? ['date'] : []),
  ]
  const groupBy = groupByCols.length > 0 ? `GROUP BY ${groupByCols.join(', ')}` : ''
  const orderBy = plan.orderBy
    ? `ORDER BY ${plan.orderBy.column} ${plan.orderBy.dir.toUpperCase()}`
    : 'ORDER BY clicks DESC'
  const limit = `LIMIT ${plan.rowLimit ?? 1000}`
  const offset = plan.startRow ? `OFFSET ${plan.startRow}` : ''

  const selectCols = [
    ...dimSelects,
    ...(plan.hasDate ? ['date'] : []),
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

export function resolveParquetSQL(state: BuilderState, table?: TableName): ResolvedQuery {
  const plan = buildLogicalPlan(state, { regex: true })
  return compileLogicalQueryPlan(plan, table ?? plan.dataset)
}

function fileList(keys: string[]): string {
  return keys.length === 0
    ? '[]'
    : `[${keys.map(key => `'${key.replace(/'/g, '\'\'')}'`).join(', ')}]`
}

export function substituteNamedFiles(sql: string, sets: Record<string, string[]>): string {
  let out = sql
  for (const [name, keys] of Object.entries(sets))
    out = out.replace(new RegExp(`\\{\\{${name}\\}\\}`, 'g'), fileList(keys))
  return out
}

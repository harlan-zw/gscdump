import type { SQL } from 'drizzle-orm'
import type { Dimension, InternalFilter, Metric } from 'gscdump/query'
import type { LogicalDataset } from 'gscdump/query/plan'

import { sql } from 'drizzle-orm'
import { escapeLike } from '../sql-fragments'

import {
  inferLogicalDataset,
  LOGICAL_DATASETS,
} from './datasets'

export interface SqlFragmentsConfig<TableKey extends string> {
  schema: Record<TableKey, unknown>
  datasetToTableKey: Record<keyof typeof LOGICAL_DATASETS, TableKey>
  metricCast: 'REAL' | 'DOUBLE'
  regexPredicate: (expr: SQL, pattern: string, negate: boolean) => SQL
  tableLabel: string
  includeSiteId: boolean
  urlToPathExpr?: (col: string) => string
  /**
   * Override the FROM-clause table reference. Default emits the bound drizzle
   * table (e.g. `"pages"`). Parquet/R2 adapter overrides this to emit
   * `read_parquet({{FILES}}, ...) AS "${tk}"` so the runSQL pipeline can swap
   * in an object-key list while column refs (`"pages"."url"`) still resolve
   * against the alias.
   */
  tableRef?: (tableKey: TableKey) => SQL
}

export interface SqlFragments<TableKey extends string> {
  METRIC_NAMES: Metric[]
  DIM_COLUMN_MAP: Record<TableKey, Record<string, string>>
  isMetricDimension: (dim: string) => dim is Metric
  tableKeyForDataset: (dataset: LogicalDataset) => TableKey
  dimColumn: (dim: Dimension, table: TableKey) => string
  inferTable: (dimensions: Dimension[], filterDims?: Dimension[]) => TableKey
  urlToPathExpr: (col: string) => string
  colRef: (tableKey: TableKey, colName: string) => SQL
  tableRef: (tableKey: TableKey) => SQL
  dateColRef: (tableKey: TableKey) => SQL
  siteIdColRef?: (tableKey: TableKey) => SQL
  dimExprSql: (dim: Dimension, tableKey: TableKey) => SQL
  metricSql: (metric: Metric, tableKey: TableKey) => SQL
  havingPredicates: (filters: InternalFilter[], tableKey: TableKey) => SQL[]
  prefilterPredicates: (filters: InternalFilter[], tableKey: TableKey) => SQL[]
  dimensionPredicates: (filters: InternalFilter[], tableKey: TableKey) => SQL[]
  topLevelPredicate: (filters: InternalFilter[], tableKey: TableKey) => SQL | undefined
}

const METRIC_NAMES: Metric[] = ['clicks', 'impressions', 'ctr', 'position']

function defaultSqliteUrlToPathExpr(col: string): string {
  return `CASE WHEN ${col} LIKE 'http%' THEN CASE WHEN INSTR(SUBSTR(${col}, INSTR(${col}, '://') + 3), '/') > 0 THEN SUBSTR(${col}, INSTR(${col}, '://') + 2 + INSTR(SUBSTR(${col}, INSTR(${col}, '://') + 3), '/')) ELSE '/' END ELSE ${col} END`
}

function buildDimensionColumnMap<TableKey extends string>(
  datasetToTableKey: Record<keyof typeof LOGICAL_DATASETS, TableKey>,
): Record<TableKey, Record<string, string>> {
  const entries = Object.entries(datasetToTableKey).map(([dataset, tableKey]) => {
    const dims = LOGICAL_DATASETS[dataset as keyof typeof LOGICAL_DATASETS].dimensions
    const map = Object.fromEntries(
      Object.entries(dims).map(([dim, binding]) => [dim, binding?.column ?? dim]),
    )
    return [tableKey, map]
  })
  return Object.fromEntries(entries) as Record<TableKey, Record<string, string>>
}

export function createSqlFragments<TableKey extends string>(
  config: SqlFragmentsConfig<TableKey>,
): SqlFragments<TableKey> {
  const {
    schema,
    datasetToTableKey,
    metricCast,
    regexPredicate,
    tableLabel,
    includeSiteId,
    urlToPathExpr: urlToPathExprOverride,
    tableRef: tableRefOverride,
  } = config
  const DIM_COLUMN_MAP = buildDimensionColumnMap(datasetToTableKey)

  function isMetricDimension(dim: string): dim is Metric {
    return METRIC_NAMES.includes(dim as Metric)
  }

  function dimColumn(dim: Dimension, table: TableKey): string {
    return DIM_COLUMN_MAP[table]?.[dim] ?? dim
  }

  function tableKeyForDataset(dataset: LogicalDataset): TableKey {
    return datasetToTableKey[dataset]
  }

  function inferTable(dimensions: Dimension[], filterDims: Dimension[] = []): TableKey {
    const dataset = inferLogicalDataset(dimensions, filterDims)
    return tableKeyForDataset(dataset)
  }

  const urlToPathExpr = urlToPathExprOverride ?? defaultSqliteUrlToPathExpr

  function colRef(tableKey: TableKey, colName: string): SQL {
    const t = schema[tableKey] as unknown as Record<string, unknown>
    const c = t[colName]
    if (!c)
      throw new Error(`${tableLabel}: unknown column '${colName}' on ${tableKey}`)
    return sql`${c}`
  }

  function tableRef(tableKey: TableKey): SQL {
    if (tableRefOverride)
      return tableRefOverride(tableKey)
    return sql`${schema[tableKey]}`
  }

  function dateColRef(tableKey: TableKey): SQL {
    return colRef(tableKey, 'date')
  }

  function siteIdColRef(tableKey: TableKey): SQL {
    return colRef(tableKey, 'site_id')
  }

  function dimExprSql(dim: Dimension, tableKey: TableKey): SQL {
    const colName = dimColumn(dim, tableKey)
    if (dim === 'page')
      return sql.raw(urlToPathExpr(colName))
    return colRef(tableKey, colName)
  }

  function metricSql(metric: Metric, tableKey: TableKey): SQL {
    const t = schema[tableKey] as unknown as Record<string, SQL>
    switch (metric) {
      case 'clicks':
        return sql`CAST(SUM(${t.clicks}) AS ${sql.raw(metricCast)})`
      case 'impressions':
        return sql`CAST(SUM(${t.impressions}) AS ${sql.raw(metricCast)})`
      case 'ctr':
        return sql`CAST(SUM(${t.clicks}) AS ${sql.raw(metricCast)}) / NULLIF(SUM(${t.impressions}), 0)`
      case 'position':
        return sql`SUM(${t.sum_position}) / NULLIF(SUM(${t.impressions}), 0) + 1`
    }
  }

  function havingPredicates(filters: InternalFilter[], tableKey: TableKey): SQL[] {
    const preds: SQL[] = []
    for (const f of filters) {
      const metric = f.dimension
      if (!isMetricDimension(metric))
        continue
      const expr = metricSql(metric, tableKey)
      const v = Number(f.expression)
      switch (f.operator) {
        case 'metricGte':
          preds.push(sql`${expr} >= ${v}`)
          break
        case 'metricGt':
          preds.push(sql`${expr} > ${v}`)
          break
        case 'metricLte':
          preds.push(sql`${expr} <= ${v}`)
          break
        case 'metricLt':
          preds.push(sql`${expr} < ${v}`)
          break
        case 'metricBetween': {
          const v2 = Number(f.expression2!)
          preds.push(sql`${expr} >= ${v} AND ${expr} <= ${v2}`)
          break
        }
      }
    }
    return preds
  }

  // Row-level WHERE predicates on raw metric columns (clicks/impressions/sum_position).
  // ctr/position are derived aggregates and have no per-row equivalent — they're skipped.
  function prefilterPredicates(filters: InternalFilter[], tableKey: TableKey): SQL[] {
    const t = schema[tableKey] as unknown as Record<string, SQL>
    const preds: SQL[] = []
    for (const f of filters) {
      const metric = f.dimension
      let col: SQL | undefined
      if (metric === 'clicks')
        col = t.clicks
      else if (metric === 'impressions')
        col = t.impressions
      else if (metric === 'position')
        col = t.sum_position
      if (!col)
        continue
      const v = Number(f.expression)
      switch (f.operator) {
        case 'metricGte':
          preds.push(sql`${col} >= ${v}`)
          break
        case 'metricGt':
          preds.push(sql`${col} > ${v}`)
          break
        case 'metricLte':
          preds.push(sql`${col} <= ${v}`)
          break
        case 'metricLt':
          preds.push(sql`${col} < ${v}`)
          break
        case 'metricBetween': {
          const v2 = Number(f.expression2!)
          preds.push(sql`${col} >= ${v} AND ${col} <= ${v2}`)
          break
        }
      }
    }
    return preds
  }

  function dimensionPredicates(filters: InternalFilter[], tableKey: TableKey): SQL[] {
    const preds: SQL[] = []
    for (const f of filters) {
      if (isMetricDimension(f.dimension))
        continue
      if (f.dimension === 'date')
        continue
      if (f.operator === 'topLevel')
        continue

      const colName = dimColumn(f.dimension as Dimension, tableKey)
      const cRef = colRef(tableKey, colName)
      const matchExpr = f.dimension === 'page' ? dimExprSql(f.dimension as Dimension, tableKey) : cRef

      switch (f.operator) {
        case 'equals':
          preds.push(sql`${matchExpr} = ${f.expression}`)
          break
        case 'notEquals':
          preds.push(sql`${matchExpr} != ${f.expression}`)
          break
        case 'contains':
          preds.push(sql`${cRef} LIKE ${`%${escapeLike(f.expression)}%`} ESCAPE '\\'`)
          break
        case 'notContains':
          preds.push(sql`${cRef} NOT LIKE ${`%${escapeLike(f.expression)}%`} ESCAPE '\\'`)
          break
        case 'includingRegex':
          preds.push(regexPredicate(cRef, f.expression, false))
          break
        case 'excludingRegex':
          preds.push(regexPredicate(cRef, f.expression, true))
          break
      }
    }
    return preds
  }

  function topLevelPredicate(filters: InternalFilter[], tableKey: TableKey): SQL | undefined {
    if (!filters.some(f => f.operator === 'topLevel'))
      return undefined
    const pathExpr = dimExprSql('page', tableKey)
    return sql`LENGTH(${pathExpr}) - LENGTH(REPLACE(${pathExpr}, '/', '')) <= 1`
  }

  return {
    METRIC_NAMES,
    DIM_COLUMN_MAP,
    isMetricDimension,
    tableKeyForDataset,
    dimColumn,
    inferTable,
    urlToPathExpr,
    colRef,
    tableRef,
    dateColRef,
    siteIdColRef: includeSiteId ? siteIdColRef : undefined,
    dimExprSql,
    metricSql,
    havingPredicates,
    prefilterPredicates,
    dimensionPredicates,
    topLevelPredicate,
  }
}

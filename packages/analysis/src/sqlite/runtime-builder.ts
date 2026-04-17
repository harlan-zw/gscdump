/**
 * Runtime SQL builder for dimension/metric/filter inputs that arrive as
 * strings (e.g. user-supplied query params). Routes every column reference
 * through the typed `schema` so a column rename in this package fails to
 * compile at call sites instead of silently emitting a bad identifier.
 *
 * Mirror surface of `gscdump.com/server/utils/query-resolver.ts` helpers —
 * extracted here so future consumers (or agents) that need to turn a
 * `BuilderState` into SQL don't rediscover the same table-inference and
 * filter-to-predicate mappings.
 */

import type { SQL } from 'drizzle-orm'
import type { Dimension, InternalFilter, Metric } from 'gscdump/query'

import { sql } from 'drizzle-orm'

import { schema } from './schema'

export type TableKey = keyof typeof schema

export const METRIC_NAMES: Metric[] = ['clicks', 'impressions', 'ctr', 'position']

export function isMetricDimension(dim: string): dim is Metric {
  return METRIC_NAMES.includes(dim as Metric)
}

// Dimension-to-column mapping per table.
export const DIM_COLUMN_MAP: Record<TableKey, Record<string, string>> = {
  gsc_pages: { page: 'url' },
  gsc_keywords: { query: 'query', queryCanonical: 'query_canonical' },
  gsc_page_keywords: { page: 'url', query: 'query', queryCanonical: 'query_canonical' },
  gsc_countries: { country: 'country' },
  gsc_devices: { device: 'device' },
}

export function dimColumn(dim: Dimension, table: TableKey): string {
  return DIM_COLUMN_MAP[table]?.[dim] ?? dim
}

// Table inference from explicit + filter dimensions.
export function inferTable(dimensions: Dimension[], filterDims?: Dimension[]): TableKey {
  const allDims = new Set([...dimensions, ...(filterDims || [])])
  const has = (d: Dimension): boolean => allDims.has(d)

  if (has('page') && (has('query') || has('queryCanonical')))
    return 'gsc_page_keywords'
  if (has('query') || has('queryCanonical'))
    return 'gsc_keywords'
  if (has('page'))
    return 'gsc_pages'
  if (has('country'))
    return 'gsc_countries'
  if (has('device'))
    return 'gsc_devices'
  return 'gsc_keywords'
}

// URL normalization — expressed as a raw SQL string because drizzle can't
// type the SUBSTR/INSTR chain meaningfully. Interpolate via `sql.raw(...)`.
export function urlToPathExpr(col: string): string {
  return `CASE WHEN ${col} LIKE 'http%' THEN CASE WHEN INSTR(SUBSTR(${col}, INSTR(${col}, '://') + 3), '/') > 0 THEN SUBSTR(${col}, INSTR(${col}, '://') + 2 + INSTR(SUBSTR(${col}, INSTR(${col}, '://') + 3), '/')) ELSE '/' END ELSE ${col} END`
}

// Typed column reference via schema. Throws if the column doesn't exist so
// a schema drift fails loudly instead of emitting an unquoted identifier.
export function colRef(tableKey: TableKey, colName: string): SQL {
  const t = schema[tableKey] as unknown as Record<string, unknown>
  const c = t[colName]
  if (!c)
    throw new Error(`runtime-builder: unknown column '${colName}' on ${tableKey}`)
  return sql`${c}`
}

export function tableRef(tableKey: TableKey): SQL {
  return sql`${schema[tableKey]}`
}

export function dateColRef(tableKey: TableKey): SQL {
  return colRef(tableKey, 'date')
}

export function siteIdColRef(tableKey: TableKey): SQL {
  return colRef(tableKey, 'site_id')
}

// Dimension SELECT/GROUP BY expression. `page` gets URL→path normalization.
export function dimExprSql(dim: Dimension, tableKey: TableKey): SQL {
  const colName = dimColumn(dim, tableKey)
  if (dim === 'page')
    return sql.raw(urlToPathExpr(colName))
  return colRef(tableKey, colName)
}

// Metric aggregation fragments keyed by table. Equivalent to
// aggClicks/aggImpressions/aggCtr/aggPosition but resolved via TableKey.
export function metricSql(m: Metric, tableKey: TableKey): SQL {
  const t = schema[tableKey] as unknown as Record<string, SQL>
  switch (m) {
    case 'clicks':
      return sql`SUM(${t.clicks})`
    case 'impressions':
      return sql`SUM(${t.impressions})`
    case 'ctr':
      return sql`CAST(SUM(${t.clicks}) AS REAL) / NULLIF(SUM(${t.impressions}), 0)`
    case 'position':
      return sql`SUM(${t.sum_position}) / NULLIF(SUM(${t.impressions}), 0) + 1`
  }
}

// HAVING predicates from extracted metric filters.
export function havingPredicates(filters: InternalFilter[], tableKey: TableKey): SQL[] {
  const preds: SQL[] = []
  for (const f of filters) {
    const m = f.dimension
    if (!isMetricDimension(m))
      continue
    const expr = metricSql(m, tableKey)
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

function escapeLike(s: string): string {
  return s.replace(/%/g, '\\%').replace(/_/g, '\\_')
}

// WHERE predicates from dimension filters (excluding date/metric/topLevel).
// Callers should pre-filter to dimension-only inputs.
export function dimensionPredicates(filters: InternalFilter[], tableKey: TableKey): SQL[] {
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
      case 'includingRegex':
        preds.push(sql`${cRef} LIKE ${`%${escapeLike(f.expression)}%`} ESCAPE '\\'`)
        break
      case 'notContains':
      case 'excludingRegex':
        preds.push(sql`${cRef} NOT LIKE ${`%${escapeLike(f.expression)}%`} ESCAPE '\\'`)
        break
    }
  }
  return preds
}

// Top-level URL predicate (uses normalized path expression).
export function topLevelPredicate(filters: InternalFilter[], tableKey: TableKey): SQL | undefined {
  if (!filters.some(f => f.operator === 'topLevel'))
    return undefined
  const pathExpr = dimExprSql('page' as Dimension, tableKey)
  return sql`LENGTH(${pathExpr}) - LENGTH(REPLACE(${pathExpr}, '/', '')) <= 1`
}

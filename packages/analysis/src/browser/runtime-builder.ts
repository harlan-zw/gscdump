/**
 * Runtime SQL builder for parquet / DuckDB-WASM analytics queries.
 *
 * Mirror of {@link ../sqlite/runtime-builder.ts} but bound to the pg-core
 * schema in {@link ./schema.ts}. The schema differs in two ways:
 *   - Table names have no `gsc_` prefix (parquet uses `pages` etc.)
 *   - No `site_id` column — parquet files are single-tenant
 *
 * Queries that work against both D1 and parquet (everything the analyzers
 * need) are composed via the {@link ../query/resolver.ts} composers, which
 * take either this module or the sqlite one as their adapter.
 */

import type { SQL } from 'drizzle-orm'
import type { Dimension, InternalFilter, Metric } from 'gscdump/query'

import { sql } from 'drizzle-orm'
import { PgDialect } from 'drizzle-orm/pg-core'

import { schema } from './schema'

export type TableKey = keyof typeof schema

export const METRIC_NAMES: Metric[] = ['clicks', 'impressions', 'ctr', 'position']

export function isMetricDimension(dim: string): dim is Metric {
  return METRIC_NAMES.includes(dim as Metric)
}

export const DIM_COLUMN_MAP: Record<TableKey, Record<string, string>> = {
  pages: { page: 'url' },
  keywords: { query: 'query', queryCanonical: 'query_canonical' },
  page_keywords: { page: 'url', query: 'query', queryCanonical: 'query_canonical' },
  countries: { country: 'country' },
  devices: { device: 'device' },
}

export function dimColumn(dim: Dimension, table: TableKey): string {
  return DIM_COLUMN_MAP[table]?.[dim] ?? dim
}

export function inferTable(dimensions: Dimension[], filterDims?: Dimension[]): TableKey {
  const allDims = new Set([...dimensions, ...(filterDims || [])])
  const has = (d: Dimension): boolean => allDims.has(d)

  if (has('page') && (has('query') || has('queryCanonical')))
    return 'page_keywords'
  if (has('query') || has('queryCanonical'))
    return 'keywords'
  if (has('page'))
    return 'pages'
  if (has('country'))
    return 'countries'
  if (has('device'))
    return 'devices'
  return 'keywords'
}

// URL normalization — parquet `url` is stored as whatever GSC returned. Same
// CASE expression as the sqlite builder; DuckDB supports INSTR/SUBSTR.
export function urlToPathExpr(col: string): string {
  return `CASE WHEN ${col} LIKE 'http%' THEN CASE WHEN INSTR(SUBSTR(${col}, INSTR(${col}, '://') + 3), '/') > 0 THEN SUBSTR(${col}, INSTR(${col}, '://') + 2 + INSTR(SUBSTR(${col}, INSTR(${col}, '://') + 3), '/')) ELSE '/' END ELSE ${col} END`
}

export function colRef(tableKey: TableKey, colName: string): SQL {
  const t = schema[tableKey] as unknown as Record<string, unknown>
  const c = t[colName]
  if (!c)
    throw new Error(`browser/runtime-builder: unknown column '${colName}' on ${tableKey}`)
  return sql`${c}`
}

export function tableRef(tableKey: TableKey): SQL {
  return sql`${schema[tableKey]}`
}

export function dateColRef(tableKey: TableKey): SQL {
  return colRef(tableKey, 'date')
}

export function dimExprSql(dim: Dimension, tableKey: TableKey): SQL {
  const colName = dimColumn(dim, tableKey)
  if (dim === 'page')
    return sql.raw(urlToPathExpr(colName))
  return colRef(tableKey, colName)
}

export function metricSql(m: Metric, tableKey: TableKey): SQL {
  const t = schema[tableKey] as unknown as Record<string, SQL>
  switch (m) {
    case 'clicks':
      return sql`SUM(${t.clicks})`
    case 'impressions':
      return sql`SUM(${t.impressions})`
    case 'ctr':
      // DuckDB has DOUBLE; REAL is also accepted as an alias for FLOAT4. Keep
      // CAST to DOUBLE so the quotient stays a floating-point without truncation.
      return sql`CAST(SUM(${t.clicks}) AS DOUBLE) / NULLIF(SUM(${t.impressions}), 0)`
    case 'position':
      return sql`SUM(${t.sum_position}) / NULLIF(SUM(${t.impressions}), 0) + 1`
  }
}

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

export function topLevelPredicate(filters: InternalFilter[], tableKey: TableKey): SQL | undefined {
  if (!filters.some(f => f.operator === 'topLevel'))
    return undefined
  const pathExpr = dimExprSql('page' as Dimension, tableKey)
  return sql`LENGTH(${pathExpr}) - LENGTH(REPLACE(${pathExpr}, '/', '')) <= 1`
}

const pgDialect = new PgDialect()

/**
 * Compile a drizzle `SQL` to `{ sql, params }` using the pg-core dialect.
 * DuckDB-WASM accepts pg-style `$1` placeholders; site-side code that needs
 * `?` placeholders should use `compileSqlite` from the sqlite submodule.
 */
export function compilePg(query: SQL): { sql: string, params: unknown[] } {
  const compiled = pgDialect.sqlToQuery(query)
  return { sql: compiled.sql, params: compiled.params as unknown[] }
}

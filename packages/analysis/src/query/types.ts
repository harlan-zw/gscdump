import type { SQL } from 'drizzle-orm'
import type { Dimension, InternalFilter, Metric } from 'gscdump/query'

/**
 * Dialect-specific adapter consumed by the resolver composers. The sqlite
 * submodule provides one (D1 tables, `site_id` scoped). The browser submodule
 * provides one (parquet tables, single-tenant, no `site_id`).
 *
 * `siteIdColRef` is optional — when absent, the composers skip the site
 * predicate entirely (parquet is already single-tenant).
 */
export interface ResolverAdapter<TableKey extends string = string> {
  readonly METRIC_NAMES: readonly Metric[]
  readonly schema: Record<TableKey, unknown>
  inferTable: (dimensions: Dimension[], filterDims?: Dimension[]) => TableKey
  dimColumn: (dim: Dimension, tableKey: TableKey) => string
  isMetricDimension: (dim: string) => dim is Metric
  tableRef: (tableKey: TableKey) => SQL
  dateColRef: (tableKey: TableKey) => SQL
  siteIdColRef?: (tableKey: TableKey) => SQL
  dimExprSql: (dim: Dimension, tableKey: TableKey) => SQL
  metricSql: (metric: Metric, tableKey: TableKey) => SQL
  dimensionPredicates: (filters: InternalFilter[], tableKey: TableKey) => SQL[]
  havingPredicates: (filters: InternalFilter[], tableKey: TableKey) => SQL[]
  topLevelPredicate: (filters: InternalFilter[], tableKey: TableKey) => SQL | undefined
  compile: (query: SQL) => { sql: string, params: unknown[] }
}

export type ComparisonFilter = 'new' | 'lost' | 'improving' | 'declining'

export interface ResolverOptions<TableKey extends string = string> {
  adapter: ResolverAdapter<TableKey>
  /** Optional site scope. Required for multi-tenant D1; omitted for parquet. */
  siteId?: string | number
}

export interface ResolvedSQL {
  sql: string
  params: unknown[]
  countSql: string
  countParams: unknown[]
}

export interface ResolvedSQLOptimized {
  sql: string
  params: unknown[]
}

export interface ResolvedComparisonSQL {
  sql: string
  params: unknown[]
  countSql: string
  countParams: unknown[]
}

export interface ExtraQuery {
  key: string
  sql: string
  params: unknown[]
}

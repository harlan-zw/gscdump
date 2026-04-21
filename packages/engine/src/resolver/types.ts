/**
 * Canonical contracts for dialect-neutral SQL composition.
 *
 * `ResolverAdapter` is the only interface dialect modules (`browser/`,
 * `sqlite/`, `duckdb/`) need to satisfy. Composers in `core/compiler.ts`
 * consume it; dialect impls supply schema + regex + compile.
 *
 * `siteIdColRef` is optional — absent for single-tenant parquet, present
 * for D1 `gsc_*` tables.
 */

import type { SQL } from 'drizzle-orm'
import type { Dimension, InternalFilter, Metric } from 'gscdump/query'
import type { LogicalDataset, PlannerCapabilities } from 'gscdump/query/plan'

export interface ResolverAdapter<TableKey extends string = string> {
  readonly METRIC_NAMES: readonly Metric[]
  readonly capabilities: PlannerCapabilities
  readonly schema: Record<TableKey, unknown>
  tableKeyForDataset: (dataset: LogicalDataset) => TableKey
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

/**
 * Dialect-neutral {@link ResolverAdapter} assembly. Takes a SQL-fragment
 * builder config + dialect compile fn + planner capabilities; returns a
 * complete adapter. Dialect modules (`engine/duckdb-wasm/resolver-adapter`,
 * `engine/sqlite/resolver-adapter`) wire this with their schema + regex
 * predicate + metric cast.
 */

import type { SQL } from 'drizzle-orm'
import type { PlannerCapabilities } from 'gscdump/query/plan'

import type { SqlFragmentsConfig } from './fragments'
import type { ResolverAdapter } from './types'

import { createSqlFragments } from './fragments'

export interface CreateResolverAdapterConfig<TableKey extends string>
  extends SqlFragmentsConfig<TableKey> {
  compile: (query: SQL) => { sql: string, params: unknown[] }
  capabilities: PlannerCapabilities
}

export function createResolverAdapter<TableKey extends string>(
  config: CreateResolverAdapterConfig<TableKey>,
): ResolverAdapter<TableKey> {
  const runtime = createSqlFragments<TableKey>(config)
  return {
    METRIC_NAMES: runtime.METRIC_NAMES,
    capabilities: config.capabilities,
    schema: config.schema as Record<TableKey, unknown>,
    tableKeyForDataset: runtime.tableKeyForDataset,
    inferTable: runtime.inferTable,
    dimColumn: runtime.dimColumn,
    isMetricDimension: runtime.isMetricDimension,
    tableRef: runtime.tableRef,
    dateColRef: runtime.dateColRef,
    urlToPathExpr: runtime.urlToPathExpr,
    siteIdColRef: runtime.siteIdColRef,
    dimExprSql: runtime.dimExprSql,
    metricSql: runtime.metricSql,
    dimensionPredicates: runtime.dimensionPredicates,
    havingPredicates: runtime.havingPredicates,
    topLevelPredicate: runtime.topLevelPredicate,
    compile: config.compile,
  }
}

/**
 * Sqlite-dialect {@link ResolverAdapter} — passes to the composers in
 * `@gscdump/analysis/query`. Schema refs target the D1 `gsc_*` tables and
 * include `siteIdColRef` so multi-tenant WHERE predicates stay in play.
 */

import type { ResolverAdapter } from '../query/types'
import type { TableKey } from './runtime-builder'

import { compileSqlite } from './runner'
import {
  dateColRef,
  dimColumn,
  dimensionPredicates,
  dimExprSql,
  havingPredicates,
  inferTable,
  isMetricDimension,
  METRIC_NAMES,
  metricSql,
  siteIdColRef,
  tableRef,
  topLevelPredicate,
} from './runtime-builder'
import { schema } from './schema'

export const sqliteResolverAdapter: ResolverAdapter<TableKey> = {
  METRIC_NAMES,
  schema,
  inferTable,
  dimColumn,
  isMetricDimension,
  tableRef,
  dateColRef,
  siteIdColRef,
  dimExprSql,
  metricSql,
  dimensionPredicates,
  havingPredicates,
  topLevelPredicate,
  compile: compileSqlite,
}

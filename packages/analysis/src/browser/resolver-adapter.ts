/**
 * Browser / parquet-dialect {@link ResolverAdapter} — schema refs target the
 * pg-core tables in {@link ./schema.ts} (no `site_id`, no `gsc_` prefix).
 * `siteIdColRef` is intentionally absent; parquet files are single-tenant.
 */

import type { ResolverAdapter } from '../query/types'
import type { TableKey } from './runtime-builder'

import {
  compilePg,
  dateColRef,
  dimColumn,
  dimensionPredicates,
  dimExprSql,
  havingPredicates,
  inferTable,
  isMetricDimension,
  METRIC_NAMES,
  metricSql,
  tableRef,
  topLevelPredicate,
} from './runtime-builder'
import { schema } from './schema'

export const browserResolverAdapter: ResolverAdapter<TableKey> = {
  METRIC_NAMES,
  schema,
  inferTable,
  dimColumn,
  isMetricDimension,
  tableRef,
  dateColRef,
  dimExprSql,
  metricSql,
  dimensionPredicates,
  havingPredicates,
  topLevelPredicate,
  compile: compilePg,
}

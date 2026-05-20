/**
 * `@gscdump/engine/resolver` — dialect-neutral SQL composition kit.
 *
 * Exports the `ResolverAdapter` contract and SQL composers
 * (`resolveToSQL`, `resolveComparisonSQL`, etc). Dialect compile fns are
 * colocated with their adapters: `compilePg` is internal to `pg-adapter`;
 * `compileSqlite` lives in `@gscdump/engine-sqlite`. Source-layer types
 * and the `createSqlQuerySource` factory live in `@gscdump/engine/source`.
 *
 * Engine adapter packages (`@gscdump/engine-duckdb-wasm`, `@gscdump/engine-sqlite`)
 * and analyzer dispatch (`@gscdump/engine/analyzer`) import from here.
 */

export { createResolverAdapter } from './adapter'
export type { CreateResolverAdapterConfig } from './adapter'
export {
  buildExtrasQueries,
  buildTotalsSql,
  mergeExtras,
  resolveComparisonSQL,
  resolveToSQL,
  resolveToSQLOptimized,
} from './compile'
export {
  assertDimensionsSupported,
  DIMENSION_SURFACES,
  dimensionColumn,
  inferLogicalDataset,
  isDatasetResolvable,
  LOGICAL_DATASETS,
  supportsDimensionOnSurface,
  UnresolvableDatasetError,
} from './datasets'
export type {
  DimensionBinding,
  DimensionSurface,
  LogicalDataset,
  LogicalDatasetDefinition,
} from './datasets'
export {
  dimensionValue,
  getDimensionFilters,
  getFilterDimensions,
  getInternalFilters,
  matchesDimensionFilter,
  matchesMetricFilter,
  matchesTopLevelPage,
  metricValue,
} from './filter-utils'
export { createSqlFragments } from './fragments'
export type { SqlFragments, SqlFragmentsConfig } from './fragments'
export { createParquetResolverAdapter, pgResolverAdapter } from './pg-adapter'
export type { PgTableKey } from './pg-adapter'
export type {
  ComparisonQueryResult,
  OptimizedQueryResult,
  RunQueryCtx,
  RunSQLFn,
} from './run-query'
export { runComparisonQuery, runOptimizedQuery } from './run-query'
export { assertSchemaInSync } from './schema-drift'
export type { AssertSchemaInSyncOptions } from './schema-drift'
export type {
  ComparisonFilter,
  ExtraQuery,
  ResolvedComparisonSQL,
  ResolvedSQL,
  ResolvedSQLOptimized,
  ResolverAdapter,
  ResolverOptions,
} from './types'

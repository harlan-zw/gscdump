/**
 * `@gscdump/engine/resolver` — dialect-neutral SQL composition kit.
 *
 * Exports the `ResolverAdapter` contract, dialect compile fns
 * (`compilePg`, `compileSqlite`), SQL composers (`resolveToSQL`,
 * `resolveComparisonSQL`, etc), the `createSqlQuerySource` factory, and
 * the source-layer types analyzers consume.
 *
 * Engine adapter packages (`@gscdump/engine-wasm`, `@gscdump/engine-sqlite`)
 * import from here. `@gscdump/analysis` re-exports the source types and
 * uses the composers internally.
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
} from './compiler'
export { createSqlQuerySource } from './create-sql-query-source'
export type { CreateSqlQuerySourceOptions } from './create-sql-query-source'
export {
  assertDimensionsSupported,
  DIMENSION_SURFACES,
  dimensionColumn,
  inferLogicalDataset,
  LOGICAL_DATASETS,
  supportsDimensionOnSurface,
} from './datasets'
export type {
  DimensionBinding,
  DimensionSurface,
  LogicalDataset,
  LogicalDatasetDefinition,
} from './datasets'
export { compilePg, compileSqlite } from './dialects'
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
export { assertSchemaInSync } from './schema-drift'
export type { AssertSchemaInSyncOptions } from './schema-drift'
export {
  isSqlQuerySource,
} from './source-types'
export type {
  AnalysisQuerySource,
  ExecuteSqlOptions,
  FileSet,
  QueryRow,
  RowQuerySource,
  SourceCapabilities,
  SqlQuerySource,
} from './source-types'
export type {
  ComparisonFilter,
  ExtraQuery,
  ResolvedComparisonSQL,
  ResolvedSQL,
  ResolvedSQLOptimized,
  ResolverAdapter,
  ResolverOptions,
} from './types'

export { coerceRow, coerceRows } from './coerce'
export type { CompactionThresholds } from './compaction'
export { canonicalEmptyParquetSchema, createDuckDBCodec, createDuckDBExecutor } from './duckdb'
export type { DuckDBFactory, DuckDBHandle } from './duckdb'
export { createStorageEngine, MAX_DAY_BYTES } from './engine'
// Iceberg backend (schema + catalog + append-sink) lives behind the
// `@gscdump/engine/iceberg` subpath. Node-only Iceberg writers are on
// `@gscdump/engine/sink-node`.
export type { GscApiRow, IngestOptions, RowAccumulator, RowAccumulatorOptions } from './ingest'
export { assembleDatesRow, createRowAccumulator, toPath, toSumPosition, transformGscRow } from './ingest'
export type {
  CreateIngestAccumulatorOptions,
  FinalizeOptions,
  FinalizeResult,
  IngestAccumulator,
  IngestAccumulatorCtx,
  IngestAccumulatorEngine,
  IngestAccumulatorHooks,
} from './ingest-accumulator'
export { createIngestAccumulator, createNoopIngestAccumulator } from './ingest-accumulator'
export { enumeratePartitions, FILES_PLACEHOLDER, resolveParquetSQL, substituteNamedFiles } from './planner'
export type { ResolvedQuery } from './planner'
export { createIcebergResolverAdapter, createParquetResolverAdapter, pgResolverAdapter } from './resolver/pg-adapter'
export { rebuildDailyFromHourly } from './rollups'
export type { InspectionVerdict, SchedulePolicy, ScheduleState } from './schedule'
export { fixedPolicy, inspectionPolicy, sitemapPolicy } from './schedule'
export {
  allTables,
  countries,
  currentSchemaVersion,
  dates,
  dimensionToColumn,
  drizzleSchema,
  hourly_pages,
  inferTable,
  page_queries,
  pages,
  queries,
  SCHEMAS,
  TABLE_METADATA,
} from './schema'
export type { ColumnDef, ColumnType, DrizzleSchema, TableSchema } from './schema'
export type {
  Sink,
  SinkCapabilities,
  SinkCloseResult,
  SinkOptions,
  SinkSlice,
  SinkWriteResult,
} from './sink'
export { createInMemorySink } from './sinks'
export type { InMemorySink, StoredRow } from './sinks'
export { createSqlQuerySource, ENGINE_QUERY_CAPABILITIES } from './source'
export { bindLiterals, formatLiteral } from './sql-bind'
export {
  dayPartition,
  DEFAULT_SEARCH_TYPE,
  hourPartition,
  inferLegacyTier,
  inferSearchType,
  objectKey,
} from './storage'
export type { Grain } from './storage'
export type {
  CodecCtx,
  CompactionTier,
  DataSource,
  EngineOptions,
  FileSetRef,
  GcCtx,
  ListLiveFilter,
  LockScope,
  ManifestEntry,
  ManifestPurgeResult,
  ManifestStore,
  ParquetCodec,
  PurgeFilter,
  PurgeResult,
  PurgeUrlsResult,
  QueryCtx,
  QueryExecuteOptions,
  QueryExecuteResult,
  QueryExecutor,
  QueryResult,
  Row,
  RunSQLOptions,
  SearchType,
  StorageEngine,
  SyncState,
  SyncStateDetail,
  SyncStateFilter,
  SyncStateKind,
  SyncStateScope,
  TableName,
  TenantCtx,
  Watermark,
  WatermarkFilter,
  WatermarkScope,
  WriteCtx,
  WriteResult,
} from './storage'
export type {
  DateWeight,
  SyncTableName,
  TableTier,
  TieredTableName,
} from './sync-config'
export {
  getDateWeight,
  getTablesForTier,
  getTableTier,
  MAX_GSC_PAGES_R2,
  MAX_SITEMAP_URLS_PER_SITE,
  MAX_TRACKED_URLS_PER_SITE,
  MIN_COUNTRY_IMPRESSIONS,
  MIN_SYNC_IMPRESSIONS,
  parseEnabledSearchTypes,
  ROW_LIMIT_R2,
  TABLE_TIERS,
  TABLES_BY_SEARCH_TYPE,
  TIER_PRIORITY,
  validateEnabledSearchTypes,
  WEIGHT_PRIORITY,
} from './sync-config'

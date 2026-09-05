/**
 * `@gscdump/lakehouse` — the dataset-agnostic Iceberg layer + dataset
 * registry (ADR-0021). `defineIcebergDataset` is the enforced authoring
 * surface; stable operational workflows live behind `./maintenance`, raw
 * `icebird` primitives behind `./unsafe-raw`, and provisioning behind
 * `./provisioning` (amendments 1 + 11).
 */

export {
  bigintJsonReplacer,
  coerceBigIntToNumber,
  encodeJsonBigintSafe,
  stringifyBigintSafe,
} from './bigint'

export {
  catalogCacheScope,
  connectIcebergCatalog,
  dropIcebergTables,
  ensureIcebergNamespace,
  invalidateSnapshotRef,
  listIcebergTables,
  resolveIcebergDataFiles,
} from './catalog'

export type {
  CommitRetryOptions,
  ConnectIcebergOptions,
  IcebergCatalogConfig,
  IcebergConnection,
  IcebergDataFileDateBounds,
  IcebergListedDataFile,
  IcebergPartitionSpec,
  IcebergPartitionSpecField,
  IcebergSchema,
  IcebergSchemaField,
  IcebergSortOrder,
  IcebergSortOrderField,
  IcebergTableOpResult,
  QueryProfiler,
  ResolveIcebergDataFilesOptions,
} from './catalog'

export { cacheGet, cacheGetMany, cachePut } from './catalog-cache'
export type { CatalogCache } from './catalog-cache'

export {
  defineIcebergDataset,
  deriveTableSpec,
} from './dataset'

export type {
  AppendBatchesOptions,
  AppendBatchesResult,
  AppendBatchSource,
  AppendCommitOptions,
  AppendResult,
  AppendSink,
  AppendSinkCloseResult,
  AppendSinkOptions,
  DatasetDim,
  DatasetIdentity,
  IcebergDataset,
  IcebergDatasetColumnDef,
  IcebergDatasetDef,
  IcebergDatasetLedger,
  ResolveDataFilesOptions,
} from './dataset'

export { toIcebergDayCount } from './date'

export type { ManifestCacheStats } from './manifest-cache-resolver'

export { buildManifestPartitionFilter } from './partition-prune'
export type { IcebergFieldSummary, ManifestPartitionFilter, PartitionValueMatch } from './partition-prune'

export {
  DEFAULT_PARTITION_KEY_ENCODING,
  ICEBERG_TYPE_MAP,
} from './schema'

export type {
  IcebergColumn,
  IcebergColumnType,
  IcebergPartitionField,
  IcebergPartitionTransform,
  IcebergPrimitiveType,
  IcebergS3Config,
  IcebergTableSpec,
  PartitionKeyEncoding,
} from './schema'

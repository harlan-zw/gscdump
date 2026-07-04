/**
 * `@gscdump/lakehouse` — the dataset-agnostic Iceberg layer + dataset
 * registry (ADR-0021). `defineIcebergDataset` is the enforced authoring
 * surface; raw `icebird` primitives live behind `./unsafe-raw` and
 * provisioning behind `./provisioning` (amendments 1 + 11).
 */

export {
  connectIcebergCatalog,
  dropIcebergTables,
  ensureIcebergNamespace,
  ICEBERG_TYPE_MAP,
  invalidateSnapshotRef,
  listIcebergTables,
  resolveIcebergDataFiles,
} from './catalog'

export type {
  CommitRetryOptions,
  ConnectIcebergOptions,
  IcebergCatalogConfig,
  IcebergConnection,
  IcebergListedDataFile,
  IcebergPartitionSpec,
  IcebergPartitionSpecField,
  IcebergPrimitiveType,
  IcebergSchema,
  IcebergSchemaField,
  IcebergSortOrder,
  IcebergSortOrderField,
  IcebergTableOpResult,
  QueryProfiler,
  ResolveIcebergDataFilesOptions,
} from './catalog'

export { cacheGet, cachePut } from './catalog-cache'
export type { CatalogCache } from './catalog-cache'

export {
  defineIcebergDataset,
  deriveTableSpec,
  toIcebergDayCount,
} from './dataset'

export type {
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

export { buildManifestPartitionFilter } from './partition-prune'
export type { IcebergFieldSummary, ManifestPartitionFilter, PartitionValueMatch } from './partition-prune'

export { resolvePyIcebergPython, runPyIcebergWriter } from './pyiceberg-runtime'
export type { PyIcebergWriterResult, RunPyIcebergWriterOptions } from './pyiceberg-runtime'

export {
  DEFAULT_PARTITION_KEY_ENCODING,
} from './schema'

export type {
  IcebergColumn,
  IcebergColumnType,
  IcebergPartitionField,
  IcebergPartitionTransform,
  IcebergS3Config,
  IcebergTableSpec,
  PartitionKeyEncoding,
} from './schema'

/**
 * `@gscdump/engine/iceberg` — the Iceberg storage backend surface.
 *
 * One seam for everything Iceberg: the frozen table `schema` (field ids,
 * partition spec, the canonical 5 fact tables), the REST `catalog` client
 * (`icebird`-backed connect/create/list/append), and the edge-safe
 * `IcebergAppendSink` that commits GSC fact rows directly to the R2 Data
 * Catalog.
 *
 * Edge-safe (`icebird` is Workers-first: Web Crypto SigV4, `fetch` I/O, no
 * node builtins). The Node-only PyIceberg recovery writer statically imports
 * `node:*` and lives behind `@gscdump/engine/sink-node`, NOT here.
 *
 * Consumed cross-package by `@gscdump/cloudflare` and `@gscdump/sdk`
 * (currently the `IcebergTableName` table-name union).
 */

// Iceberg sink option types are defined in the central `Sink` contract
// (`../sink`); re-exported here so the Iceberg subpath is self-contained.
export type { IcebergAppendSinkOptions } from '../sink'

export { createIcebergAppendSink } from './append-sink'
export type { IcebergAppendSink } from './append-sink'
export {
  catalogCacheScope,
  connectIcebergCatalog,
  createIcebergTables,
  dropIcebergTables,
  ensureIcebergNamespace,
  icebergAppendRetrying,
  icebergPartitionSpecFor,
  icebergSchemaFor,
  icebergSortOrderFor,
  invalidateSnapshotRef,
  isCommitRateLimited,
  listIcebergDataFiles,
  listIcebergTables,
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
  ListIcebergDataFilesOptions,
} from './catalog'
export type { CatalogCache } from './catalog'
export {
  assertIcebergTable,
  DEFAULT_PARTITION_KEY_ENCODING,
  ICEBERG_FIELD_ID_BASE,
  ICEBERG_PARTITION_COLUMNS,
  ICEBERG_PARTITION_SPEC,
  ICEBERG_SCHEMAS,
  ICEBERG_SCHEMAS_INT,
  ICEBERG_SCHEMAS_STRING,
  ICEBERG_TABLES,
  icebergPartitionColumns,
  icebergSchemasFor,
  icebergTableSpec,
  INT_SEARCH_TYPE,
  isIcebergTable,
  SEARCH_TYPE_INT,
} from './schema'
export type {
  IcebergColumn,
  IcebergColumnType,
  IcebergPartitionField,
  IcebergPartitionTransform,
  IcebergS3Config,
  IcebergTableName,
  IcebergTableSpec,
  PartitionKeyEncoding,
} from './schema'
// Low-level `icebird` primitives re-exported so the engine is the single
// `icebird` gateway: consumers reach the patched catalog read primitives
// through `@gscdump/engine/iceberg` and never depend on `icebird` (nor its
// patch) directly. `icebird` is bundled into the engine dist, so the patched
// behaviour ships with the package. Used by consumers whose tables fall outside
// the 5 fact tables' partition spec (e.g. the lighthouse/crawl cross-source
// resolver and the phase-2 hourly table provisioner).
export { icebergCreateTable, icebergManifests, restCatalogLoadTable } from 'icebird'

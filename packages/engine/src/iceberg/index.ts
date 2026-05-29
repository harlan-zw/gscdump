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
 * node builtins). The Node-only writers — `createLocalIcebergSink` and the
 * PyIceberg-backed overwrite writer — statically import `node:*` and live
 * behind `@gscdump/engine/sink-node`, NOT here.
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
  connectIcebergCatalog,
  createIcebergTables,
  dropIcebergTables,
  ensureIcebergNamespace,
  icebergAppendRetrying,
  icebergPartitionSpecFor,
  icebergSchemaFor,
  isCommitRateLimited,
  listIcebergDataFiles,
  listIcebergTables,
} from './catalog'
export type {
  CommitRetryOptions,
  IcebergCatalogConfig,
  IcebergConnection,
  IcebergListedDataFile,
  IcebergPartitionSpec,
  IcebergPartitionSpecField,
  IcebergPrimitiveType,
  IcebergSchema,
  IcebergSchemaField,
  IcebergTableOpResult,
  ListIcebergDataFilesOptions,
} from './catalog'
export {
  assertIcebergTable,
  ICEBERG_FIELD_ID_BASE,
  ICEBERG_PARTITION_COLUMNS,
  ICEBERG_PARTITION_SPEC,
  ICEBERG_SCHEMAS,
  ICEBERG_TABLES,
  icebergTableSpec,
  isIcebergTable,
} from './schema'
export type {
  IcebergColumn,
  IcebergColumnType,
  IcebergPartitionField,
  IcebergPartitionTransform,
  IcebergS3Config,
  IcebergTableName,
  IcebergTableSpec,
} from './schema'

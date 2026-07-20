/**
 * `@gscdump/engine/iceberg` — the Iceberg storage backend surface.
 *
 * GSC-specific Iceberg seam: frozen fact-table datasets/schema, GSC catalog
 * create/list/drop wrappers, and the edge-safe append sink. Dataset-agnostic
 * catalog, connection, and raw primitives live only in `@gscdump/lakehouse`.
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
  createIcebergTables,
  dropIcebergTables,
  icebergPartitionSpecFor,
  icebergSchemaFor,
  icebergSortOrderFor,
  listIcebergDataFiles,
} from './catalog'
export type {
  IcebergTableOpResult,
  ListIcebergDataFilesOptions,
} from './catalog'
export {
  assertIcebergTable,
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
  IcebergTableName,
} from './schema'

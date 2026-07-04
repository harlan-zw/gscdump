/**
 * `gsc.*` Iceberg catalog surface — GSC-specific table create/list/drop plus
 * the frozen `icebergSchemaFor`/`icebergPartitionSpecFor`/`icebergSortOrderFor`
 * derivation. The dataset-agnostic mechanics (connect, ensureNamespace, list,
 * `icebergAppendRetrying`, the data-file resolver) MOVED to
 * `@gscdump/lakehouse` (ADR-0021 "clean moves") — this module re-exports them
 * (or thinly wraps them, where the ORIGINAL return shape must be preserved)
 * so `@gscdump/engine/iceberg` consumers see NO CHANGE to their import
 * surface (non-breaking for this pass; the major-bump gut is a later release).
 */

import type { IcebergConnection, QueryProfiler } from '@gscdump/lakehouse'
import type { Result } from 'gscdump/result'
import type { EngineError } from '../errors'
import type { IcebergTableName, PartitionKeyEncoding } from './schema'
import {
  ICEBERG_TYPE_MAP,
  dropIcebergTables as lakehouseDropIcebergTables,
  resolveIcebergDataFiles,
} from '@gscdump/lakehouse'
import { err, ok } from 'gscdump/result'
import { icebergCreateTable } from 'icebird'
import { engineErrors } from '../errors'
import { TABLE_METADATA } from '../schema'

// ---------------------------------------------------------------------------
// Dataset-agnostic primitives — thin re-exports from `@gscdump/lakehouse`.
// Shapes are IDENTICAL to the engine's original bespoke interfaces (this
// module used to define them locally), so re-exporting as TYPE ALIASES is
// non-breaking for every existing `@gscdump/engine/iceberg` consumer.
// ---------------------------------------------------------------------------

export { connectIcebergCatalog, ensureIcebergNamespace, listIcebergTables } from '@gscdump/lakehouse'
export type {
  CatalogCache,
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
} from '@gscdump/lakehouse'
export { icebergAppendRetrying, isCommitRateLimited } from '@gscdump/lakehouse/unsafe-raw'

import {
  DEFAULT_PARTITION_KEY_ENCODING,
  ICEBERG_PARTITION_SPEC,
  ICEBERG_SCHEMAS,
  ICEBERG_TABLES,
  icebergSchemasFor,
} from './schema'

// ---------------------------------------------------------------------------
// GSC-specific schema/partition/sort-order derivation (frozen, Wave-1).
// ---------------------------------------------------------------------------

/**
 * Build the icebird `Schema` for one of the 9 fact tables from the frozen
 * `ICEBERG_SCHEMAS` contract. Field ids are advisory — R2 Data Catalog
 * re-assigns them on `createTable`.
 */
export function icebergSchemaFor(table: IcebergTableName, encoding: PartitionKeyEncoding = DEFAULT_PARTITION_KEY_ENCODING) {
  return {
    'type': 'struct' as const,
    'schema-id': 0,
    'fields': icebergSchemasFor(encoding)[table].columns.map(col => ({
      id: col.fieldId,
      name: col.name,
      required: col.required,
      type: ICEBERG_TYPE_MAP[col.type],
    })),
  }
}

/**
 * Build the icebird `PartitionSpec` for one of the 9 fact tables: the locked
 * spec `identity(site_id) + identity(search_type) + month(date)`.
 */
export function icebergPartitionSpecFor(table: IcebergTableName, encoding: PartitionKeyEncoding = DEFAULT_PARTITION_KEY_ENCODING) {
  const fields = icebergSchemasFor(encoding)[table].columns
  const fieldId = (name: string): number => {
    const col = fields.find(c => c.name === name)
    if (!col)
      throw new Error(`iceberg-catalog: table '${table}' has no '${name}' column`)
    return col.fieldId
  }
  return {
    'spec-id': 0,
    'fields': ICEBERG_PARTITION_SPEC.map((p, i) => ({
      'source-id': fieldId(p.sourceColumn),
      'field-id': 1000 + i,
      'name': p.name,
      'transform': p.transform,
    })),
  }
}

/**
 * Build the icebird `SortOrder` for a fact table from its `clusterKey`
 * (dimension-first, then `date`).
 */
export function icebergSortOrderFor(table: IcebergTableName, encoding: PartitionKeyEncoding = DEFAULT_PARTITION_KEY_ENCODING) {
  const fields = icebergSchemasFor(encoding)[table].columns
  const fieldId = (name: string): number => {
    const col = fields.find(c => c.name === name)
    if (!col)
      throw new Error(`iceberg-catalog: table '${table}' has no '${name}' column`)
    return col.fieldId
  }
  return {
    'order-id': 1,
    'fields': TABLE_METADATA[table].clusterKey.map(col => ({
      'source-id': fieldId(col),
      'transform': 'identity' as const,
      'direction': 'asc' as const,
      'null-order': 'nulls-last' as const,
    })),
  }
}

/**
 * Outcome of a single table create/drop: the table name plus a `Result` —
 * `Ok(void)` on success, `Err(iceberg-table-op-failed)` carrying the failure
 * message when the catalog rejects the op. Per-table so a partial
 * provisioning run is fully observable.
 */
export interface IcebergTableOpResult {
  table: string
  outcome: Result<void, EngineError>
}

/**
 * Create the global Iceberg fact tables with the locked partition spec and
 * the schema derived from {@link ICEBERG_SCHEMAS}. Per-table errors are
 * captured rather than thrown so a partial run is observable.
 */
export async function createIcebergTables(
  conn: IcebergConnection,
  tables: readonly IcebergTableName[] = ICEBERG_TABLES,
  encoding: PartitionKeyEncoding = DEFAULT_PARTITION_KEY_ENCODING,
): Promise<IcebergTableOpResult[]> {
  const results: IcebergTableOpResult[] = []
  for (const table of tables) {
    await icebergCreateTable({
      catalog: conn.catalog,
      namespace: conn.namespace,
      table,
      schema: icebergSchemaFor(table, encoding),
      partitionSpec: icebergPartitionSpecFor(table, encoding),
      sortOrder: icebergSortOrderFor(table, encoding),
    }).then(
      () => results.push({ table, outcome: ok(undefined) }),
      (e: unknown) => results.push({ table, outcome: err(engineErrors.icebergTableOpFailed('create', table, e)) }),
    )
  }
  return results
}

/**
 * Drop tables from the catalog namespace, purging their data objects.
 * Defaults to every table currently in the namespace. Delegates the walk to
 * `@gscdump/lakehouse`'s generic `dropIcebergTables`, mapping its simpler
 * `{table, ok, error?}` result back onto the engine's original `Result`-typed
 * {@link IcebergTableOpResult} contract.
 */
export async function dropIcebergTables(
  conn: IcebergConnection,
  tables?: readonly string[],
): Promise<IcebergTableOpResult[]> {
  const results = await lakehouseDropIcebergTables(conn, tables)
  return results.map(r => ({
    table: r.table,
    outcome: r.ok ? ok(undefined) : err(engineErrors.icebergTableOpFailed('drop', r.table, r.error)),
  }))
}

// ---------------------------------------------------------------------------
// Read path — GSC-specific wrapper over lakehouse's generic file resolver
// (ADR-0021 amendment 9: `listIcebergDataFiles` reclassified "parameterized
// in the move" — this keeps the ORIGINAL signature/behavior non-breaking
// while delegating the walk/prune/cache mechanics to lakehouse).
// ---------------------------------------------------------------------------

export interface ListIcebergDataFilesOptions {
  table: IcebergTableName
  /** Partition identity column. `number` for `'int'`-encoded catalogs. */
  siteId: string | number
  /** Partition identity column. `number` (int code) for `'int'`-encoded catalogs. */
  searchType: string | number
  encoding?: PartitionKeyEncoding
  range: { start: string, end: string }
  cache?: import('@gscdump/lakehouse').CatalogCache
  clock?: () => number
  profiler?: QueryProfiler
}

/**
 * List the parquet data files in the current snapshot of `table`, filtered to
 * a single partition slice `(siteId, searchType, month(date) ∈ range)`.
 */
export async function listIcebergDataFiles(
  conn: IcebergConnection,
  opts: ListIcebergDataFilesOptions,
) {
  const encoding = opts.encoding ?? DEFAULT_PARTITION_KEY_ENCODING
  // BOTH encodings must pass identity matches: a per-team catalog holds every
  // site (and search type) in the team, and the browser attaches the returned
  // file set with no site_id filter in SQL — the per-file check in
  // `resolveIcebergDataFiles` is the ONLY isolation boundary. 'int32' matches
  // are skipped by manifest-level pruning (see lakehouse's partition-prune doc)
  // but still drive that authoritative per-file check.
  const matches = encoding === 'string'
    ? [
        { field: 'site_id', value: opts.siteId, encoding: 'string' as const },
        { field: 'search_type', value: opts.searchType, encoding: 'string' as const },
      ]
    : [
        { field: 'site_id', value: opts.siteId, encoding: 'int32' as const },
        { field: 'search_type', value: opts.searchType, encoding: 'int32' as const },
      ]
  return resolveIcebergDataFiles(conn, {
    namespace: conn.namespace,
    table: opts.table,
    partitionSpec: ICEBERG_PARTITION_SPEC,
    matches,
    range: opts.range,
    cache: opts.cache,
    clock: opts.clock,
    profiler: opts.profiler,
  })
}

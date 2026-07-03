/**
 * CONTRACT — `gsc.*` Iceberg table schema + partition spec (Wave-1, frozen).
 *
 * The canonical definition of the 9 global GSC Iceberg fact tables and their
 * shared partition spec — the engine's OWN registry instance (ADR-0021
 * amendment 8: the generic type shapes moved to `@gscdump/lakehouse`; the
 * frozen `gsc.*` constants stay here). Every writer (`IcebergAppendSink`) and
 * every reader (R2 SQL, DuckDB, DuckDB-WASM) is built against this file.
 *
 * Locked decisions encoded here (POC findings 2026-05-22):
 * - GLOBAL tables — `pages`, `queries`, `countries`, `page_queries`,
 *   `dates`, plus the four `search_appearance*` tables — NOT per-site tables.
 *   Avoids the unverified R2 Data Catalog table-count limit. `dates` carries
 *   true site totals + a device pivot, replacing the old standalone `devices`
 *   table and `daily_totals` rollup. The authoritative list/count is
 *   {@link ICEBERG_TABLES}.
 * - Partition spec: `site_id` (identity) + `search_type` (identity) +
 *   `month(date)`. Filtering `site_id=` prunes cleanly; `month(date)` is an
 *   Iceberg partition TRANSFORM, not a stored column.
 *
 * Column sets are derived from `@gscdump/engine`'s `SCHEMAS` / `TABLE_METADATA`
 * (the existing drizzle pg-core schema) PLUS the two Iceberg-only partition
 * identity columns (`site_id`, `search_type`) that the bespoke parquet path
 * carried implicitly in the object-key prefix.
 *
 * TYPES + CONST DEFINITIONS ONLY — no writer/reader logic.
 */

import type { ColumnType, TableName } from '@gscdump/contracts'
import type {
  IcebergColumn,
  IcebergColumnType,
  IcebergPartitionField,
  IcebergTableSpec,
  PartitionKeyEncoding,
} from '@gscdump/lakehouse'
import type { SearchType } from '../storage'
import { DEFAULT_PARTITION_KEY_ENCODING } from '@gscdump/lakehouse'
import { SCHEMAS } from '../schema'

function mapColumnType(t: ColumnType): IcebergColumnType {
  switch (t) {
    case 'VARCHAR': return 'STRING'
    case 'INTEGER': return 'INT'
    case 'BIGINT': return 'LONG'
    case 'DOUBLE': return 'DOUBLE'
    case 'DATE': return 'DATE'
  }
}

// Generic shapes now live in `@gscdump/lakehouse` (ADR-0021 amendment 8) —
// re-exported here so existing `@gscdump/engine/iceberg` consumers see no
// change to their import surface.
export { DEFAULT_PARTITION_KEY_ENCODING } from '@gscdump/lakehouse'
export type {
  IcebergColumn,
  IcebergColumnType,
  IcebergPartitionField,
  IcebergPartitionTransform,
  IcebergS3Config,
  IcebergTableSpec,
  PartitionKeyEncoding,
} from '@gscdump/lakehouse'

/** The 9 fact tables that exist as global Iceberg tables. */
export type IcebergTableName = Extract<
  TableName,
  'pages' | 'queries' | 'countries' | 'page_queries' | 'dates' | 'search_appearance' | 'search_appearance_pages' | 'search_appearance_queries' | 'search_appearance_page_queries'
>

/** The 9 Iceberg table names, in canonical order. */
export const ICEBERG_TABLES: readonly IcebergTableName[] = [
  'pages',
  'queries',
  'countries',
  'page_queries',
  'dates',
  'search_appearance',
  'search_appearance_pages',
  'search_appearance_queries',
  'search_appearance_page_queries',
] as const

/**
 * Stable `search_type` enum → int map for `'int'`-encoded catalogs. Engine-owned
 * and FROZEN: never renumber or reuse an id (it's the on-disk partition value).
 */
export const SEARCH_TYPE_INT: Record<SearchType, number> = {
  web: 1,
  image: 2,
  video: 3,
  news: 4,
  discover: 5,
  googleNews: 6,
}

/** Reverse of {@link SEARCH_TYPE_INT} — int → `search_type`, for read-result mapping. */
export const INT_SEARCH_TYPE: Record<number, SearchType> = Object.fromEntries(
  Object.entries(SEARCH_TYPE_INT).map(([k, v]) => [v, k as SearchType]),
) as Record<number, SearchType>

/**
 * The two partition-identity columns Iceberg rows carry that the legacy
 * parquet path encoded in the object-key prefix instead. Field ids 1–2 are
 * the first two columns; per-table metric/dimension columns follow
 * contiguously from id 3 (see `ICEBERG_FIELD_ID_BASE`).
 */
export const ICEBERG_PARTITION_COLUMNS: readonly IcebergColumn[] = [
  { name: 'site_id', type: 'STRING', required: true, fieldId: 1 },
  { name: 'search_type', type: 'STRING', required: true, fieldId: 2 },
] as const

/**
 * The two partition-identity columns for a given {@link PartitionKeyEncoding}.
 * `'string'` returns {@link ICEBERG_PARTITION_COLUMNS} verbatim; `'int'` swaps
 * BOTH to INT — `site_id` (the app's small `user_sites.int_id`; ≪ 2.1B sites, so
 * INT is ample) and `search_type` (its fixed enum code). Integer identity columns
 * avoid R2 SQL's truncated-string-stats equality undercount and restore pruning.
 * Field ids are unchanged (1, 2) — only the column types differ.
 */
export function icebergPartitionColumns(encoding: PartitionKeyEncoding = DEFAULT_PARTITION_KEY_ENCODING): readonly IcebergColumn[] {
  if (encoding === 'string')
    return ICEBERG_PARTITION_COLUMNS
  return [
    { name: 'site_id', type: 'INT', required: true, fieldId: 1 },
    { name: 'search_type', type: 'INT', required: true, fieldId: 2 },
  ]
}

/**
 * First field id used for per-table (non-partition) columns — immediately
 * after the two partition-identity columns (`site_id`=1, `search_type`=2).
 */
export const ICEBERG_FIELD_ID_BASE = 3

/** Shared partition spec — identical across every table. */
export const ICEBERG_PARTITION_SPEC: readonly IcebergPartitionField[] = [
  { sourceColumn: 'site_id', transform: 'identity', name: 'site_id' },
  { sourceColumn: 'search_type', transform: 'identity', name: 'search_type' },
  { sourceColumn: 'date', transform: 'month', name: 'date_month' },
] as const

/**
 * Derive the full Iceberg table spec for a table from the engine `SCHEMAS`
 * (drizzle-derived column set) plus the shared partition-identity columns.
 * Field ids are assigned deterministically from `ICEBERG_FIELD_ID_BASE` in
 * column declaration order so the same schema always yields the same ids.
 *
 * CONTRACT NOTE: implementation agents must treat the RETURNED VALUE as the
 * source of truth — do not hand-list columns elsewhere.
 */
export function icebergTableSpec(table: IcebergTableName, encoding: PartitionKeyEncoding = DEFAULT_PARTITION_KEY_ENCODING): IcebergTableSpec {
  const base = SCHEMAS[table]
  const dataColumns: IcebergColumn[] = base.columns.map((col, i) => ({
    name: col.name,
    type: mapColumnType(col.type),
    required: !col.nullable,
    fieldId: ICEBERG_FIELD_ID_BASE + i,
  }))
  return {
    namespace: 'gsc',
    table,
    columns: [...icebergPartitionColumns(encoding), ...dataColumns],
    // Partition spec is type-agnostic (identity transform keyed by column NAME),
    // so it's shared across both encodings.
    partitionSpec: ICEBERG_PARTITION_SPEC,
    naturalKey: base.sortKey,
    identityColumns: ['site_id', 'search_type', ...base.sortKey],
  }
}

/** All Iceberg table specs in legacy `'string'` encoding, keyed by table name. */
export const ICEBERG_SCHEMAS_STRING: Record<IcebergTableName, IcebergTableSpec>
  = Object.fromEntries(
    ICEBERG_TABLES.map(t => [t, icebergTableSpec(t, 'string')] as const),
  ) as Record<IcebergTableName, IcebergTableSpec>

/** All Iceberg table specs in `'int'` encoding (INT site_id + INT search_type). */
export const ICEBERG_SCHEMAS_INT: Record<IcebergTableName, IcebergTableSpec>
  = Object.fromEntries(
    ICEBERG_TABLES.map(t => [t, icebergTableSpec(t, 'int')] as const),
  ) as Record<IcebergTableName, IcebergTableSpec>

/** All Iceberg table specs for the default new-catalog encoding. */
export const ICEBERG_SCHEMAS: Record<IcebergTableName, IcebergTableSpec> = ICEBERG_SCHEMAS_INT

/** Table specs for the given encoding (`'int'` default). */
export function icebergSchemasFor(encoding: PartitionKeyEncoding = DEFAULT_PARTITION_KEY_ENCODING): Record<IcebergTableName, IcebergTableSpec> {
  return encoding === 'int' ? ICEBERG_SCHEMAS_INT : ICEBERG_SCHEMAS_STRING
}

const ICEBERG_TABLE_SET: ReadonlySet<string> = new Set(ICEBERG_TABLES)

/** True when `table` is one of the canonical {@link ICEBERG_TABLES}. */
export function isIcebergTable(table: string): table is IcebergTableName {
  return ICEBERG_TABLE_SET.has(table)
}

/**
 * Narrow an arbitrary table name to a canonical {@link IcebergTableName},
 * throwing a clear error otherwise. Guards write paths that index
 * `ICEBERG_SCHEMAS` (a `Record<IcebergTableName, …>`) — a non-canonical name
 * silently yields `undefined` there, propagating a corrupt/empty spec into the
 * Iceberg job instead of failing loudly.
 */
export function assertIcebergTable(table: string): IcebergTableName {
  if (!isIcebergTable(table)) {
    throw new Error(
      `Unknown Iceberg table '${table}'. Expected one of: ${ICEBERG_TABLES.join(', ')}`,
    )
  }
  return table
}

/**
 * Re-exported so downstream agents have one import for the searchType union
 * the partition column carries.
 */
export type { SearchType }

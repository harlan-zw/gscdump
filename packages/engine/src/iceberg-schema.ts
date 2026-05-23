/**
 * CONTRACT — Iceberg table schema + partition spec (Wave-1, frozen).
 *
 * The canonical definition of the 5 global Iceberg fact tables and their
 * shared partition spec. Every writer (`IcebergAppendSink`, `LocalIcebergSink`)
 * and every reader (R2 SQL, DuckDB, DuckDB-WASM) is built against this file.
 *
 * Locked decisions encoded here (POC findings 2026-05-22):
 * - 5 GLOBAL tables — `pages`, `queries`, `countries`, `page_queries`,
 *   `dates` — NOT per-site tables. Avoids the unverified R2 Data
 *   Catalog table-count limit. `dates` carries true site totals + a device
 *   pivot, replacing the old standalone `devices` table and `daily_totals`
 *   rollup.
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
import type { SearchType } from './storage'
import { SCHEMAS } from './schema'

/** The 6 fact tables that exist as global Iceberg tables. */
export type IcebergTableName = Extract<
  TableName,
  'pages' | 'queries' | 'countries' | 'page_queries' | 'dates' | 'search_appearance'
>

/** The 6 Iceberg table names, in canonical order. */
export const ICEBERG_TABLES: readonly IcebergTableName[] = [
  'pages',
  'queries',
  'countries',
  'page_queries',
  'dates',
  'search_appearance',
] as const

/**
 * Iceberg-native column type. Superset-mapped from the engine `ColumnType`;
 * `LONG` is Iceberg's name for 64-bit integers, `STRING` for varchar.
 */
export type IcebergColumnType = 'STRING' | 'INT' | 'LONG' | 'DOUBLE' | 'DATE'

export interface IcebergColumn {
  /** Column name as written into the Iceberg table (snake_case). */
  name: string
  type: IcebergColumnType
  /** Iceberg field nullability. Partition identity columns are never null. */
  required: boolean
  /**
   * Stable Iceberg field id. Field ids — not names — are the schema-evolution
   * identity in Iceberg; never reuse or renumber an id once a table is live.
   */
  fieldId: number
}

/** Iceberg partition transform applied to a source column. */
export type IcebergPartitionTransform = 'identity' | 'month'

export interface IcebergPartitionField {
  /** Source column the transform reads. */
  sourceColumn: 'site_id' | 'search_type' | 'date'
  transform: IcebergPartitionTransform
  /** Partition field name as it appears in Iceberg metadata. */
  name: string
}

export interface IcebergTableSpec {
  table: IcebergTableName
  columns: readonly IcebergColumn[]
  /**
   * Partition spec — shared by all 5 tables: identity(site_id),
   * identity(search_type), month(date).
   */
  partitionSpec: readonly IcebergPartitionField[]
  /**
   * Natural-key columns: a row is uniquely identified by this tuple within
   * its partition. Drives partition-overwrite revision correctness and
   * dedup. Mirrors `TABLE_METADATA[table].sortKey` plus `site_id` +
   * `search_type`.
   */
  identityColumns: readonly string[]
}

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
 * First field id used for per-table (non-partition) columns — immediately
 * after the two partition-identity columns (`site_id`=1, `search_type`=2).
 *
 * ADVISORY ONLY. The icebird spike (2026-05-22) established that R2 Data
 * Catalog's `createTable` endpoint re-assigns field ids sequentially and does
 * NOT preserve caller-supplied ids. The contiguous numbering here matches what
 * the catalog produces (`site_id`=1, `search_type`=2, data columns 3, 4, …) so
 * the contract describes reality, but ids are authoritatively assigned by the
 * catalog. Iceberg still guarantees ids are stable once a table exists.
 */
export const ICEBERG_FIELD_ID_BASE = 3

/** Shared partition spec — identical across all 5 tables. */
export const ICEBERG_PARTITION_SPEC: readonly IcebergPartitionField[] = [
  { sourceColumn: 'site_id', transform: 'identity', name: 'site_id' },
  { sourceColumn: 'search_type', transform: 'identity', name: 'search_type' },
  { sourceColumn: 'date', transform: 'month', name: 'date_month' },
] as const

function mapColumnType(t: ColumnType): IcebergColumnType {
  switch (t) {
    case 'VARCHAR': return 'STRING'
    case 'INTEGER': return 'INT'
    case 'BIGINT': return 'LONG'
    case 'DOUBLE': return 'DOUBLE'
    case 'DATE': return 'DATE'
  }
}

/**
 * Derive the full Iceberg table spec for a table from the engine `SCHEMAS`
 * (drizzle-derived column set) plus the shared partition-identity columns.
 * Field ids are assigned deterministically from `ICEBERG_FIELD_ID_BASE` in
 * column declaration order so the same schema always yields the same ids.
 *
 * CONTRACT NOTE: implementation agents must treat the RETURNED VALUE as the
 * source of truth — do not hand-list columns elsewhere.
 */
export function icebergTableSpec(table: IcebergTableName): IcebergTableSpec {
  const base = SCHEMAS[table]
  const dataColumns: IcebergColumn[] = base.columns.map((col, i) => ({
    name: col.name,
    type: mapColumnType(col.type),
    required: !col.nullable,
    fieldId: ICEBERG_FIELD_ID_BASE + i,
  }))
  return {
    table,
    columns: [...ICEBERG_PARTITION_COLUMNS, ...dataColumns],
    partitionSpec: ICEBERG_PARTITION_SPEC,
    identityColumns: ['site_id', 'search_type', ...base.sortKey],
  }
}

/** All 5 Iceberg table specs, keyed by table name. */
export const ICEBERG_SCHEMAS: Record<IcebergTableName, IcebergTableSpec>
  = Object.fromEntries(
    ICEBERG_TABLES.map(t => [t, icebergTableSpec(t)] as const),
  ) as Record<IcebergTableName, IcebergTableSpec>

/**
 * Re-exported so downstream agents have one import for the searchType union
 * the partition column carries.
 */
export type { SearchType }

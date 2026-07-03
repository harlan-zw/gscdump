/**
 * Generic Iceberg schema/partition/identity type shapes — the dataset-agnostic
 * half of `@gscdump/engine/iceberg/schema.ts` (ADR-0021, split per amendment 8).
 *
 * TYPES + PURE HELPERS ONLY. The GSC-specific frozen constants
 * (`IcebergTableName`, `ICEBERG_TABLES`, `ICEBERG_SCHEMAS`, `SEARCH_TYPE_INT`,
 * `ICEBERG_PARTITION_SPEC`) stay in the engine's own registry instance — they
 * describe ONE dataset (`gsc.*`), not the mechanism.
 */

/** S3-compatible credentials for the Iceberg warehouse object store (R2 in prod). */
export interface IcebergS3Config {
  /** S3 endpoint host (prod: the R2 S3 endpoint). */
  endpoint: string
  accessKeyId: string
  secretAccessKey: string
  /** Defaults to `'auto'` (R2's region). */
  region?: string
}

/** Iceberg-native column type. */
export type IcebergColumnType = 'STRING' | 'INT' | 'LONG' | 'DOUBLE' | 'DATE' | 'BOOLEAN'

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

/**
 * Partition-key encoding for identity columns.
 *
 * - `'string'` (legacy): identity columns are STRING. Correct, but R2 SQL's
 *   string min/max statistics are truncated in predicate pushdown, so a bare
 *   `WHERE site_id='<uuid>'` UNDERCOUNTS.
 * - `'int'`: identity columns are INT. Integer statistics are fixed-width and
 *   never truncated, so `WHERE site_id=<n>` is both correct AND prunes.
 *
 * New catalogs are provisioned `'int'`; existing legacy catalogs stay `'string'`.
 */
export type PartitionKeyEncoding = 'string' | 'int'

/** Default for new Iceberg/R2 Data Catalog tables. */
export const DEFAULT_PARTITION_KEY_ENCODING: PartitionKeyEncoding = 'int'

/** Iceberg partition transform applied to a source column. */
export type IcebergPartitionTransform = 'identity' | 'month'

export interface IcebergPartitionField {
  /** Source column the transform reads. */
  sourceColumn: string
  transform: IcebergPartitionTransform
  /** Partition field name as it appears in Iceberg metadata. */
  name: string
}

export interface IcebergTableSpec {
  namespace: string
  table: string
  columns: readonly IcebergColumn[]
  /** Partition spec — identity columns must appear here. */
  partitionSpec: readonly IcebergPartitionField[]
  /**
   * Natural-key columns: a row is uniquely identified by this tuple within
   * its partition. Drives dedupe. Per amendment 3, the FULL dedupe key is
   * identity columns + dims columns + `naturalKey` (not `naturalKey` alone —
   * identity alone would collapse rows across sites/dims).
   */
  naturalKey: readonly string[]
  /** Full dedupe identity: identity columns + dims columns + naturalKey. */
  identityColumns: readonly string[]
  /** Physical write-order columns (dimension-first) — undefined skips sort-order. */
  clusterKey?: readonly string[]
}

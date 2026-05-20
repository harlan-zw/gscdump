/**
 * Abstract schema primitives derived from the canonical drizzle pg-core
 * schema (`./drizzle-schema`). Consumers that need dialect-agnostic
 * column metadata (parquet writer, manifest versioning, planner) read
 * `SCHEMAS`; consumers that need drizzle-native tables (query builder,
 * engine-duckdb-wasm, node DuckDB adapter) import from `./drizzle-schema`.
 *
 * Deriving at module load means adding a column to a drizzle table
 * automatically updates `SCHEMAS`, no hand-maintained mirror.
 *
 * ## Schema-version migration policy
 *
 * Every `ManifestEntry` carries `schemaVersion`. The policy for evolving
 * `SCHEMAS` without rewriting historical parquet:
 *
 * 1. **Additive column changes** (new column, new nullable column): bump
 *    `TABLE_METADATA[table].schemaVersion`. Reads rely on
 *    `union_by_name = true` (enforced on every multi-file read path in
 *    `duckdb.ts`) to fill missing columns with NULL on older entries.
 *    No rewrite required.
 *
 * 2. **Type-changing or renaming changes** (column type widened, column
 *    dropped, semantics shifted): bump `schemaVersion` AND apply one of:
 *    - **Read-path cast**: planner emits version-tagged casts per entry,
 *      e.g. `if (entry.schemaVersion < N) cast(clicks AS BIGINT)`.
 *      Cheap when the cast is associative with aggregation.
 *    - **Forced rewrite**: compactor treats `schemaVersion < N` entries
 *      as rewrite candidates regardless of age, scheduled per-tenant via
 *      a `migrationsPending` watermark on `syncStates`. Required when
 *      semantics shifted (e.g. `position` definition changed upstream).
 *
 * 3. **Lockstep adapters**: `engine-sqlite` columns must stay a superset
 *    of pg-core. `assertSchemaInSync` enforces this at build time.
 *
 * Bumps land in `TABLE_METADATA`; the manifest writer stamps the new
 * version on every future write automatically. No entry is ever silently
 * migrated in place.
 */

import type { ColumnDef, ColumnType, TableName, TableSchema } from '@gscdump/contracts'

import { getTableConfig } from 'drizzle-orm/pg-core'
import { drizzleSchema, TABLE_METADATA } from './drizzle-schema'

export {
  countries,
  devices,
  drizzleSchema,
  hourly_pages,
  keywords,
  page_keywords,
  pages,
  search_appearance,
  TABLE_METADATA,
} from './drizzle-schema'
export type { DrizzleSchema } from './drizzle-schema'

function pgSqlTypeToColumnType(sqlType: string): ColumnType {
  const t = sqlType.toLowerCase()
  if (t.startsWith('varchar') || t === 'text' || t.startsWith('char'))
    return 'VARCHAR'
  if (t === 'date' || t.startsWith('timestamp'))
    return 'DATE'
  if (t.startsWith('double') || t === 'real' || t.startsWith('numeric') || t.startsWith('decimal'))
    return 'DOUBLE'
  if (t === 'bigint' || t === 'int8')
    return 'BIGINT'
  if (t === 'integer' || t === 'int' || t === 'int4' || t === 'smallint' || t === 'int2')
    return 'INTEGER'
  throw new Error(`unmapped pg type '${sqlType}' — extend pgSqlTypeToColumnType in @gscdump/engine/schema`)
}

function tableSchemaFrom(tableName: TableName): TableSchema {
  const config = getTableConfig(drizzleSchema[tableName])
  const columns: ColumnDef[] = config.columns.map(col => ({
    name: col.name,
    type: pgSqlTypeToColumnType(col.getSQLType()),
    nullable: !col.notNull,
  }))
  const meta = TABLE_METADATA[tableName]
  return {
    name: tableName,
    columns,
    sortKey: meta.sortKey,
    version: meta.version,
  }
}

const METRIC_TABLES: readonly TableName[] = ['pages', 'keywords', 'countries', 'devices', 'page_keywords', 'search_appearance', 'hourly_pages']

export const SCHEMAS: Record<TableName, TableSchema> = Object.fromEntries(
  METRIC_TABLES.map(t => [t, tableSchemaFrom(t)] as const),
) as Record<TableName, TableSchema>

export function currentSchemaVersion(table: TableName): number {
  return SCHEMAS[table].version
}

export function schemaFor(table: TableName): TableSchema {
  return SCHEMAS[table]
}

export function allTables(): readonly TableName[] {
  return METRIC_TABLES
}

export function inferTable(dimensions: readonly string[]): TableName {
  const dims = new Set(dimensions)
  const hasPage = dims.has('page')
  const hasQuery = dims.has('query')
  if (hasPage && hasQuery)
    return 'page_keywords'
  if (hasQuery)
    return 'keywords'
  if (hasPage)
    return 'pages'
  if (dims.has('country'))
    return 'countries'
  if (dims.has('device'))
    return 'devices'
  if (dims.has('searchAppearance'))
    return 'search_appearance'
  // Date-only / no-dimension queries: `devices` sums to GSC's true site total;
  // `keywords` undercounts (anonymised long-tail queries dropped).
  return 'devices'
}

export function dimensionToColumn(dim: string, _table: TableName): string {
  if (dim === 'page')
    return 'url'
  if (dim === 'queryCanonical')
    return 'query_canonical'
  return dim
}

export type { ColumnDef, ColumnType, TableSchema } from '@gscdump/contracts'

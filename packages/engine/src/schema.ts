/**
 * Abstract schema primitives derived from the canonical drizzle pg-core
 * schema (`./drizzle-schema`). Consumers that need dialect-agnostic
 * column metadata (parquet writer, manifest versioning, planner) read
 * `SCHEMAS`; consumers that need drizzle-native tables (query builder,
 * engine-wasm, node DuckDB adapter) import from `./drizzle-schema`.
 *
 * Deriving at module load means adding a column to a drizzle table
 * automatically updates `SCHEMAS` — no hand-maintained mirror.
 */

import type { ColumnDef, ColumnType, TableName, TableSchema } from 'gscdump/contracts'

import { getTableConfig } from 'drizzle-orm/pg-core'
import { drizzleSchema, TABLE_METADATA } from './drizzle-schema'

export {
  countries,
  devices,
  drizzleSchema,
  keywords,
  page_keywords,
  pages,
  TABLE_METADATA,
} from './drizzle-schema'
export type { DrizzleSchema } from './drizzle-schema'
export type { ColumnDef, ColumnType, TableSchema } from 'gscdump/contracts'

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

const METRIC_TABLES: readonly TableName[] = ['pages', 'keywords', 'countries', 'devices', 'page_keywords']

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
  return 'keywords'
}

export function dimensionToColumn(dim: string, _table: TableName): string {
  if (dim === 'page')
    return 'url'
  if (dim === 'queryCanonical')
    return 'query_canonical'
  return dim
}

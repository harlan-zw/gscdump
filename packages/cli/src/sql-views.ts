// SQL views for `gscdump query --sql`. Each synced table becomes one view
// over the Store's Parquet files, tagged with `site` and `search_type`, so a
// query can join tables and group by search type without double counting.

import type { DuckDBConnection, DuckDBType } from '@duckdb/node-api'
import type { SearchType } from 'gscdump/query'
import type { LocalStore, TableName } from './local-store'
import type { TableSource } from './table-sources'
import { DuckDBInstance, DuckDBTypeId } from '@duckdb/node-api'
import { attachParquetIndex } from '@gscdump/engine/node'
import { SCHEMAS } from '@gscdump/engine/schema'
import { allTables } from './local-store'
import { readSiteMap } from './store-sites'
import { exportColumns, groupTableSources } from './table-sources'

const RAW_SCHEMA = 'gsc_raw'

/**
 * `gsc_position(sum_position, impressions)` is the impression-weighted
 * average position. The Store keeps `sum_position` zero-based, so the
 * macro adds 1 back. Use it with GROUP BY, like any aggregate.
 */
export const GSC_POSITION_MACRO = 'CREATE OR REPLACE MACRO gsc_position(sum_position, impressions) AS SUM(sum_position) / NULLIF(SUM(impressions), 0) + 1'

export interface SqlViewScope {
  /** Limit the views to these Store site ids. Omit for every Site. */
  siteIds?: readonly string[]
  /** Limit the views to one search type. Omit for every search type. */
  searchType?: SearchType
}

export interface SqlView {
  table: TableName
  /** Columns in view order, with DuckDB types. */
  columns: Array<{ name: string, type: string }>
  /** One entry per Site and search type with synced files. Empty when the table has no synced data. */
  sources: Array<{ site: string, searchType: SearchType, files: number, rows: number }>
}

export interface SqlResult {
  columns: string[]
  rows: Array<Record<string, unknown>>
}

export interface SqlViews {
  views: SqlView[]
  /** Tables with no synced data in the scope. Their views exist but hold no rows. */
  emptyTables: TableName[]
  run: (sql: string) => Promise<SqlResult>
  close: () => void
}

/** The tables of `tables` that a query names. A table name counts when it stands alone as a word. */
export function referencedTables(sql: string, tables: readonly TableName[]): TableName[] {
  const words = new Set(sql.toLowerCase().match(/[a-z_][\w$]*/g) ?? [])
  return tables.filter(table => words.has(table))
}

/**
 * Turn one DuckDB value into a JSON-ready value. DATE becomes `YYYY-MM-DD`,
 * TIMESTAMP becomes ISO 8601, and an integer becomes a number when it fits a
 * double exactly. A larger integer stays an exact decimal string.
 */
export function toJsonValue(value: unknown, type?: DuckDBType): unknown {
  if (value === null || value === undefined)
    return null
  if (typeof value === 'bigint')
    return value >= BigInt(Number.MIN_SAFE_INTEGER) && value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : value.toString()
  if (value instanceof Date)
    return type?.typeId === DuckDBTypeId.DATE ? value.toISOString().slice(0, 10) : value.toISOString()
  if (Array.isArray(value))
    return value.map(item => toJsonValue(item))
  if (value instanceof Uint8Array)
    return value
  if (typeof value === 'object')
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, toJsonValue(item)]))
  return value
}

function emptyViewSql(table: TableName): string {
  const columns = exportColumns(table).map(column => `NULL::${column.type} AS ${column.name}`)
  return `CREATE OR REPLACE VIEW main.${table} AS SELECT ${withPageAlias(table, columns).join(', ')} WHERE false`
}

/** `page` sits next to `url`: it is the name the query builder and the Search Console API use. */
function withPageAlias(table: TableName, columns: string[]): string[] {
  const index = SCHEMAS[table].columns.findIndex(column => column.name === 'url')
  if (index === -1)
    return columns
  const at = index + 3
  return [...columns.slice(0, at), 'url AS page', ...columns.slice(at)]
}

async function viewColumns(connection: DuckDBConnection, table: TableName): Promise<Array<{ name: string, type: string }>> {
  const reader = await connection.runAndReadAll(`DESCRIBE main.${table}`)
  return reader.getRowObjectsJS().map(row => ({ name: String(row.column_name), type: String(row.column_type) }))
}

async function createViews(connection: DuckDBConnection, sources: readonly TableSource[]): Promise<void> {
  const byTable = new Map<TableName, TableSource[]>()
  for (const source of sources)
    byTable.set(source.table, [...(byTable.get(source.table) ?? []), source])

  await attachParquetIndex(async (sql) => {
    await connection.run(sql)
    return []
  }, {
    schema: RAW_SCHEMA,
    tables: Object.fromEntries([...byTable].map(([table, group]) => [table, group.map(source => ({
      urls: source.files,
      constants: { site: source.site, search_type: source.searchType },
    }))])),
  })

  for (const table of allTables()) {
    if (!byTable.has(table)) {
      await connection.run(emptyViewSql(table))
      continue
    }
    // Files written before a column existed lack it; read it as NULL. DATE
    // columns are cast because older files hold them as VARCHAR.
    const present = new Set((await connection.runAndReadAll(`DESCRIBE ${RAW_SCHEMA}.${table}`)).getRowObjectsJS().map(row => String(row.column_name)))
    const columns = exportColumns(table).map((column) => {
      if (!present.has(column.name))
        return `NULL::${column.type} AS ${column.name}`
      return column.type === 'DATE' ? `CAST(${column.name} AS DATE) AS ${column.name}` : column.name
    })
    await connection.run(`CREATE OR REPLACE VIEW main.${table} AS SELECT ${withPageAlias(table, columns).join(', ')} FROM ${RAW_SCHEMA}.${table}`)
  }
}

/** Open an in-memory DuckDB session with one view per Store table and the `gsc_position` macro. */
export async function openSqlViews(store: LocalStore, scope: SqlViewScope = {}): Promise<SqlViews> {
  const entries = await store.engine.listLive({
    userId: store.userId,
    ...(scope.searchType !== undefined ? { searchType: scope.searchType } : {}),
  })
  const siteIds = scope.siteIds ? new Set(scope.siteIds) : undefined
  const sources = groupTableSources(entries.filter(entry => !siteIds || (entry.siteId !== undefined && siteIds.has(entry.siteId))), store.dataDir, await readSiteMap(store.dataDir, store.userId))

  const instance = await DuckDBInstance.create(':memory:')
  const connection = await instance.connect()
  const close = (): void => {
    connection.closeSync()
    instance.closeSync()
  }
  try {
    await createViews(connection, sources)
    await connection.run(GSC_POSITION_MACRO)
    const views: SqlView[] = []
    for (const table of allTables()) {
      views.push({
        table,
        columns: await viewColumns(connection, table),
        sources: sources.filter(source => source.table === table).map(source => ({
          site: source.site,
          searchType: source.searchType,
          files: source.files.length,
          rows: source.rows,
        })),
      })
    }
    return {
      views,
      emptyTables: views.filter(view => view.sources.length === 0).map(view => view.table),
      async run(sql) {
        const reader = await connection.runAndReadAll(sql)
        const columns = reader.columnNames()
        const types = reader.columnTypes()
        const rows = reader.getRowsJS().map(values => Object.fromEntries(columns.map((name, index) => [name, toJsonValue(values[index], types[index])])))
        return { columns, rows }
      },
      close,
    }
  }
  catch (error) {
    close()
    throw error
  }
}

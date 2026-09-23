// The Store keeps no `site` or `search_type` column inside its Parquet files:
// both live in the manifest entry. Every reader that mixes Sites or search
// types must tag rows with them, or `SUM` adds web, image, and Discover rows
// together. `dump` and `query --sql` build their rows from these groups.

import type { ColumnDef } from '@gscdump/engine/schema'
import type { SearchType } from 'gscdump/query'
import type { ManifestEntry, TableName } from './local-store'
import path from 'node:path'
import { SCHEMAS } from '@gscdump/engine/schema'
import { decodeSiteId } from 'gscdump/tenant'

/** Parquet files of one table for one Site and one search type. */
export interface TableSource {
  table: TableName
  siteId: string
  /** Site URL, such as `sc-domain:example.com`. */
  site: string
  searchType: SearchType
  /** Absolute file paths. */
  files: string[]
  rows: number
}

/**
 * The Site URL for a Store site id.
 * Seam: the Site resolver work replaces this with the stored siteId → siteUrl map.
 */
export function siteUrlFor(siteId: string): string {
  return decodeSiteId(siteId)
}

/**
 * Group live manifest entries by table, Site, and search type. Entries
 * with no rows are left out, so no reader sees an empty file.
 */
export function groupTableSources(entries: readonly ManifestEntry[], dataDir: string): TableSource[] {
  const groups = new Map<string, TableSource>()
  for (const entry of entries) {
    if (!entry.siteId || entry.rowCount === 0)
      continue
    const searchType = entry.searchType ?? 'web'
    const key = `${entry.table}\u0000${entry.siteId}\u0000${searchType}`
    let group = groups.get(key)
    if (!group) {
      group = { table: entry.table, siteId: entry.siteId, site: siteUrlFor(entry.siteId), searchType, files: [], rows: 0 }
      groups.set(key, group)
    }
    group.files.push(path.join(dataDir, entry.objectKey))
    group.rows += entry.rowCount
  }
  return [...groups.values()].sort((a, b) =>
    a.table.localeCompare(b.table) || a.site.localeCompare(b.site) || a.searchType.localeCompare(b.searchType))
}

/** Columns every exported analytics row and SQL view carries: provenance first, then the table schema. */
export function exportColumns(table: TableName): ColumnDef[] {
  return [
    { name: 'site', type: 'VARCHAR', nullable: false },
    { name: 'search_type', type: 'VARCHAR', nullable: false },
    ...SCHEMAS[table].columns,
  ]
}

export function sqlString(value: string): string {
  return `'${value.replace(/'/g, '\'\'')}'`
}

/**
 * SELECT one source's rows with `site` and `search_type`, in schema column
 * order. `present` names the columns the files hold; a schema column that no
 * file holds reads as NULL, so older files still load. DATE columns are cast,
 * because files written before the schema enforced DATE hold VARCHAR.
 */
export function sourceSelectSql(source: TableSource, present: ReadonlySet<string>, opts: { position: boolean, dates: 'date' | 'iso' }): string {
  const columns = SCHEMAS[source.table].columns.map((column) => {
    if (!present.has(column.name))
      return `NULL::${column.type} AS ${column.name}`
    if (column.type !== 'DATE')
      return column.name
    return opts.dates === 'date'
      ? `CAST(${column.name} AS DATE) AS ${column.name}`
      : `strftime(CAST(${column.name} AS DATE), '%Y-%m-%d') AS ${column.name}`
  })
  const position = opts.position ? [`sum_position / NULLIF(impressions, 0) + 1 AS position`] : []
  return `SELECT ${sqlString(source.site)} AS site, ${sqlString(source.searchType)} AS search_type, ${[...columns, ...position].join(', ')} FROM ${readParquetSql(source.files)}`
}

export function readParquetSql(files: readonly string[]): string {
  return `read_parquet([${files.map(sqlString).join(', ')}], union_by_name = true)`
}

// Creates read-only views over a set of Parquet URLs per table. Counterpart
// to `attachSnapshotIndex` for consumers whose derived layer is Parquet (e.g.
// compacted monthly parquets + trailing dailies) rather than `.duckdb` files.
//
// No ATTACH — DuckDB's httpfs handles Parquet reads directly. One view per
// table: `CREATE VIEW main.<t> AS SELECT * FROM read_parquet([url, ...],
// union_by_name = true)`. A table can also take groups of files, each with
// constant columns (for example `site` and `search_type`), which the view
// joins with `UNION ALL BY NAME`.

import type { SnapshotQueryRunner } from './snapshot-attach'

/** Files that share constant column values, such as one Site and search type. */
export interface ParquetFileGroup {
  urls: string[]
  /** Column name → VARCHAR value added to every row of this group. */
  constants?: Record<string, string>
}

export interface AttachParquetIndexOptions {
  /**
   * Map of table name → list of Parquet URLs or local paths, or groups of
   * them. A list may mix monthly compacted files and per-day files — DuckDB
   * scans all of them with `union_by_name = true`. Empty lists and groups
   * are skipped; a table with no files gets no view.
   */
  tables: Record<string, string[] | ParquetFileGroup[]>
  /** Schema the views land under. Default `main`. */
  schema?: string
  /**
   * DuckDB httpfs can error with "Server sent back more data than expected"
   * against some proxies; `force_download=true` sidesteps it. Default true.
   */
  forceDownload?: boolean
}

export interface AttachParquetIndexResult {
  schema: string
  /** Tables for which a view was created. */
  tables: string[]
}

const IDENT_RE = /^[A-Z_][\w$]*$/i
const REMOTE_URL_RE = /^(?:https?|s3):\/\//i

function toGroups(value: string[] | ParquetFileGroup[]): ParquetFileGroup[] {
  return value.every(item => typeof item === 'string')
    ? [{ urls: value as string[] }]
    : value as ParquetFileGroup[]
}

function quote(value: string): string {
  return `'${value.replace(/'/g, '\'\'')}'`
}

function groupSelect(group: ParquetFileGroup): string {
  const constants = Object.entries(group.constants ?? {})
    .map(([name, value]) => `${quote(value)}::VARCHAR AS ${name}, `)
    .join('')
  return `SELECT ${constants}* FROM read_parquet([${group.urls.map(quote).join(', ')}], union_by_name = true)`
}

export async function attachParquetIndex(
  runner: SnapshotQueryRunner,
  opts: AttachParquetIndexOptions,
): Promise<AttachParquetIndexResult> {
  const schema = opts.schema ?? 'main'
  const forceDownload = opts.forceDownload !== false

  if (!IDENT_RE.test(schema))
    throw new TypeError(`attachParquetIndex: invalid schema identifier ${JSON.stringify(schema)}`)

  // Validate table and column names defensively — they're interpolated into SQL.
  const tables = Object.entries(opts.tables).map(([table, value]) => [table, toGroups(value).filter(group => group.urls.length > 0)] as const)
  for (const [table, groups] of tables) {
    if (!IDENT_RE.test(table))
      throw new TypeError(`attachParquetIndex: invalid table identifier ${JSON.stringify(table)}`)
    for (const name of groups.flatMap(group => Object.keys(group.constants ?? {}))) {
      if (!IDENT_RE.test(name))
        throw new TypeError(`attachParquetIndex: invalid column identifier ${JSON.stringify(name)}`)
    }
  }

  const remote = tables.some(([, groups]) => groups.some(group => group.urls.some(url => REMOTE_URL_RE.test(url))))
  if (remote) {
    await runner('LOAD httpfs').catch((cause: unknown) => {
      throw new Error('Remote files require the DuckDB httpfs extension. Install httpfs before attaching remote files.', { cause })
    })
    if (forceDownload)
      await runner('SET force_download=true')
  }

  // Ensure the target schema exists — required when callers pick anything
  // other than `main` (the default schema of the in-memory DB).
  await runner(`CREATE SCHEMA IF NOT EXISTS ${schema}`)

  const created: string[] = []
  for (const [table, groups] of tables) {
    if (groups.length === 0)
      continue
    await runner(
      `CREATE OR REPLACE VIEW ${schema}.${table} AS ${groups.map(groupSelect).join(' UNION ALL BY NAME ')}`,
    )
    created.push(table)
  }

  return { schema, tables: created }
}

// Creates read-only views over a set of Parquet URLs per table. Counterpart
// to `attachSnapshotIndex` for consumers whose derived layer is Parquet (e.g.
// compacted monthly parquets + trailing dailies) rather than `.duckdb` files.
//
// No ATTACH — DuckDB's httpfs handles Parquet reads directly. One view per
// table: `CREATE VIEW main.<t> AS SELECT * FROM read_parquet([url, ...],
// union_by_name = true)`.

import type { SnapshotQueryRunner } from './snapshot-attach'

export interface AttachParquetIndexOptions {
  /**
   * Map of table name → list of Parquet URLs. The URL list may mix monthly
   * compacted files and per-day files — DuckDB will scan all of them with
   * `union_by_name = true`. Empty lists are skipped (no view created).
   */
  tables: Record<string, string[]>
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

export async function attachParquetIndex(
  runner: SnapshotQueryRunner,
  opts: AttachParquetIndexOptions,
): Promise<AttachParquetIndexResult> {
  const schema = opts.schema ?? 'main'
  const forceDownload = opts.forceDownload !== false

  if (!IDENT_RE.test(schema))
    throw new TypeError(`attachParquetIndex: invalid schema identifier ${JSON.stringify(schema)}`)

  // Validate table names defensively — they're interpolated into SQL.
  for (const table of Object.keys(opts.tables)) {
    if (!IDENT_RE.test(table))
      throw new TypeError(`attachParquetIndex: invalid table identifier ${JSON.stringify(table)}`)
  }

  await runner('LOAD httpfs').catch(() => undefined)
  if (forceDownload)
    await runner('SET force_download=true')

  // Ensure the target schema exists — required when callers pick anything
  // other than `main` (the default schema of the in-memory DB).
  await runner(`CREATE SCHEMA IF NOT EXISTS ${schema}`)

  const created: string[] = []
  for (const [table, urls] of Object.entries(opts.tables)) {
    if (urls.length === 0)
      continue
    const escaped = urls.map(u => `'${u.replace(/'/g, '\'\'')}'`).join(', ')
    await runner(
      `CREATE OR REPLACE VIEW ${schema}.${table} AS SELECT * FROM read_parquet([${escaped}], union_by_name = true)`,
    )
    created.push(table)
  }

  return { schema, tables: created }
}

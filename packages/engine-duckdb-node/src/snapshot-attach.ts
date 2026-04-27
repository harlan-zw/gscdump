// Attaches a hot/cold DuckDB snapshot set (produced by an external builder)
// and creates UNION ALL views under a chosen schema so existing analyzers can
// run unchanged against it. Designed to run against either DuckDB-WASM
// (browser) or @duckdb/node-api (Node) — the caller supplies a runner that
// executes SQL and returns plain row objects.

import type { SnapshotIndex } from '@gscdump/engine/snapshot'

/**
 * Runs arbitrary SQL and returns rows as plain objects. Caller supplies
 * this so the function works with AsyncDuckDB (browser DuckDB-WASM) or
 * @duckdb/node-api (Node) without coupling to either.
 */
export type SnapshotQueryRunner = (sql: string) => Promise<Array<Record<string, unknown>>>

export interface AttachSnapshotOptions {
  /** Index produced by the builder. */
  index: SnapshotIndex
  /**
   * Map from filename (`cold-YYYY-MM.duckdb`, `hot.duckdb`) to an HTTPS
   * URL (typically a pre-signed R2 URL). Must contain an entry for every
   * cold month in `index.cold` and — if `index.hot` — for `hot.duckdb`.
   */
  attachUrls: Record<string, string>
  /** Schema the unified views land under. Default `main`. */
  schema?: string
  /**
   * DuckDB httpfs can error with "Server sent back more data than expected"
   * against some proxies; `force_download=true` sidesteps it. Default true.
   */
  forceDownload?: boolean
}

export interface AttachSnapshotResult {
  schema: string
  /** Aliases we ATTACH'd — e.g. ['cold_2024_09', 'cold_2024_10', 'hot']. */
  aliases: string[]
  /** Table names with a UNION view created under `schema`. */
  tables: string[]
}

const YEAR_MONTH_RE = /^\d{4}-\d{2}$/
const SCHEMA_IDENT_RE = /^[A-Z_][\w$]*$/i
const COLD_FILENAME_RE = /^cold-(\d{4}-\d{2})\.duckdb$/

/**
 * Turns a filename like `cold-2024-09.duckdb` into a valid SQL identifier
 * `cold_2024_09`. `hot.duckdb` → `hot`.
 */
export function snapshotAlias(fileName: string): string {
  if (fileName === 'hot.duckdb')
    return 'hot'
  const m = fileName.match(COLD_FILENAME_RE)
  if (!m?.[1])
    throw new TypeError(`snapshotAlias: unrecognised filename ${JSON.stringify(fileName)}`)
  return `cold_${m[1].replace('-', '_')}`
}

export async function attachSnapshotIndex(
  runner: SnapshotQueryRunner,
  opts: AttachSnapshotOptions,
): Promise<AttachSnapshotResult> {
  const { index, attachUrls } = opts
  const schema = opts.schema ?? 'main'
  const forceDownload = opts.forceDownload !== false

  if (index?.version !== 1)
    throw new TypeError(`attachSnapshotIndex: unsupported snapshot index version ${String(index?.version)}; expected 1`)
  if (!SCHEMA_IDENT_RE.test(schema))
    throw new TypeError(`attachSnapshotIndex: invalid schema identifier ${JSON.stringify(schema)}`)

  // Validate cold entries up front; never interpolate untrusted strings into
  // SQL identifiers.
  for (const ym of index.cold) {
    if (!YEAR_MONTH_RE.test(ym))
      throw new TypeError(`attachSnapshotIndex: invalid YYYY-MM entry ${JSON.stringify(ym)} in index.cold`)
  }

  // httpfs is bundled in both DuckDB-WASM and @duckdb/node-api; LOAD is a
  // no-op if already loaded. Some environments auto-load it, so we ignore
  // LOAD errors.
  await runner('LOAD httpfs').catch(() => undefined)
  if (forceDownload)
    await runner('SET force_download=true')

  const plan: Array<{ fileName: string, alias: string, url: string }> = []
  for (const ym of index.cold) {
    const fileName = `cold-${ym}.duckdb`
    const url = attachUrls[fileName]
    if (!url)
      throw new Error(`attachSnapshotIndex: attachUrls missing entry for ${fileName}`)
    plan.push({ fileName, alias: snapshotAlias(fileName), url })
  }
  if (index.hot) {
    const fileName = 'hot.duckdb'
    const url = attachUrls[fileName]
    if (!url)
      throw new Error(`attachSnapshotIndex: attachUrls missing entry for ${fileName}`)
    plan.push({ fileName, alias: snapshotAlias(fileName), url })
  }

  const aliases: string[] = []
  for (const { alias, url } of plan) {
    const escapedUrl = url.replace(/'/g, '\'\'')
    await runner(`ATTACH '${escapedUrl}' AS ${alias} (READ_ONLY)`)
    aliases.push(alias)
  }

  // Introspect which tables each attached database has. Some months may be
  // missing tables — never assume all N are present in every cold file.
  const aliasSet = new Set(aliases)
  const tableRows = await runner('SELECT database_name, table_name FROM duckdb_tables()')
  const present = new Map<string, string[]>() // table -> ordered alias list
  for (const row of tableRows) {
    const db = String(row.database_name ?? '')
    const table = String(row.table_name ?? '')
    if (!aliasSet.has(db) || !table)
      continue
    const list = present.get(table)
    if (list)
      list.push(db)
    else
      present.set(table, [db])
  }

  // Union in `index.cold` order with `hot` last (the alias ordering we built
  // `plan` with). The rows from duckdb_tables() come back in arbitrary order,
  // so re-project each table's presence list through `aliases` to get
  // deterministic union ordering.
  // `UNION ALL BY NAME` aligns columns by name across branches and fills
  // missing columns with NULL. Needed because different cold files may have
  // slightly different superset column lists (parquet written with
  // union_by_name=true picks up new columns over time), or the hot file may
  // have schema that's evolved past the oldest cold.
  const tables: string[] = []
  for (const [table, dbs] of present) {
    if (!SCHEMA_IDENT_RE.test(table))
      continue
    const dbsSet = new Set(dbs)
    const orderedDbs = aliases.filter(a => dbsSet.has(a))
    const unionSql = orderedDbs.map(db => `SELECT * FROM ${db}.${table}`).join(' UNION ALL BY NAME ')
    await runner(`CREATE OR REPLACE VIEW ${schema}.${table} AS ${unionSql}`)
    tables.push(table)
  }

  return { schema, aliases, tables }
}

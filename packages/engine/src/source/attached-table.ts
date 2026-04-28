/**
 * Attached-table query source. Wraps a runner that has the analytics tables
 * attached as views (`<schema>.<table>`) and rewrites SQL plans that emit
 * `read_parquet({{FILES_*}}, union_by_name = true)` placeholders into table
 * references before dispatch.
 *
 * Used by `analyzeInBrowser` for browser/WASM DuckDB sessions and by the
 * Node DuckDB attached-snapshot path. The runner only needs a `query`
 * function; everything else is structural.
 */

import type { Row } from '../contracts'
import type { AnalysisQuerySource, ExecuteSqlOptions, FileSet, QueryRow, SourceCapabilities } from '../resolver/source-types'

export interface AttachedTableRunner {
  /**
   * Run a query with positional (`?`) bound parameters. Return objects keyed
   * by column name. The runner MUST coerce BIGINT → number and DATE → ISO
   * string (or let the analyzer reducer normalize via `num(v)`/`str(v)`).
   */
  query: (sql: string, params?: unknown[], signal?: AbortSignal) => Promise<Row[]>
}

export interface AttachedTableSourceOptions {
  /** Schema name the exported DuckDB file was attached under — e.g. `gsc`. */
  schema: string
  /**
   * Abort in-flight queries when the caller no longer cares about the
   * result. Every `runner.query` call receives the same signal.
   */
  signal?: AbortSignal
  /**
   * List of table names actually attached to this connection. When provided,
   * `executeSql` short-circuits with a specific "table not attached" error
   * if the SQL plan references a table that isn't in this list — letting
   * callers (e.g. the analytics layer) route to cloud fallback without
   * paying the SQL execution cost. Omit to disable the check.
   */
  attachedTables?: readonly string[]
}

export class AttachedTableMissingError extends Error {
  constructor(public readonly missing: readonly string[]) {
    super(`attached-table source: required table(s) not attached: ${missing.join(', ')}`)
    this.name = 'AttachedTableMissingError'
  }
}

const ATTACHED_TABLE_CAPABILITIES: SourceCapabilities = {
  fileSets: true,
  attachedTables: true,
  regex: true,
}

/**
 * Swap `read_parquet({{KEY}}, union_by_name = true)` for `<schema>.<table>`.
 * Tolerates whitespace variation. Preserves the rest of the SQL verbatim.
 */
export function rewriteForTableSource(
  sql: string,
  schema: string,
  fileSets: Record<string, FileSet>,
): string {
  let out = sql
  for (const [key, fs] of Object.entries(fileSets)) {
    const pattern = new RegExp(
      `read_parquet\\(\\s*\\{\\{${key}\\}\\}\\s*,\\s*union_by_name\\s*=\\s*true\\s*\\)`,
      'g',
    )
    out = out.replace(pattern, `${schema}.${fs.table}`)
  }
  return out
}

export function createAttachedTableSource(
  runner: AttachedTableRunner,
  options: AttachedTableSourceOptions,
): AnalysisQuerySource {
  const { schema, signal, attachedTables } = options
  const attachedSet = attachedTables ? new Set(attachedTables) : null
  return {
    name: 'attached-table',
    capabilities: ATTACHED_TABLE_CAPABILITIES,
    async queryRows() {
      throw new Error('attached-table source: queryRows is not supported; use SQL analyzers')
    },
    async executeSql(sql: string, params?: unknown[], opts?: ExecuteSqlOptions): Promise<QueryRow[]> {
      signal?.throwIfAborted()
      const fileSets = opts?.fileSets ?? {}
      if (attachedSet) {
        const missing: string[] = []
        for (const fs of Object.values(fileSets)) {
          if (!attachedSet.has(fs.table))
            missing.push(fs.table)
        }
        if (missing.length > 0)
          throw new AttachedTableMissingError(missing)
      }
      const rewritten = rewriteForTableSource(sql, schema, fileSets)
      const rows = await runner.query(rewritten, params ?? [], signal)
      return rows as QueryRow[]
    },
  }
}

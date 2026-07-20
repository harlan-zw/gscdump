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
import type { EngineError } from '../errors'
import type { ResolverAdapter } from '../resolver/types'
import type { AnalysisQuerySource, ExecuteSqlOptions, FileSet, QueryRow, SourceCapabilities } from './source-types'
import { coerceRows } from '../coerce'
import { engineErrors } from '../errors'

export interface AttachedTableRunner {
  /**
   * Run a query with positional (`?`) bound parameters. Return objects keyed
   * by column name. BIGINT → number coercion is applied by the source factory
   * (see `coerceRows`); runners only need to handle DATE → ISO string (or
   * let the analyzer reducer normalize via `num(v)`/`str(v)`).
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
  /**
   * Dialect adapter surfaced on the source for analyzers that compose SQL
   * from a `BuilderState` at plan-build time (e.g. `data-query`,
   * `data-detail`). Attached-table sources execute pg-flavored DuckDB SQL,
   * so callers should pass `pgResolverAdapter` here.
   */
  adapter?: ResolverAdapter<any>
}

export class AttachedTableMissingError extends Error {
  readonly engineError: EngineError
  constructor(public readonly missing: readonly string[]) {
    const engineError = engineErrors.attachedTableMissing(missing)
    super(engineError.message)
    this.name = 'AttachedTableMissingError'
    this.engineError = engineError
  }
}

const ATTACHED_TABLE_CAPABILITIES: SourceCapabilities = {
  fileSets: true,
  attachedTables: true,
  regex: true,
}

const ATTACHED_TABLE_CAPABILITIES_WITH_ADAPTER: SourceCapabilities = {
  ...ATTACHED_TABLE_CAPABILITIES,
  adapter: true,
}

/**
 * Swap `read_parquet({{KEY}}, union_by_name = true)` for `<schema>.<table>`.
 * Tolerates whitespace variation. Preserves the rest of the SQL verbatim.
 */
function rewriteForTableSource(
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
  const { schema, signal, attachedTables, adapter } = options
  const attachedSet = attachedTables ? new Set(attachedTables) : null
  return {
    name: 'attached-table',
    kind: 'browser',
    capabilities: adapter ? ATTACHED_TABLE_CAPABILITIES_WITH_ADAPTER : ATTACHED_TABLE_CAPABILITIES,
    adapter,
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
      return coerceRows(rows as QueryRow[])
    },
  }
}

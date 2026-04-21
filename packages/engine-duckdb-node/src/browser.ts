// Run DuckDB analyzers against an already-attached DuckDB database (schema-per-
// table, as produced by `gscdump store export`). This is the read path for
// browsers with DuckDB-WASM or any other environment that has a DuckDB
// connection but no filesystem / manifest / parquet files.
//
// The analyzers share the same SQL as the server-side path; we just rewrite
// the source expression `read_parquet({{FILES}}, union_by_name = true)` into
// a plain table reference (`<schema>.<table>`) before execution.

import type { AnalysisParams, AnalysisResult } from '@gscdump/analysis'
import type { Row } from '@gscdump/engine/contracts'
import type { AnalyzerSpec } from './shared'
import { buildSqlSpec } from './registry-compat'

export interface AnalyzerRunner {
  /**
   * Run a query with positional (`?`) bound parameters. Return objects keyed
   * by column name. The runner MUST coerce BIGINT → number and DATE → ISO
   * string (or let the shape function handle both via `num(v)`/`str(v)`).
   */
  query: (sql: string, params?: unknown[]) => Promise<Row[]>
}

export interface BrowserAnalyzeOptions {
  /** Schema name the exported DuckDB file was attached under — e.g. `gsc`. */
  schema: string
}

export async function analyzeInBrowser(
  runner: AnalyzerRunner,
  opts: BrowserAnalyzeOptions,
  params: AnalysisParams,
): Promise<AnalysisResult> {
  const spec = buildSqlSpec(params)
  const sql = rewriteForTableSource(spec.sql, opts.schema, spec)
  const rows = await runner.query(sql, spec.params)

  const extras: Record<string, Row[]> = {}
  if (spec.extraQueries) {
    for (const q of spec.extraQueries) {
      const qSql = rewriteForTableSource(q.sql, opts.schema, spec)
      extras[q.name] = await runner.query(qSql, q.params)
    }
  }

  const { results, meta } = spec.shape(rows, params, extras)
  return {
    results: results as unknown as Record<string, unknown>[],
    meta: { tool: params.type, source: 'browser', ...meta },
  }
}

/**
 * Swap `read_parquet({{FILES}}, union_by_name = true)` for `<schema>.<table>`.
 * Tolerates whitespace variation. Preserves the rest of the SQL verbatim.
 *
 * Multi-table analyzers declare `extraFiles: { KEY: { table, partitions } }`;
 * their SQL references them via `{{FILES_KEY}}` and gets rewritten here to
 * `<schema>.<table>` too.
 */
export function rewriteForTableSource(
  sql: string,
  schema: string,
  spec: AnalyzerSpec,
): string {
  let out = sql
  out = out.replace(
    /read_parquet\(\s*\{\{FILES\}\}\s*,\s*union_by_name\s*=\s*true\s*\)/g,
    `${schema}.${spec.current.table}`,
  )
  if (spec.previous) {
    out = out.replace(
      /read_parquet\(\s*\{\{FILES_PREV\}\}\s*,\s*union_by_name\s*=\s*true\s*\)/g,
      `${schema}.${spec.previous.table}`,
    )
  }
  if (spec.extraFiles) {
    for (const [key, fs] of Object.entries(spec.extraFiles)) {
      const pattern = new RegExp(
        `read_parquet\\(\\s*\\{\\{FILES_${key}\\}\\}\\s*,\\s*union_by_name\\s*=\\s*true\\s*\\)`,
        'g',
      )
      out = out.replace(pattern, `${schema}.${fs.table}`)
    }
  }
  return out
}

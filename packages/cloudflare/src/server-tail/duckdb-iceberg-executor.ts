// DuckDB-over-Iceberg-files executor — server-tail executor for the `duckdb`
// archetypes.
//
// R2 SQL has no window functions, no `QUALIFY`, no `COUNT(DISTINCT)`, and
// unverified `OFFSET` (POC Spike 4). The 2 archetypes that need those —
// `arbitrary-sql` (9) and any `top-n-breakdown` escalated by a non-zero
// `offset` — route here instead. DuckDB is a full SQL engine and reads the
// SAME compacted Iceberg parquet data files R2 SQL queries.
//
// This reuses the `DUCKDB_SVC` service binding from `workers-duckdb.ts`: a
// sibling Worker that runs DuckDB and exposes `runSQL`. Unlike the bespoke
// parquet read path (which decodes parquet in the main Worker and ships Arrow
// IPC across the binding), the Iceberg path hands the sibling a single SQL
// statement that scans the Iceberg table directly via DuckDB's `iceberg_scan`.
// The sibling needs the `iceberg` + `httpfs` extensions and R2 S3 credentials
// configured; the data files never transit the main Worker.
//
// Testability: against a real `DUCKDB_SVC` this is exercised by the POC's
// local Iceberg stack (`docker-compose.iceberg.yml` + MinIO). For unit tests a
// fake `DuckDBSvc` implementing `runSQL` returns recorded rows — see
// `server-tail/__tests__`.

import type { ArchetypeQuery } from '@gscdump/sdk'
import type { ArchetypeSqlPlan } from './archetype-sql'
import { bindLiterals } from '@gscdump/engine'
import { buildArchetypeSql, TABLE_PLACEHOLDER } from './archetype-sql'

/** Row returned by the DuckDB sibling. */
export type DuckDbIcebergRow = Record<string, string | number | null>

/**
 * The minimal `DUCKDB_SVC` shape this executor needs — a structural subset of
 * the binding in `workers-duckdb.ts` / `env.ts`. Any binding with `runSQL`
 * satisfies it.
 */
export interface DuckDbSvc {
  runSQL: (args: { sql: string }) => Promise<{ rows: unknown[], sql: string }>
}

/** Configuration for the DuckDB-over-Iceberg executor. */
export interface DuckDbIcebergExecutorConfig {
  /** The DuckDB service binding (the sibling Worker RPC). */
  svc: DuckDbSvc
  /**
   * R2 Data Catalog warehouse identifier. The sibling resolves Iceberg table
   * locations from `<warehouse>` + `<namespace>` + table name.
   */
  warehouse: string
  /** Iceberg namespace the 5 fact tables live in. */
  namespace: string
  /**
   * How the sibling addresses an Iceberg table in a `FROM` clause. Defaults to
   * DuckDB's `iceberg_scan('<warehouse>/<namespace>/<table>')`. Overridable so
   * a sibling configured with the Iceberg REST catalog can use
   * `iceberg_scan('<namespace>.<table>')` or an attached-catalog reference.
   */
  tableRefStyle?: 'path' | 'catalog'
  /** Per-query wall-clock deadline (ms). Default 25s. */
  timeoutMs?: number
}

/** Result of a DuckDB-over-Iceberg query. */
export interface DuckDbIcebergResult {
  rows: DuckDbIcebergRow[]
  /** The exact SQL sent to the sibling. */
  sql: string
  queryMs: number
}

export class DuckDbIcebergError extends Error {
  override name = 'DuckDbIcebergError'
}

export class DuckDbIcebergTimeoutError extends Error {
  override name = 'DuckDbIcebergTimeoutError'
  constructor(timeoutMs: number) {
    super(`DuckDB-over-Iceberg query exceeded ${timeoutMs}ms deadline`)
  }
}

const DEFAULT_TIMEOUT_MS = 25_000

/**
 * Build the `FROM`-clause reference DuckDB uses to scan an Iceberg table.
 * `path` style → `iceberg_scan('<warehouse>/<namespace>/<table>')`.
 * `catalog` style → `<namespace>.<table>` (sibling has an Iceberg catalog
 * attached). All identifiers are our own constants, never user input.
 */
function icebergTableRef(config: DuckDbIcebergExecutorConfig, table: string): string {
  if (config.tableRefStyle === 'catalog')
    return `${config.namespace}.${table}`
  return `iceberg_scan('${config.warehouse}/${config.namespace}/${table}')`
}

/**
 * Race an RPC against a wall-clock deadline. Service-binding RPCs are not
 * abortable, so this bounds *our* latency; the loser promise stops being
 * awaited. Mirrors `withDuckDBDeadline` in `workers-duckdb.ts`.
 */
function withDeadline<T>(op: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new DuckDbIcebergTimeoutError(timeoutMs)), timeoutMs)
    op.then(resolve, reject).finally(() => clearTimeout(timer))
  })
}

/** A configured DuckDB-over-Iceberg executor. */
export interface DuckDbIcebergExecutor {
  /** Run a raw SQL string with `{{TABLE_<name>}}` placeholders resolved. */
  runSql: (sql: string, params?: readonly unknown[]) => Promise<DuckDbIcebergResult>
  /** Run a dialect-neutral plan: resolve `{{TABLE}}`, bind params, send. */
  runPlan: (plan: ArchetypeSqlPlan) => Promise<DuckDbIcebergResult>
  /** Translate + run an archetype query. Handles `arbitrary-sql` verbatim. */
  runArchetype: (query: ArchetypeQuery) => Promise<DuckDbIcebergResult>
}

/**
 * Replace `{{<TableName>}}` placeholders in caller-supplied (`arbitrary-sql`)
 * SQL with `iceberg_scan` references. The `arbitrary-sql` contract says the
 * SQL references "the attached table views by their `IcebergTableName`" — in
 * the browser those are attached DuckDB views; on the server tail the same
 * `{{pages}}` / `{{page_queries}}` style placeholders resolve to Iceberg
 * scans here.
 */
function resolveTablePlaceholders(sql: string, config: DuckDbIcebergExecutorConfig): string {
  return sql.replace(/\{\{(\w+)\}\}/g, (_, table: string) => icebergTableRef(config, table))
}

/**
 * Create a DuckDB-over-Iceberg-files executor.
 */
export function createDuckDbIcebergExecutor(
  config: DuckDbIcebergExecutorConfig,
): DuckDbIcebergExecutor {
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS

  async function send(sql: string): Promise<DuckDbIcebergResult> {
    const started = Date.now()
    const result = await withDeadline(config.svc.runSQL({ sql }), timeoutMs).catch((err) => {
      if (err instanceof DuckDbIcebergTimeoutError)
        throw err
      throw new DuckDbIcebergError(`DUCKDB_SVC.runSQL failed: ${(err as Error).message}`)
    })
    return {
      rows: (result.rows as DuckDbIcebergRow[]) ?? [],
      sql: result.sql ?? sql,
      queryMs: Date.now() - started,
    }
  }

  function runSql(sql: string, params: readonly unknown[] = []): Promise<DuckDbIcebergResult> {
    const resolved = resolveTablePlaceholders(sql, config)
    return send(bindLiterals(resolved, params as unknown[]))
  }

  function runPlan(plan: ArchetypeSqlPlan): Promise<DuckDbIcebergResult> {
    const resolved = plan.sql.split(TABLE_PLACEHOLDER).join(icebergTableRef(config, plan.table))
    // The neutral plan uses `?` placeholders; DuckDB binds them via the
    // engine's `bindLiterals` (the same literal binder the bespoke path uses).
    return send(bindLiterals(resolved, plan.params))
  }

  async function runArchetype(query: ArchetypeQuery): Promise<DuckDbIcebergResult> {
    if (query.archetype === 'arbitrary-sql') {
      // Caller-supplied SQL — referenced tables resolve to Iceberg scans, then
      // its own `?` params bind. R2 SQL can never express this archetype.
      return runSql(query.sql, query.params ?? [])
    }
    if (query.archetype === 'aux-cloud-only')
      throw new DuckDbIcebergError('aux-cloud-only is not an Iceberg query')
    return runPlan(buildArchetypeSql(query))
  }

  return { runSql, runPlan, runArchetype }
}

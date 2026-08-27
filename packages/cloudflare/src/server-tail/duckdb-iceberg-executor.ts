// DuckDB-over-Iceberg-files executor — server-tail executor for the `duckdb`
// archetypes.
//
// R2 SQL gained window functions, `COUNT(DISTINCT)`, JOINs/CTEs, and set
// operations in CF's 2026-05-14 / 2026-06-21 ships (empirically re-verified
// 2026-07-03 — see `r2-sql-client.ts` and `dispatcher.ts` for the capability
// matrix and the specific escalations that survive). What still routes here:
// `arbitrary-sql` (9, caller-supplied SQL DuckDB runs verbatim — `QUALIFY` and
// anything else caller code writes needs a real SQL engine regardless), any
// `top-n-breakdown` escalated by a non-zero `offset` (R2 SQL `OFFSET` is
// CONFIRMED unsupported, not just unverified), a `queryCanonical`-dimensioned
// breakdown (its dimension column is a correlated subquery against a
// `query_dim` sidecar table that is NOT an Iceberg table R2 SQL can see), and
// regex facets (R2 SQL's regex predicate is a different function+shape than
// the dialect-neutral SQL this package emits — see `dispatcher.ts`). DuckDB is
// a full SQL engine and reads the SAME compacted Iceberg parquet data files
// R2 SQL queries.
//
// This uses a `DUCKDB_SVC` service binding to a sibling Worker that runs
// DuckDB and exposes `runSQL`. The Iceberg path hands the sibling a single SQL
// statement that scans the Iceberg table directly via DuckDB's `iceberg_scan`.
// The sibling needs the `iceberg` + `httpfs` extensions and R2 S3 credentials
// configured; the data files never transit the main Worker.
//
// Testability: against a real `DUCKDB_SVC` this is exercised by the POC's
// local Iceberg stack (`docker-compose.iceberg.yml` + MinIO). For unit tests a
// fake `DuckDBSvc` implementing `runSQL` returns recorded rows — see
// `server-tail/__tests__`.

import type { ArchetypeQuery } from '@gscdump/contracts/archetypes'
import type { Result } from 'gscdump/result'
import type { ArchetypeSqlPlan } from './archetype-sql'
import { bindLiterals } from '@gscdump/engine/sql'
import { err, ok, unwrapResult } from 'gscdump/result'
import { buildArchetypeSql, TABLE_PLACEHOLDER } from './archetype-sql'

/** Row returned by the DuckDB sibling. */
export type DuckDbIcebergRow = Record<string, string | number | null>

/**
 * The minimal `DUCKDB_SVC` shape this executor needs. Any binding with
 * `runSQL` satisfies it.
 */
export interface DuckDbSvc {
  runSQL: (args: { sql: string, deadlineAt?: number }) => Promise<{ rows: unknown[], sql: string }>
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

/**
 * The modelled, caller-actionable failure channel for a DuckDB-over-Iceberg
 * query. As with the R2 SQL client, callers branch on which class came back: a
 * `DuckDbIcebergTimeoutError` is the retry-able deadline overrun, a
 * `DuckDbIcebergError` is a hard sibling-RPC failure (or the `aux-cloud-only`
 * routing reject). The error variant IS the existing throwable class, so the
 * throwing wrappers preserve the identity/message tests assert
 * (`rejects.toThrow(/OOM in sibling/)`, `rejects.toThrow(DuckDbIcebergError)`).
 */
export type DuckDbIcebergQueryError = DuckDbIcebergError | DuckDbIcebergTimeoutError

/**
 * Re-raise a modelled DuckDB-over-Iceberg failure as itself. The error variant
 * of the `*Result` cores already IS the throwable class, so the throwing
 * wrappers keep the exact identity existing call sites and tests catch.
 */
function duckDbIcebergErrorToException(error: DuckDbIcebergQueryError): DuckDbIcebergQueryError {
  return error
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
 * awaited.
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
  /**
   * Errors-as-values core for {@link DuckDbIcebergExecutor.runArchetype}:
   * returns the modelled timeout-vs-hard-fail `DuckDbIcebergQueryError` instead
   * of throwing, so the dispatcher can branch on retry-ability (a timeout may be
   * worth a fallback) without `instanceof` over a `catch`. Optional so a
   * hand-rolled executor (e.g. a host app's own service-binding executor) can
   * implement only the throwing surface; {@link createDuckDbIcebergExecutor}
   * always provides it.
   */
  runArchetypeResult?: (query: ArchetypeQuery) => Promise<Result<DuckDbIcebergResult, DuckDbIcebergQueryError>>
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

  async function sendResult(sql: string): Promise<Result<DuckDbIcebergResult, DuckDbIcebergQueryError>> {
    const started = Date.now()
    // A deadline overrun is the retry-able timeout; any other sibling-RPC blow-up
    // is a hard `DuckDbIcebergError`. The underlying RPC error is unmodellable
    // noise, folded into the message.
    const deadlineAt = Date.now() + timeoutMs
    const raced = await withDeadline(config.svc.runSQL({ sql, deadlineAt }), timeoutMs)
      .then(value => ok(value))
      .catch((error: unknown): Result<{ rows: unknown[], sql: string }, DuckDbIcebergQueryError> =>
        error instanceof DuckDbIcebergTimeoutError
          ? err(error)
          : err(new DuckDbIcebergError(`DUCKDB_SVC.runSQL failed: ${(error as Error).message}`)))
    if (!raced.ok)
      return raced
    const result = raced.value
    return ok({
      rows: (result.rows as DuckDbIcebergRow[]) ?? [],
      sql: result.sql ?? sql,
      queryMs: Date.now() - started,
    })
  }

  async function send(sql: string): Promise<DuckDbIcebergResult> {
    return unwrapResult(await sendResult(sql), duckDbIcebergErrorToException)
  }

  function runSqlResult(sql: string, params: readonly unknown[] = []): Promise<Result<DuckDbIcebergResult, DuckDbIcebergQueryError>> {
    const resolved = resolveTablePlaceholders(sql, config)
    return sendResult(bindLiterals(resolved, params as unknown[]))
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

  function runPlanResult(plan: ArchetypeSqlPlan): Promise<Result<DuckDbIcebergResult, DuckDbIcebergQueryError>> {
    const resolved = plan.sql.split(TABLE_PLACEHOLDER).join(icebergTableRef(config, plan.table))
    return sendResult(bindLiterals(resolved, plan.params))
  }

  function runArchetypeResult(query: ArchetypeQuery): Promise<Result<DuckDbIcebergResult, DuckDbIcebergQueryError>> {
    if (query.archetype === 'arbitrary-sql') {
      // Caller-supplied SQL — referenced tables resolve to Iceberg scans, then
      // its own `?` params bind. R2 SQL can never express this archetype.
      return runSqlResult(query.sql, query.params ?? [])
    }
    if (query.archetype === 'aux-cloud-only')
      return Promise.resolve(err(new DuckDbIcebergError('aux-cloud-only is not an Iceberg query')))
    return runPlanResult(buildArchetypeSql(query))
  }

  async function runArchetype(query: ArchetypeQuery): Promise<DuckDbIcebergResult> {
    return unwrapResult(await runArchetypeResult(query), duckDbIcebergErrorToException)
  }

  return { runSql, runPlan, runArchetype, runArchetypeResult }
}

// Server-tail query dispatcher — routes an `ArchetypeQuery` to the right
// executor by its execution class.
//
// The hybrid server tail (architecture v4, "Read paths"; POC Spike 4):
//  - `r2-sql` / `r2-sql-resolved` archetypes → R2 SQL client.
//  - `duckdb` archetypes (window functions) → DuckDB-over-Iceberg executor.
//  - `cloud-only` → not an Iceberg query; the dispatcher rejects it (the
//    consumer routes aux data through the existing cloud endpoints).
//
// Escalation rule (CONTRACTS.md decision #5): a `top-n-breakdown` with a
// non-zero `offset` is escalated from `r2-sql-resolved` to `duckdb`, because
// R2 SQL `OFFSET` is unverified. The escalation is the dispatcher's job — the
// static `ARCHETYPE_EXECUTION_CLASS` tag cannot see the per-query `offset`.
//
// The dispatcher honours a `ServerTailDirective.engine` when one is supplied
// (the file-resolution endpoint already decided), but the directive only ever
// names `r2-sql` or `duckdb`; if it disagrees with what the archetype can
// actually run on, the archetype wins (a `duckdb`-class archetype can never
// run on R2 SQL).

import type { ServerTailDirective } from '@gscdump/contracts'
import type { ArchetypeQuery, ArchetypeResult, ArchetypeResultRow } from '@gscdump/sdk'
import type { Result } from 'gscdump/result'
import type { DuckDbIcebergExecutor } from './duckdb-iceberg-executor'
import type { R2SqlClient } from './r2-sql-client'
import { ARCHETYPE_EXECUTION_CLASS } from '@gscdump/sdk'
import { err, ok, unwrapResult } from 'gscdump/result'

/** The two engines the server tail can route to. */
export type ServerTailEngine = 'r2-sql' | 'duckdb'

/** Executors the dispatcher routes between. */
export interface ServerTailDispatcherConfig {
  r2Sql: R2SqlClient
  duckdb: DuckDbIcebergExecutor
}

export class ServerTailRoutingError extends Error {
  override name = 'ServerTailRoutingError'
}

/**
 * Re-raise a routing failure as itself. The error variant of
 * {@link resolveServerTailEngineResult} already IS the throwable
 * `ServerTailRoutingError`, so the throwing wrapper preserves the exact identity
 * existing call sites and tests catch (`toThrow(ServerTailRoutingError)`).
 */
function routingErrorToException(error: ServerTailRoutingError): ServerTailRoutingError {
  return error
}

/**
 * Errors-as-values core for {@link resolveServerTailEngine}: returns a
 * `ServerTailRoutingError` instead of throwing when an archetype is `cloud-only`
 * (the one caller-actionable routing failure — the consumer must route that
 * query through the cloud endpoints, not the server tail). Pure — no I/O.
 */
export function resolveServerTailEngineResult(
  query: ArchetypeQuery,
): Result<ServerTailEngine, ServerTailRoutingError> {
  const cls = ARCHETYPE_EXECUTION_CLASS[query.archetype]
  if (cls === 'cloud-only') {
    return err(new ServerTailRoutingError(
      `archetype '${query.archetype}' is cloud-only — not a server-tail query`,
    ))
  }
  if (cls === 'duckdb')
    return ok('duckdb')
  // r2-sql / r2-sql-resolved → R2 SQL, UNLESS escalated.
  // Escalation: top-n-breakdown with non-zero offset (R2 SQL OFFSET unverified).
  if (query.archetype === 'top-n-breakdown' && query.offset && query.offset > 0)
    return ok('duckdb')
  // Escalation: top-n-breakdown with includeTotal needs `COUNT(*) OVER()`, a
  // window function R2 SQL cannot express — run it on DuckDB.
  if (query.archetype === 'top-n-breakdown' && query.includeTotal)
    return ok('duckdb')
  // Escalation: a comparison-window breakdown is compiled as current/previous
  // CTEs joined with FULL OUTER JOIN (for the `prev*` columns) — CTEs, FROM
  // subqueries and outer joins are all beyond R2 SQL, so it runs on DuckDB.
  if (query.archetype === 'top-n-breakdown' && query.compareRange)
    return ok('duckdb')
  // Escalation: a `queryCanonical` breakdown carries `COUNT(DISTINCT query)` for
  // the variant count — DISTINCT-aggregate support on R2 SQL is unverified, so
  // route it to DuckDB (mirrors the `offset` escalation rationale).
  if (query.archetype === 'top-n-breakdown' && query.dimension === 'queryCanonical')
    return ok('duckdb')
  // Escalation: facet predicates (Country/Device/Brand) are only compiled by the
  // DuckDB builder — brand uses `regexp_matches`, which R2 SQL lacks — so any
  // faceted query runs on DuckDB. `facets` lives on `ArchetypeQueryBase`, but the
  // `aux-cloud-only` union member omits it, so read it structurally.
  const facets = (query as { facets?: readonly unknown[] }).facets
  if (facets && facets.length > 0)
    return ok('duckdb')
  return ok('r2-sql')
}

/**
 * Decide which engine answers an archetype query. Pure — no I/O. Exposed so
 * the file-resolution endpoint can compute the `ServerTailDirective.engine`
 * with the SAME logic the dispatcher uses at execution time. Throws
 * `ServerTailRoutingError` for a `cloud-only` archetype; see
 * {@link resolveServerTailEngineResult} for the errors-as-values core.
 */
export function resolveServerTailEngine(query: ArchetypeQuery): ServerTailEngine {
  return unwrapResult(resolveServerTailEngineResult(query), routingErrorToException)
}

/** Result envelope `source` for the chosen engine. */
function sourceFor(engine: ServerTailEngine): ArchetypeResult['source'] {
  return engine === 'r2-sql' ? 'server-r2-sql' : 'server-duckdb'
}

/**
 * Pull the `__total` window column (emitted by `includeTotal` breakdowns) out
 * of the rows and return it alongside the cleaned rows, so it never leaks into
 * the dimension/metric payload the consumer renders.
 */
function extractTotal<R extends ArchetypeResultRow>(rows: R[]): { rows: R[], totalRows?: number } {
  if (!rows.length || !('__total' in rows[0]!))
    return { rows }
  const totalRows = Number(rows[0]!.__total) || 0
  const cleaned = rows.map((r) => {
    const { __total, ...rest } = r as Record<string, unknown>
    return rest as R
  })
  return { rows: cleaned, totalRows }
}

/** A configured server-tail dispatcher. */
export interface ServerTailDispatcher {
  /** Decide the engine for a query without running it. */
  route: (query: ArchetypeQuery) => ServerTailEngine
  /**
   * Execute a query, routing by execution class. If `directive` is supplied
   * its `engine` is honoured only when consistent with the archetype's class
   * (a `duckdb`-class archetype always runs on DuckDB regardless).
   */
  execute: <R extends ArchetypeResultRow = ArchetypeResultRow>(
    query: ArchetypeQuery,
    directive?: ServerTailDirective,
  ) => Promise<ArchetypeResult<R>>
}

/**
 * Create the server-tail dispatcher. Holds an R2 SQL client and a DuckDB
 * executor and routes every `ArchetypeQuery` to one of them.
 */
export function createServerTailDispatcher(
  config: ServerTailDispatcherConfig,
): ServerTailDispatcher {
  function route(query: ArchetypeQuery): ServerTailEngine {
    return resolveServerTailEngine(query)
  }

  async function execute<R extends ArchetypeResultRow = ArchetypeResultRow>(
    query: ArchetypeQuery,
    directive?: ServerTailDirective,
  ): Promise<ArchetypeResult<R>> {
    const engine = route(query)

    // A directive may name the engine the file-resolution endpoint chose.
    // Honour it only when it does not contradict what the archetype can run
    // on: a `duckdb`-class archetype is never expressible in R2 SQL, so the
    // archetype-derived engine always wins a disagreement.
    if (directive && directive.engine !== engine && engine === 'r2-sql') {
      // directive says duckdb but archetype is happy on r2-sql — defer to the
      // directive (e.g. size-based escalation the endpoint knows about).
      return runOn('duckdb', query)
    }

    return runOn(engine, query)
  }

  async function runOn<R extends ArchetypeResultRow = ArchetypeResultRow>(
    engine: ServerTailEngine,
    query: ArchetypeQuery,
  ): Promise<ArchetypeResult<R>> {
    if (engine === 'r2-sql') {
      const res = await config.r2Sql.runArchetype(query)
      return {
        archetype: query.archetype,
        rows: res.rows as R[],
        source: sourceFor('r2-sql'),
        meta: { rowCount: res.rows.length, queryMs: res.queryMs },
      }
    }
    const res = await config.duckdb.runArchetype(query)
    const { rows, totalRows } = extractTotal(res.rows as R[])
    return {
      archetype: query.archetype,
      rows,
      source: sourceFor('duckdb'),
      meta: {
        rowCount: rows.length,
        queryMs: res.queryMs,
        ...(totalRows !== undefined ? { totalRows } : {}),
      },
    }
  }

  return { route, execute }
}

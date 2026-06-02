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
import type { DuckDbIcebergExecutor } from './duckdb-iceberg-executor'
import type { R2SqlClient } from './r2-sql-client'
import { ARCHETYPE_EXECUTION_CLASS } from '@gscdump/sdk'

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
 * Decide which engine answers an archetype query. Pure — no I/O. Exposed so
 * the file-resolution endpoint can compute the `ServerTailDirective.engine`
 * with the SAME logic the dispatcher uses at execution time.
 */
export function resolveServerTailEngine(query: ArchetypeQuery): ServerTailEngine {
  const cls = ARCHETYPE_EXECUTION_CLASS[query.archetype]
  if (cls === 'cloud-only') {
    throw new ServerTailRoutingError(
      `archetype '${query.archetype}' is cloud-only — not a server-tail query`,
    )
  }
  if (cls === 'duckdb')
    return 'duckdb'
  // r2-sql / r2-sql-resolved → R2 SQL, UNLESS escalated.
  // Escalation: top-n-breakdown with non-zero offset (R2 SQL OFFSET unverified).
  if (query.archetype === 'top-n-breakdown' && query.offset && query.offset > 0)
    return 'duckdb'
  // Escalation: facet predicates (Country/Device/Brand) are only compiled by the
  // DuckDB builder — brand uses `regexp_matches`, which R2 SQL lacks — so any
  // faceted query runs on DuckDB.
  if (query.facets && query.facets.length > 0)
    return 'duckdb'
  return 'r2-sql'
}

/** Result envelope `source` for the chosen engine. */
function sourceFor(engine: ServerTailEngine): ArchetypeResult['source'] {
  return engine === 'r2-sql' ? 'server-r2-sql' : 'server-duckdb'
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
    return {
      archetype: query.archetype,
      rows: res.rows as R[],
      source: sourceFor('duckdb'),
      meta: { rowCount: res.rows.length, queryMs: res.queryMs },
    }
  }

  return { route, execute }
}

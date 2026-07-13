// Server-tail query dispatcher — routes an `ArchetypeQuery` to the right
// executor by its execution class.
//
// The hybrid server tail (architecture v4, "Read paths"; POC Spike 4):
//  - `r2-sql` / `r2-sql-resolved` archetypes → R2 SQL client.
//  - `duckdb` archetypes (arbitrary caller SQL) → DuckDB-over-Iceberg executor.
//  - `cloud-only` → not an Iceberg query; the dispatcher rejects it (the
//    consumer routes aux data through the existing cloud endpoints).
//
// R2 SQL capability re-audit (2026-07-03, empirically verified against a real
// per-team warehouse — see the capability matrix in the re-audit notes): CF
// shipped JOINs + subqueries + multi-table CTEs (2026-05-14) and window
// functions + `COUNT(DISTINCT ...)` + set operations (2026-06-21). Verified
// working: `ROW_NUMBER() OVER (PARTITION BY ... ORDER BY ...)`, bare
// `COUNT(*) OVER()`, `COUNT(DISTINCT col)`, cross-namespace two-table `JOIN`,
// `WITH` CTEs + `FULL OUTER JOIN`, `UNION ALL`. Still confirmed unsupported:
// `OFFSET` (`[40003] OFFSET clause is not supported`), a named `WINDOW`
// clause (`[40003] WINDOW clause is not supported`), and bound params (no
// channel — SQL is inlined). `regexp_matches` (DuckDB spelling) errors
// (`Invalid function 'regexp_matches'. Did you mean 'regexp_match'?`);
// `regexp_match(col, pattern) IS NOT NULL` DOES work as an R2-SQL boolean
// predicate, but `buildArchetypeSql` emits one dialect-neutral SQL string for
// both executors and DuckDB has no `regexp_match` singular — wiring this in
// needs per-dialect facet compilation, which is a real change, not a routing
// flip. Left on `duckdb` below; not reclassified.
//
// Escalation rules below are the dispatcher's job — the static
// `ARCHETYPE_EXECUTION_CLASS` tag cannot see per-query fields like `offset`.
//
// The dispatcher honours a `ServerTailDirective.engine` when one is supplied
// (the file-resolution endpoint already decided), but the directive only ever
// names `r2-sql` or `duckdb`; if it disagrees with what the archetype can
// actually run on, the archetype wins (a `duckdb`-class archetype can never
// run on R2 SQL).

import type { ServerTailDirective } from '@gscdump/contracts'
import type { ArchetypeFacet, ArchetypeQuery, ArchetypeResult, ArchetypeResultRow } from '@gscdump/contracts/archetypes'
import type { Result } from 'gscdump/result'
import type { DuckDbIcebergExecutor } from './duckdb-iceberg-executor'
import type { R2SqlClient } from './r2-sql-client'
import { ARCHETYPE_EXECUTION_CLASS } from '@gscdump/contracts/archetypes'
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

function hasRegexFacet(query: ArchetypeQuery): boolean {
  const facets = (query as { facets?: readonly ArchetypeFacet[] }).facets
  return facets?.some(f => f.op === 'regex' || f.op === 'notRegex') ?? false
}

/**
 * Does the compiled SQL for this query reference the `query_dim` sidecar
 * relation? Any `queryCanonical` touchpoint — the grouped/sparkline dimension,
 * a facet column (ANY op: even an equality facet compiles to the COALESCE
 * subquery via `dimColumn`, never a plain `col = ?`), a single-row-lookup
 * match key, or a stacked-series dimension — emits
 * `COALESCE((SELECT qd.query_canonical FROM query_dim qd ...), query)`.
 * `query_dim` is a per-user sidecar parquet, NOT an Iceberg table in the
 * catalog, so R2 SQL throws `[40010] iceberg table not found "gsc.query_dim"`
 * on every one of these shapes (confirmed live 2026-07-13: a canonical-faceted
 * `query` breakdown and a canonical sparkline both 500d while the
 * canonical-DIMENSIONED breakdown ran fine on DuckDB); only the DuckDB
 * executor binds the sidecar as a CTE. Mirrors `dimColumn`/`facetPredicate`
 * in `archetype-sql.ts` — extend BOTH if a new shape learns canonical.
 */
function referencesQueryDim(query: ArchetypeQuery): boolean {
  const q = query as {
    dimension?: string
    seriesDimension?: string
    entity?: { dimension?: string }
    match?: Record<string, unknown>
    facets?: readonly ArchetypeFacet[]
  }
  if (q.dimension === 'queryCanonical' || q.seriesDimension === 'queryCanonical')
    return true
  if (q.entity?.dimension === 'queryCanonical')
    return true
  if (q.match && 'queryCanonical' in q.match)
    return true
  return q.facets?.some(f => f.column === 'queryCanonical') ?? false
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
  // Escalation: top-n-breakdown with non-zero offset. CONFIRMED still
  // unsupported (2026-07-03 empirical re-audit): R2 SQL rejects `OFFSET`
  // outright (`[40003] OFFSET clause is not supported`).
  if (query.archetype === 'top-n-breakdown' && query.offset && query.offset > 0)
    return ok('duckdb')
  // `includeTotal` needs `COUNT(*) OVER()` and `compareRange` compiles to
  // `WITH cur AS (...), prev AS (...) ... FULL OUTER JOIN` — both EMPIRICALLY
  // VERIFIED working on R2 SQL as of the 2026-06-21 (window functions) and
  // 2026-05-14 (CTEs/JOINs) CF ships (re-confirmed 2026-07-03 against a real
  // per-team warehouse, including the two combined in one query). No escalation
  // needed; these stay on r2-sql/r2-sql-resolved below.
  //
  // Escalation: ANY `queryCanonical` touchpoint (dimension, facet, match key,
  // series dimension) compiles to a correlated subquery against the
  // `query_dim` sidecar, which is unreachable from R2 SQL — see
  // {@link referencesQueryDim}. Previously only the DIMENSIONED breakdown was
  // escalated; a canonical FACET on a `query` breakdown and the canonical
  // sparkline slipped through to R2 SQL and 500d in production, which the pro
  // proxy's compat fallback then masked as exact-match (variant-less) data.
  if (referencesQueryDim(query))
    return ok('duckdb')
  // Escalation: regex facets compile to `regexp_matches`, which R2 SQL lacks
  // under that name (`Invalid function 'regexp_matches'. Did you mean
  // 'regexp_match'?`). R2 SQL's `regexp_match(col, pattern) IS NOT NULL` IS a
  // working boolean predicate (verified 2026-07-03), but `buildArchetypeSql`
  // emits one dialect-neutral SQL string consumed by both executors and
  // DuckDB has no singular `regexp_match` — wiring this in needs per-dialect
  // facet compilation, a real change, not a routing flip. Not reclassified;
  // stays on DuckDB. Equality facets are plain `col = ?` predicates and can
  // stay on R2 SQL when the rest of the archetype is R2-compatible.
  if (hasRegexFacet(query))
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
      const { rows, totalRows } = extractTotal(res.rows as R[])
      return {
        archetype: query.archetype,
        rows,
        source: sourceFor('r2-sql'),
        meta: {
          rowCount: rows.length,
          queryMs: res.queryMs,
          ...(totalRows !== undefined ? { totalRows } : {}),
        },
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

/**
 * Unified analyzer contract.
 *
 * Every analyzer reduces to two pure functions — `build` turns typed params
 * into a `Plan` (SQL or row-query shape), `reduce` turns result rows into
 * a typed result. `requires` declares capability constraints so a dispatcher
 * can reject sources that don't support the analyzer up-front (e.g. running
 * a SQL analyzer against a source that has no `executeSql`).
 *
 * Two plan shapes cover both existing analyzer families:
 *   - `SqlPlan` — SQL-native analyzers (the `duckdb/analyzers/*` family).
 *   - `RowQueriesPlan` — row-based analyzers that need typed `BuilderState`
 *     queries executed against a source, with results reduced purely.
 */

import type { BuilderState } from 'gscdump/query'
import type { AnalysisParams } from '../analysis-types'
import type { ResolverAdapter } from '../resolver/types'
import type { FileSet, SourceCapabilities } from '../source/source-types'
import type { Row } from '../storage'

/**
 * Capabilities a Plan may require of its host. Dispatch matches `requires`
 * against the source's declared `capabilities` (and the presence of
 * `executeSql`) and rejects mismatches.
 *
 * `'executeSql'` checks for the method on the source; the rest are flag keys
 * on `SourceCapabilities`. Single source of truth — adding a new capability
 * is one line in `SourceCapabilities`.
 */
export type RequiredCapability = 'executeSql' | keyof SourceCapabilities

export interface SqlExtraQuery {
  name: string
  sql: string
  params: unknown[]
}

/**
 * SQL-native plan: SQL string + placeholders, with optional extra file sets
 * and follow-up queries.
 */
export interface SqlPlan {
  kind: 'sql'
  sql: string
  params: unknown[]
  current: FileSet
  previous?: FileSet
  extraFiles?: Record<string, FileSet>
  extraQueries?: SqlExtraQuery[]
}

export interface TypedRowQuery<T extends Row = Row> {
  state: BuilderState
  /** Optional type tag for downstream narrowing. */
  rowType?: (row: Row) => T
}

/**
 * Row-queries plan: a named set of typed `BuilderState` queries. A portable
 * dispatcher runs each against a source's `queryRows` and hands the row
 * collection to `reduce`.
 */
export interface RowQueriesPlan {
  kind: 'rows'
  queries: Record<string, TypedRowQuery>
}

export type Plan = SqlPlan | RowQueriesPlan

/**
 * Plan-build context. Surfaced from the source at dispatch time so analyzers
 * that compose SQL from a typed `BuilderState` can pick up the right dialect
 * adapter without importing one directly. Most SQL analyzers emit static SQL
 * and ignore this; only the BuilderState-driven `data-query` / `data-detail`
 * analyzers consume it today.
 *
 * `adapter` is optional on the type; analyzers that need it should call
 * `requireAdapter(ctx, id)` rather than non-null-asserting. Capability
 * declaration (`'adapter'` in `requires`) is the runtime guarantee; the
 * helper makes the failure mode loud if the contract is broken.
 */
export interface BuildContext {
  adapter?: ResolverAdapter<any>
  siteId?: string | number
}

/**
 * Throw a uniform error if a SQL analyzer declared the `'adapter'` capability
 * but the dispatcher handed it a context without one. Centralizes the assert
 * so analyzers don't repeat `ctx.adapter!` with explanatory comments.
 */
export function requireAdapter(ctx: BuildContext, analyzerId: string): ResolverAdapter<any> {
  if (!ctx.adapter)
    throw new Error(`analyzer "${analyzerId}": BuildContext.adapter missing — declare 'adapter' in sqlRequires/rowsRequires`)
  return ctx.adapter
}

export interface ReduceContext<TRow extends Row = Row> {
  params: AnalysisParams
  /** Extra SQL-query results keyed by `SqlExtraQuery.name`. */
  extras?: Record<string, TRow[]>
}

/**
 * Unified analyzer contract. `TRow` lets authors narrow from the default
 * `Row = Record<string, unknown>` to a typed row shape (e.g. `KeywordRow`)
 * when their reducer assumes specific columns exist — catches drift between
 * `build` (SELECT list) and `reduce` (column access) at compile time.
 */
export interface Analyzer<
  P extends AnalysisParams = AnalysisParams,
  R = unknown,
  TRow extends Row = Row,
> {
  /** Stable tool id (e.g. `striking-distance`, `opportunity`). */
  id: string
  /** Capabilities a host source must provide. */
  requires: readonly RequiredCapability[]
  /** Pure: params → plan. Snapshot-testable. `ctx` carries the source's dialect adapter when one is available. */
  build: (params: P, ctx?: BuildContext) => Plan
  /** Pure: rows + context → typed result + meta. */
  reduce: (rows: TRow[] | Record<string, TRow[]>, ctx: ReduceContext<TRow>) => {
    results: R
    meta?: Record<string, unknown>
  }
}

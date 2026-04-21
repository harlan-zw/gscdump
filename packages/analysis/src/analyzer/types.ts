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

import type { Row } from '@gscdump/engine/contracts'
import type { FileSet } from '@gscdump/engine/resolver'
import type { BuilderState } from 'gscdump/query'
import type { AnalysisParams } from '../types'

/**
 * Capabilities a Plan may require of its host. A dispatcher matches these
 * against a source's declared capabilities and rejects mismatches.
 */
export type Capability
  = | 'executeSql' // source supports raw SQL execution
    | 'partitionedParquet' // source has manifest-resolved parquet partitions
    | 'attachedTables' // source has named tables attached as views (browser)
    | 'regex' // regex predicates supported
    | 'windowTotals' // SQL window functions for totals
    | 'comparisonJoin' // JOIN-based comparison queries

export interface SqlExtraQuery {
  name: string
  sql: string
  params: unknown[]
}

/**
 * SQL-native plan: SQL string + placeholders, with optional extra file sets
 * and follow-up queries. Mirrors the existing `AnalyzerSpec` shape but
 * renamed for clarity under the unified contract.
 */
export interface SqlPlan {
  kind: 'sql'
  sql: string
  params: unknown[]
  current: FileSet
  previous?: FileSet
  extraFiles?: Record<string, FileSet>
  extraQueries?: SqlExtraQuery[]
  /** Emits direct table refs (browser-only). Dispatcher rejects for manifest path. */
  requiresAttachedTables?: boolean
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
  requires: readonly Capability[]
  /** Pure: params → plan. Snapshot-testable. */
  build: (params: P) => Plan
  /** Pure: rows + context → typed result + meta. */
  reduce: (rows: TRow[] | Record<string, TRow[]>, ctx: ReduceContext<TRow>) => {
    results: R
    meta?: Record<string, unknown>
  }
}

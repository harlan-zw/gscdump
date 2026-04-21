/**
 * Analyzer-facing source types. SQL-source contracts (`SqlQuerySource`,
 * `RowQuerySource`, `AnalysisQuerySource`, `QueryRow`, `SourceCapabilities`,
 * `ExecuteSqlOptions`, `FileSet`) live in `@gscdump/engine/resolver` and
 * are re-exported here. `TypedQuery`, `queryRows`, `queryComparisonRows`
 * are analysis-level ergonomics for typed row shapes.
 */

import type { AnalysisQuerySource, QueryRow } from '@gscdump/engine/resolver'
import type { BuilderState } from 'gscdump/query'

export type {
  AnalysisQuerySource,
  ExecuteSqlOptions,
  FileSet,
  QueryRow,
  RowQuerySource,
  SourceCapabilities,
  SqlQuerySource,
} from '@gscdump/engine/resolver'
export { isSqlQuerySource } from '@gscdump/engine/resolver'

export interface TypedQuery<TRow> {
  state: BuilderState
  readonly __row?: TRow
}

export function typedQuery<TRow>(state: BuilderState): TypedQuery<TRow> {
  return { state }
}

function isTypedQuery(value: BuilderState | TypedQuery<unknown>): value is TypedQuery<unknown> {
  return 'state' in value
}

export async function queryRows<TRow = QueryRow>(
  source: AnalysisQuerySource,
  query: BuilderState | TypedQuery<TRow>,
): Promise<TRow[]> {
  const state = isTypedQuery(query) ? query.state : query
  return (await source.queryRows(state)) as unknown as TRow[]
}

export async function queryComparisonRows<TRow = QueryRow>(
  source: AnalysisQuerySource,
  current: BuilderState | TypedQuery<TRow>,
  previous: BuilderState | TypedQuery<TRow>,
): Promise<{ current: TRow[], previous: TRow[] }> {
  const [currentRows, previousRows] = await Promise.all([
    queryRows<TRow>(source, current),
    queryRows<TRow>(source, previous),
  ])
  return { current: currentRows, previous: previousRows }
}

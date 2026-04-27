/**
 * `defineAnalyzer` — single colocation site for an analyzer that can be
 * executed via SQL (against a `SqlQuerySource`) or via a row query plan
 * (against a `RowQuerySource` — e.g. GSC live API, in-memory rows).
 *
 * Authors provide either:
 *   - a shared `reduce` (parity-mode: SQL emits raw aggregation; reducer does
 *     filter/sort/derive once for both paths), OR
 *   - separate `reduceSql` and `reduceRows` (mechanical-colocation mode: each
 *     path keeps its tuned implementation, just lives in one file).
 *
 * Returned `sql` / `rows` are plain `Analyzer` values — the existing
 * `AnalyzerRegistry`, dispatcher, and variant-resolution logic consume them
 * unchanged.
 */

import type { Row } from '@gscdump/engine/contracts'
import type { FileSet } from '@gscdump/engine/resolver'
import type { BuilderState } from 'gscdump/query'
import type { AnalysisParams } from '../types'
import type {
  Analyzer,
  Capability,
  Plan,
  ReduceContext,
  RowQueriesPlan,
  SqlExtraQuery,
  SqlPlan,
} from './types'

export interface SqlPlanSpec {
  sql: string
  params: unknown[]
  current: FileSet
  previous?: FileSet
  extraFiles?: Record<string, FileSet>
  extraQueries?: SqlExtraQuery[]
  requiresAttachedTables?: boolean
}

export interface ReduceCtx<InputRow> {
  /** Extra SQL-query results keyed by `SqlExtraQuery.name` (SQL path only). */
  extras?: Record<string, InputRow[]>
}

export type Reducer<Params, InputRow, Result> = (
  rows: InputRow[] | Record<string, InputRow[]>,
  params: Params,
  ctx: ReduceCtx<InputRow>,
) => { results: Result, meta?: Record<string, unknown> }

export interface DefineAnalyzerOptions<
  Params extends AnalysisParams,
  InputRow,
  Result,
> {
  id: string
  /**
   * Shared reducer used by both SQL and row paths. Use this when the
   * post-aggregation row count is small and filter/sort/derive can live in
   * one place. Mutually exclusive with `reduceSql` / `reduceRows`.
   */
  reduce?: Reducer<Params, InputRow, Result>
  /** SQL-only reducer. Required when `buildSql` is set without `reduce`. */
  reduceSql?: Reducer<Params, InputRow, Result>
  /** Row-only reducer. Required when `buildRows` is set without `reduce`. */
  reduceRows?: Reducer<Params, InputRow, Result>
  /** SQL plan builder. Omit if the analyzer has no SQL path. */
  buildSql?: (params: Params) => SqlPlanSpec
  /** Row plan builder. Omit if the analyzer has no row path. */
  buildRows?: (params: Params) => Record<string, BuilderState>
  /** Capabilities required by the SQL plan. Defaults to `['executeSql', 'partitionedParquet']`. */
  sqlRequires?: readonly Capability[]
  /** Capabilities required by the row plan. Defaults to `[]`. */
  rowsRequires?: readonly Capability[]
}

export interface DefinedAnalyzer {
  id: string
  sql?: Analyzer
  rows?: Analyzer
}

const DEFAULT_SQL_REQUIRES: readonly Capability[] = ['executeSql', 'partitionedParquet']

export function defineAnalyzer<
  Params extends AnalysisParams,
  InputRow,
  Result,
>(opts: DefineAnalyzerOptions<Params, InputRow, Result>): DefinedAnalyzer {
  const {
    id,
    reduce,
    reduceSql,
    reduceRows,
    buildSql,
    buildRows,
    sqlRequires = DEFAULT_SQL_REQUIRES,
    rowsRequires = [],
  } = opts

  const sqlReducer = reduceSql ?? reduce
  const rowsReducer = reduceRows ?? reduce

  if (buildSql && !sqlReducer)
    throw new Error(`defineAnalyzer(${id}): buildSql requires reduce or reduceSql`)
  if (buildRows && !rowsReducer)
    throw new Error(`defineAnalyzer(${id}): buildRows requires reduce or reduceRows`)

  const wrap = (
    fn: Reducer<Params, InputRow, Result>,
  ) => (rows: Row[] | Record<string, Row[]>, params: Params, ctx: ReduceCtx<InputRow>) => {
    const input: unknown = Array.isArray(rows)
      ? rows
      : pickSingle(rows) ?? rows
    return fn(input as InputRow[] | Record<string, InputRow[]>, params, ctx)
  }

  const sqlAnalyzer: Analyzer | undefined = buildSql && sqlReducer
    ? {
        id,
        requires: sqlRequires,
        build(params: AnalysisParams): Plan {
          const spec = buildSql(params as Params)
          const plan: SqlPlan = {
            kind: 'sql',
            sql: spec.sql,
            params: spec.params,
            current: spec.current,
            previous: spec.previous,
            extraFiles: spec.extraFiles,
            extraQueries: spec.extraQueries,
            requiresAttachedTables: spec.requiresAttachedTables,
          }
          return plan
        },
        reduce(rows: Row[] | Record<string, Row[]>, ctx: ReduceContext) {
          const { results, meta } = wrap(sqlReducer)(rows, ctx.params as Params, {
            extras: ctx.extras as Record<string, InputRow[]> | undefined,
          })
          return { results: results as unknown as Row[], meta }
        },
      }
    : undefined

  const rowsAnalyzer: Analyzer | undefined = buildRows && rowsReducer
    ? {
        id,
        requires: rowsRequires,
        build(params: AnalysisParams): Plan {
          const queries = buildRows(params as Params)
          const plan: RowQueriesPlan = {
            kind: 'rows',
            queries: Object.fromEntries(
              Object.entries(queries).map(([k, state]) => [k, { state }]),
            ),
          }
          return plan
        },
        reduce(rows: Row[] | Record<string, Row[]>, ctx: ReduceContext) {
          const { results, meta } = wrap(rowsReducer)(rows, ctx.params as Params, {})
          return { results: results as unknown as Row[], meta }
        },
      }
    : undefined

  return { id, sql: sqlAnalyzer, rows: rowsAnalyzer }
}

function pickSingle(rows: Record<string, Row[]>): Row[] | undefined {
  const keys = Object.keys(rows)
  return keys.length === 1 ? rows[keys[0]!] : undefined
}

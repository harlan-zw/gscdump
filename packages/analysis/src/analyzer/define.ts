/**
 * `defineAnalyzer` — single authoring site for an analyzer that can be
 * executed via SQL (against a `SqlQuerySource`) or via a row query plan
 * (against a `RowQuerySource` — e.g. GSC live API, in-memory rows).
 *
 * The goal is parity: a single typed `InputRow` describes the rows both
 * plans feed into one shared `reduce`. Derivation + filtering + sorting
 * live in `reduce`, so the SQL query stays minimal (aggregation only) and
 * the row path reuses the same logic. Authors only restate the plan-side
 * work; the reducer is written once.
 *
 * Returned `sql` / `rows` are plain `Analyzer` values — the existing
 * `AnalyzerRegistry` pipeline, dispatcher, and variant-resolution logic
 * consume them unchanged.
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

export interface DefineAnalyzerOptions<
  Params extends AnalysisParams,
  InputRow,
  Result,
> {
  id: string
  /**
   * Pure reducer: typed rows → `{ results, meta }`. Shared by SQL + row
   * plans. Receives a flat array when `buildRows` returns a single-query
   * plan (and for SQL plans), or a keyed record matching the query names
   * for multi-query plans.
   */
  reduce: (
    rows: InputRow[] | Record<string, InputRow[]>,
    params: Params,
  ) => { results: Result[], meta?: Record<string, unknown> }
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
    buildSql,
    buildRows,
    sqlRequires = DEFAULT_SQL_REQUIRES,
    rowsRequires = [],
  } = opts

  const callReduce = (rows: Row[] | Record<string, Row[]>, params: Params): { results: Result[], meta?: Record<string, unknown> } => {
    const input: unknown = Array.isArray(rows)
      ? rows
      : pickSingle(rows) ?? rows
    return reduce(input as InputRow[] | Record<string, InputRow[]>, params)
  }

  const sqlAnalyzer: Analyzer | undefined = buildSql
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
          return callReduce(rows, ctx.params as Params)
        },
      }
    : undefined

  const rowsAnalyzer: Analyzer | undefined = buildRows
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
          return callReduce(rows, ctx.params as Params)
        },
      }
    : undefined

  return { id, sql: sqlAnalyzer, rows: rowsAnalyzer }
}

function pickSingle(rows: Record<string, Row[]>): Row[] | undefined {
  const keys = Object.keys(rows)
  return keys.length === 1 ? rows[keys[0]!] : undefined
}

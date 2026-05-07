/**
 * `@gscdump/engine/source` — engine-backed query source + typed-query
 * ergonomics. Wraps a `StorageEngine` as an `AnalysisQuerySource` so analyzers
 * dispatch uniformly via `runAnalyzerFromSource`.
 */

import type { BuilderState } from 'gscdump/query'
import type { PlannerCapabilities } from 'gscdump/query/plan'
import type { AnalysisParams, AnalysisResult } from '../analysis-types'
import type { AnalyzerRegistry } from '../analyzer/registry'
import type { StorageEngine, TenantCtx } from '../storage'
import type {
  AnalysisQuerySource,
  ExecuteSqlOptions,
  QueryRow,
  SourceCapabilities,
} from './source-types'
import { runAnalyzerFromSource } from '../analyzer/dispatch'
import { assertDimensionsSupported, getFilterDimensions, pgResolverAdapter } from '../resolver'

export type { AttachedTableRunner, AttachedTableSourceOptions } from './attached-table'
export { AttachedTableMissingError, createAttachedTableSource, rewriteForTableSource } from './attached-table'
export { createSqlQuerySource } from './create-sql-query-source'
export type { CreateSqlQuerySourceOptions } from './create-sql-query-source'
export type {
  AnalysisQuerySource,
  AnalysisSourceKind,
  ExecuteSqlOptions,
  FileSet,
  QueryRow,
  SourceCapabilities,
} from './source-types'

function isMetricDimension(dim: string): dim is 'clicks' | 'impressions' | 'ctr' | 'position' {
  return ['clicks', 'impressions', 'ctr', 'position'].includes(dim)
}

/**
 * Capabilities the engine query path honors. Matches what the DuckDB compiler
 * passes to `buildLogicalPlan`: regex pushes down; comparison joins and
 * multi-dataset queries belong to the analyzer dispatcher, not the engine's
 * builder-state query path.
 */
export const ENGINE_QUERY_CAPABILITIES: PlannerCapabilities = {
  regex: true,
  multiDataset: false,
  comparisonJoin: false,
  windowTotals: false,
}

const ENGINE_SOURCE_CAPABILITIES: SourceCapabilities = {
  ...ENGINE_QUERY_CAPABILITIES,
  fileSets: true,
  executeSql: true,
  adapter: true,
}

export interface EngineQuerySourceOptions {
  engine: StorageEngine
  ctx: TenantCtx
}

/**
 * Wraps a storage engine as an `AnalysisQuerySource` with SQL execution.
 * `queryRows` runs typed builder-state queries; `executeSql` delegates to
 * `engine.runSQL` and requires `opts.fileSets` (with a `FILES` entry so the
 * target table can be resolved for partition lookup).
 */
export function createEngineQuerySource(
  options: EngineQuerySourceOptions,
): AnalysisQuerySource {
  const { engine, ctx } = options

  return {
    name: 'engine',
    kind: 'local',
    capabilities: ENGINE_SOURCE_CAPABILITIES,
    adapter: pgResolverAdapter,
    async queryRows(state: BuilderState): Promise<QueryRow[]> {
      const filterDims = getFilterDimensions(state.filter, isMetricDimension)
      assertDimensionsSupported([...state.dimensions, ...filterDims], 'stored', 'engine query source')
      if (state.dimensions.includes('queryCanonical') || filterDims.includes('queryCanonical')) {
        throw new Error('engine query source does not support queryCanonical; use browser/sqlite query sources for derived dimensions')
      }
      const result = await engine.query(ctx, state)
      return result.rows as QueryRow[]
    },
    async executeSql(sql: string, params?: unknown[], opts?: ExecuteSqlOptions): Promise<QueryRow[]> {
      const fileSets = opts?.fileSets
      if (!fileSets?.FILES)
        throw new Error('engine query source: executeSql requires opts.fileSets with a FILES entry')
      const { rows } = await engine.runSQL({
        ctx,
        table: fileSets.FILES.table,
        fileSets,
        sql,
        params: params ?? [],
      })
      return rows as QueryRow[]
    },
  }
}

/**
 * Convenience: wrap a storage engine + tenant ctx in a source and dispatch.
 * Equivalent to
 * `runAnalyzerFromSource(createEngineQuerySource({ engine, ctx }), params, registry)`.
 */
export async function runAnalyzerWithEngine(
  deps: { engine: StorageEngine },
  ctx: TenantCtx,
  params: AnalysisParams,
  registry: AnalyzerRegistry,
): Promise<AnalysisResult> {
  return runAnalyzerFromSource(
    createEngineQuerySource({ engine: deps.engine, ctx }),
    params,
    registry,
  )
}

// ---------------------------------------------------------------------------
// Typed-query ergonomics. Generic helpers over AnalysisQuerySource for typed
// row shapes.
// ---------------------------------------------------------------------------

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

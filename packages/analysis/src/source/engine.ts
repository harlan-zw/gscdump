import type { StorageEngine, TenantCtx } from '@gscdump/engine/contracts'
import type { BuilderState } from 'gscdump/query'
import type { PlannerCapabilities } from 'gscdump/query/plan'

import type { AnalyzerRegistry } from '../analyzer/registry'
import type { AnalysisParams, AnalysisResult } from '../types'

import type { ExecuteSqlOptions, QueryRow, SourceCapabilities, SqlQuerySource } from './types'
import { assertDimensionsSupported, getFilterDimensions } from '@gscdump/engine/resolver'
import { runAnalyzerFromSource } from '../analyzer/dispatch'

function isMetricDimension(dim: string): dim is 'clicks' | 'impressions' | 'ctr' | 'position' {
  return ['clicks', 'impressions', 'ctr', 'position'].includes(dim)
}

/**
 * Capabilities the engine query path honors. Matches what the DuckDB compiler
 * passes to {@link buildLogicalPlan} (see `gscdump/analytics/compiler`): regex
 * pushes down; comparison joins and multi-dataset queries belong to the
 * analyzer dispatcher, not the engine's builder-state query path.
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
  localSource: true,
}

export interface EngineQuerySourceOptions {
  engine: StorageEngine
  ctx: TenantCtx
}

/**
 * Wraps a storage engine as a {@link SqlQuerySource}. `queryRows` runs typed
 * builder-state queries; `executeSql` delegates to `engine.runSQL` and
 * requires `opts.fileSets` (with a `FILES` entry so the target table can be
 * resolved for partition lookup).
 */
export function createEngineQuerySource(
  options: EngineQuerySourceOptions,
): SqlQuerySource {
  const { engine, ctx } = options

  return {
    name: 'engine',
    capabilities: ENGINE_SOURCE_CAPABILITIES,
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

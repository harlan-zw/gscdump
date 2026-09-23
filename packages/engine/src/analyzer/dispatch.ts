/**
 * Unified dispatcher. Takes an `Analyzer` + `AnalysisQuerySource` and produces
 * `AnalysisResult`. SQL plans carrying `{{FILES}}` placeholders are handed to
 * the source's `executeSql` with `opts.fileSets`; sources that advertise
 * `capabilities.fileSets` consume them, others ignore them.
 */

import type { BuilderState } from 'gscdump/query'
import type { AnalysisParams, AnalysisResult, AnalyzerCoverage } from '../analysis-types'
import type { EngineError } from '../errors'
import type { AnalysisQuerySource, FileSet, QueryRow } from '../source/source-types'
import type { AnalyzerRegistry } from './registry'
import type { Analyzer, Plan, RequiredCapability, RowQueriesPlan, SqlPlan } from './types'
import { isQueryError } from 'gscdump/query'
import { engineErrors } from '../errors'

type AnalyzerRow = QueryRow

export class AnalyzerCapabilityError extends Error {
  readonly engineError: EngineError
  constructor(
    public readonly tool: string,
    public readonly missing: readonly RequiredCapability[],
  ) {
    const engineError = engineErrors.analyzerCapabilityMissing(tool, missing)
    super(engineError.message)
    this.name = 'AnalyzerCapabilityError'
    this.engineError = engineError
  }
}

/**
 * True when `err` is the planner's cross-dimension `unresolvable-dataset`
 * failure. Prefers the typed `queryError` value stashed on the thrown
 * `UnresolvableDatasetError` (version-robust); falls back to the historical
 * name match for errors raised by an older `gscdump`.
 */
function isUnresolvableDatasetError(err: unknown): boolean {
  const queryError = (err as { queryError?: unknown } | null)?.queryError
  if (isQueryError(queryError) && queryError.kind === 'unresolvable-dataset')
    return true
  return (err as { name?: string } | null)?.name === 'UnresolvableDatasetError'
}

function sourceHas(source: AnalysisQuerySource, cap: RequiredCapability): boolean {
  if (cap === 'executeSql')
    return typeof source.executeSql === 'function'
  return source.capabilities[cap] === true
}

function assertSatisfies(analyzer: Analyzer, source: AnalysisQuerySource): void {
  const missing = analyzer.requires.filter(c => !sourceHas(source, c))
  if (missing.length > 0)
    throw new AnalyzerCapabilityError(analyzer.id, missing)
}

/**
 * Run an analyzer against a generic `AnalysisQuerySource`. The registry is
 * an explicit parameter — callers build one via `createAnalyzerRegistry`.
 */
export async function runAnalyzerFromSource(
  source: AnalysisQuerySource,
  params: AnalysisParams,
  registry: AnalyzerRegistry,
): Promise<AnalysisResult> {
  let analyzer = registry.resolveAnalyzer(params.type, sourceHas(source, 'executeSql'))
  if (!analyzer)
    throw new AnalyzerCapabilityError(params.type, ['executeSql'])
  assertSatisfies(analyzer, source)

  const buildCtx = { adapter: source.adapter, siteId: source.siteId }
  let plan: Plan
  try {
    plan = analyzer.build(params, buildCtx)
  }
  catch (err) {
    // A cross-dimension query the SQL resolver can't satisfy from stored
    // tables (`unresolvable-dataset`, recognised by its typed `queryError`).
    // If the analyzer has a row-query variant, dispatch that instead — its
    // `BuilderState`s run through `queryRows`, which the composite source
    // routes to the live GSC API. Other build errors and a missing rows
    // variant both propagate unchanged.
    const rowsVariant = isUnresolvableDatasetError(err)
      ? registry.getAnalyzerVariants(params.type)?.rows
      : undefined
    if (!rowsVariant)
      throw err
    assertSatisfies(rowsVariant, source)
    analyzer = rowsVariant
    plan = rowsVariant.build(params, buildCtx)
  }

  if (plan.kind === 'rows')
    return runRowsPlanAgainstSource(source, analyzer, plan, params)
  return runSqlPlanAgainstSource(source, analyzer, plan, params)
}

/** Rows from one plan query, and whether the fetch stopped at its budget. */
interface FetchedRows {
  rows: AnalyzerRow[]
  truncated: boolean
}

/**
 * Run one row query. A query whose row count reaches its `rowLimit` may have
 * more matching rows than it returned, so it reports `truncated: true`.
 */
async function fetchPlanRows(source: AnalysisQuerySource, state: BuilderState): Promise<FetchedRows> {
  const rows = await source.queryRows(state)
  const truncated = state.rowLimit != null && rows.length >= state.rowLimit
  return { rows, truncated }
}

/** Fold per-query fetch results into one coverage value for the run. */
function coverageOf(fetches: readonly FetchedRows[]): AnalyzerCoverage {
  const truncated = fetches.filter(f => f.truncated)
  if (truncated.length === 0)
    return { kind: 'complete' }
  return { kind: 'truncated', fetched: Math.max(...truncated.map(f => f.rows.length)) }
}

async function runRowsPlanAgainstSource(
  source: AnalysisQuerySource,
  analyzer: Analyzer,
  plan: RowQueriesPlan,
  params: AnalysisParams,
): Promise<AnalysisResult> {
  const entries = Object.entries(plan.queries)
  const fetched = await Promise.all(
    entries.map(async ([k, q]) => [k, await fetchPlanRows(source, q.state)] as const),
  )
  const rowMap = Object.fromEntries(fetched.map(([k, f]) => [k, f.rows])) as Record<string, AnalyzerRow[]>
  const { results, meta } = analyzer.reduce(rowMap, { params })
  return {
    results: results as AnalysisResult['results'],
    meta: { tool: params.type, ...meta, coverage: coverageOf(fetched.map(([, f]) => f)) },
  }
}

function fileSetsFor(plan: SqlPlan): Record<string, FileSet> {
  const fileSets: Record<string, FileSet> = { FILES: plan.current }
  if (plan.previous)
    fileSets.FILES_PREV = plan.previous
  if (plan.extraFiles) {
    for (const [key, fs] of Object.entries(plan.extraFiles))
      fileSets[`FILES_${key}`] = fs
  }
  return fileSets
}

async function runSqlPlanAgainstSource(
  source: AnalysisQuerySource,
  analyzer: Analyzer,
  plan: SqlPlan,
  params: AnalysisParams,
): Promise<AnalysisResult> {
  if (!source.executeSql)
    throw new AnalyzerCapabilityError(analyzer.id, ['executeSql'])

  const fileSets = source.capabilities.fileSets ? fileSetsFor(plan) : undefined

  const rows = await source.executeSql(plan.sql, plan.params, fileSets ? { fileSets } : undefined)
  const extras: Record<string, AnalyzerRow[]> = {}
  if (plan.extraQueries) {
    for (const q of plan.extraQueries) {
      const extraRows = await source.executeSql(q.sql, q.params, fileSets ? { fileSets } : undefined)
      extras[q.name] = extraRows
    }
  }
  const { results, meta } = analyzer.reduce(rows, { params, extras })
  const sourceMeta: { source?: string } = source.kind ? { source: source.kind } : {}
  return {
    results: results as AnalysisResult['results'],
    meta: { tool: params.type, ...sourceMeta, ...meta, coverage: { kind: 'complete' } },
  }
}

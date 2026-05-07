/**
 * Unified dispatcher. Takes an `Analyzer` + `AnalysisQuerySource` and produces
 * `AnalysisResult`. SQL plans carrying `{{FILES}}` placeholders are handed to
 * the source's `executeSql` with `opts.fileSets`; sources that advertise
 * `capabilities.fileSets` consume them, others ignore them.
 */

import type { AnalysisParams, AnalysisResult } from '../analysis-types'
import type { AnalysisQuerySource, FileSet, QueryRow } from '../source/source-types'
import type { AnalyzerRegistry } from './registry'
import type { Analyzer, RequiredCapability, RowQueriesPlan, SqlPlan } from './types'

type AnalyzerRow = QueryRow

export class AnalyzerCapabilityError extends Error {
  constructor(
    public readonly tool: string,
    public readonly missing: readonly RequiredCapability[],
  ) {
    super(`analyzer "${tool}" requires capabilities [${missing.join(', ')}] not provided by source`)
    this.name = 'AnalyzerCapabilityError'
  }
}

function sourceHas(source: AnalysisQuerySource, cap: RequiredCapability): boolean {
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
  const analyzer = registry.resolveAnalyzer(params.type, sourceHas(source, 'executeSql'))
  if (!analyzer)
    throw new AnalyzerCapabilityError(params.type, ['executeSql'])
  assertSatisfies(analyzer, source)

  const plan = analyzer.build(params, { adapter: source.adapter, siteId: source.siteId })
  if (plan.kind === 'rows')
    return runRowsPlanAgainstSource(source, analyzer, plan, params)
  return runSqlPlanAgainstSource(source, analyzer, plan, params)
}

async function runRowsPlanAgainstSource(
  source: AnalysisQuerySource,
  analyzer: Analyzer,
  plan: RowQueriesPlan,
  params: AnalysisParams,
): Promise<AnalysisResult> {
  const entries = Object.entries(plan.queries)
  const resolved = await Promise.all(
    entries.map(async ([k, q]) => [k, await source.queryRows(q.state)] as const),
  )
  const rowMap = Object.fromEntries(resolved) as Record<string, AnalyzerRow[]>
  const { results, meta } = analyzer.reduce(rowMap, { params })
  return {
    results: results as AnalysisResult['results'],
    meta: { tool: params.type, ...meta },
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
    meta: { tool: params.type, ...sourceMeta, ...meta },
  }
}

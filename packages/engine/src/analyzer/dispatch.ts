/**
 * Unified dispatcher. Takes an `Analyzer` + `AnalysisQuerySource` and produces
 * `AnalysisResult`. SQL plans carrying `{{FILES}}` placeholders are handed to
 * the source's `executeSql` with `opts.fileSets`; sources that advertise
 * `capabilities.fileSets` consume them, others ignore them.
 */

import type { AnalysisParams, AnalysisResult } from '../analysis-types'
import type { AnalysisQuerySource, FileSet, QueryRow } from '../resolver/source-types'
import type { AnalyzerRegistry } from './registry'
import type { Analyzer, Capability, RowQueriesPlan, SqlPlan } from './types'

type AnalyzerRow = QueryRow

export class AnalyzerCapabilityError extends Error {
  constructor(
    public readonly tool: string,
    public readonly missing: readonly Capability[],
  ) {
    super(`analyzer "${tool}" requires capabilities [${missing.join(', ')}] not provided by source`)
    this.name = 'AnalyzerCapabilityError'
  }
}

function sourceCapabilities(source: AnalysisQuerySource): ReadonlySet<Capability> {
  const caps = new Set<Capability>()
  if (source.executeSql)
    caps.add('executeSql')
  if (source.capabilities.fileSets)
    caps.add('partitionedParquet')
  if (source.capabilities.regex)
    caps.add('regex')
  if (source.capabilities.windowTotals)
    caps.add('windowTotals')
  if (source.capabilities.comparisonJoin)
    caps.add('comparisonJoin')
  if (source.capabilities.attachedTables)
    caps.add('attachedTables')
  return caps
}

function assertSatisfies(analyzer: Analyzer, caps: ReadonlySet<Capability>): void {
  const missing = analyzer.requires.filter(c => !caps.has(c))
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
  const caps = sourceCapabilities(source)
  const analyzer = registry.resolveAnalyzer(
    params.type,
    caps.has('executeSql') || caps.has('attachedTables'),
  )
  if (!analyzer)
    throw new AnalyzerCapabilityError(params.type, ['executeSql'])
  assertSatisfies(analyzer, caps)

  const plan = analyzer.build(params)
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
  if (plan.requiresAttachedTables && !source.capabilities.attachedTables)
    throw new AnalyzerCapabilityError(analyzer.id, ['attachedTables'])

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
  const sourceMeta: { source?: string } = source.capabilities.localSource
    ? { source: 'local' }
    : source.capabilities.attachedTables
      ? { source: 'browser' }
      : {}
  return {
    results: results as AnalysisResult['results'],
    meta: { tool: params.type, ...sourceMeta, ...meta },
  }
}

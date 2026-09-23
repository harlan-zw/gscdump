import type { AnalysisParams, AnalysisResult, AnalysisTool } from '@gscdump/engine/analysis-types'
import type { ReportCoverage, ReportSection, ReportSectionArtifact } from '@gscdump/engine/report'

export function reportRows<T>(result: AnalysisResult | undefined): T[] {
  return (result?.results ?? []) as unknown as T[]
}

/** `partial` when the step failed or read only part of its rows. */
export function sectionCoverage(result: AnalysisResult | undefined): ReportCoverage {
  return result && result.meta.coverage?.kind !== 'truncated' ? 'full' : 'partial'
}

/**
 * Full match count for a step: the analyzer's `meta.total` when it reports
 * one, else the row count. Use it when the section keeps every row it reads,
 * so `truncated.total` counts rows the step's output `limit` dropped.
 */
export function resultTotal(result: AnalysisResult | undefined, fallback: number): number {
  const total = result?.meta.total
  return typeof total === 'number' ? Math.max(total, fallback) : fallback
}

export function sectionArtifact(
  result: AnalysisResult | undefined,
  analyzer: AnalysisTool,
  params: Omit<AnalysisParams, 'type'> = {},
): ReportSectionArtifact | undefined {
  return result
    ? { analyzer, params: { type: analyzer, ...params } as AnalysisParams }
    : undefined
}

export function truncation(total: number, kept: number): ReportSection['truncated'] {
  return total > kept ? { kept, total } : undefined
}

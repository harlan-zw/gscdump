import type { AnalysisParams, AnalysisResult, AnalysisTool } from '@gscdump/engine/analysis-types'
import type { ReportCoverage, ReportSection, ReportSectionArtifact } from '@gscdump/engine/report'

export function reportRows<T>(result: AnalysisResult | undefined): T[] {
  return (result?.results ?? []) as unknown as T[]
}

export function sectionCoverage(result: AnalysisResult | undefined): ReportCoverage {
  return result ? 'full' : 'partial'
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

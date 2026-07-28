import type { AnalysisParams } from './analysis-types'
import { extractDateRange, normalizeFilter } from 'gscdump/query'

export interface AnalysisCoverageRange {
  start: string
  end: string
}

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/

function addRange(ranges: AnalysisCoverageRange[], start: unknown, end: unknown): void {
  if (typeof start !== 'string' || typeof end !== 'string')
    return
  if (!ISO_DATE_RE.test(start) || !ISO_DATE_RE.test(end) || end < start)
    return
  ranges.push({ start, end })
}

export function analysisRequestedRange(
  params: AnalysisParams,
  onInvalidFilter?: (error: unknown) => void,
): AnalysisCoverageRange | null {
  const ranges: AnalysisCoverageRange[] = []
  addRange(ranges, params.startDate, params.endDate)
  addRange(ranges, params.prevStartDate, params.prevEndDate)

  for (const state of [params.q, params.qc]) {
    if (!state)
      continue
    const direct = state.filter as { startDate?: unknown, endDate?: unknown } | undefined
    addRange(ranges, direct?.startDate, direct?.endDate)
    try {
      const normalized = normalizeFilter(state.filter) ?? state.filter
      const extracted = extractDateRange(normalized as typeof state.filter)
      addRange(ranges, extracted.startDate, extracted.endDate)
    }
    catch (error) {
      if (!onInvalidFilter)
        throw error
      onInvalidFilter(error)
    }
  }

  if (ranges.length === 0)
    return null
  return ranges.reduce((range, next) => ({
    start: next.start < range.start ? next.start : range.start,
    end: next.end > range.end ? next.end : range.end,
  }))
}

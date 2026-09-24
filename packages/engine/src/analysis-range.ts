import type { SearchType } from 'gscdump/query'
import type { AnalysisParams } from './analysis-types'
import { addDays } from 'gscdump/dates'
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

// ---------------------------------------------------------------------------
// Coverage plan
// ---------------------------------------------------------------------------

export interface DateSpan {
  start: string
  end: string
}

/**
 * Where a host reads synced dates from. gscdump.com reads its ingest
 * ledger; the CLI reads the Store's sync states. `table` is a string so a
 * host can name its own derived tables.
 */
export interface CoverageReader {
  datesForTable: (opts: { table: string, searchType: SearchType, start: string, end: string }) => Promise<readonly string[]>
}

export interface CoveragePlanTable {
  table: string
  required: boolean
  coveredSpans: DateSpan[]
  gaps: DateSpan[]
}

export interface CoveragePlan {
  searchType: SearchType
  requested: DateSpan
  tables: CoveragePlanTable[]
  /** Every required table covers the requested range (less the tail grace). */
  complete: boolean
  /** Hash of the covered spans. It changes when coverage changes. */
  coverageVersion: string
}

export interface BuildCoveragePlanOptions {
  searchType: SearchType
  requested: DateSpan
  tables: readonly (string | { table: string, required?: boolean })[]
  reader: CoverageReader
  /** Ignore the still-restating tail when deciding whether coverage is complete. */
  tailGraceDays?: number
  /** Tables read at once. Default 3. */
  concurrency?: number
}

/** Sorted, merged spans of consecutive dates. */
export function consolidateDatesToSpans(dates: readonly string[]): DateSpan[] {
  if (dates.length === 0)
    return []
  const sorted = [...new Set(dates)].sort()
  const out: DateSpan[] = []
  let start = sorted[0]!
  let end = sorted[0]!
  for (const date of sorted.slice(1)) {
    if (date === addDays(end, 1)) {
      end = date
      continue
    }
    out.push({ start, end })
    start = date
    end = date
  }
  out.push({ start, end })
  return out
}

/** The parts of `requested` that no span covers. Spans must be sorted and disjoint. */
export function gapsForRange(coveredSpans: readonly DateSpan[], requested: DateSpan): DateSpan[] {
  const gaps: DateSpan[] = []
  let cursor = requested.start
  for (const span of coveredSpans) {
    if (span.end < cursor)
      continue
    if (span.start > requested.end)
      break
    if (span.start > cursor)
      gaps.push({ start: cursor, end: addDays(span.start, -1) })
    if (span.end >= requested.end)
      return gaps
    cursor = addDays(span.end, 1)
  }
  if (cursor <= requested.end)
    gaps.push({ start: cursor, end: requested.end })
  return gaps
}

/** Days in a span, both ends included. */
export function spanDays(span: DateSpan): number {
  return Math.round((Date.parse(`${span.end}T00:00:00Z`) - Date.parse(`${span.start}T00:00:00Z`)) / 86_400_000) + 1
}

async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = Array.from({ length: items.length })
  let next = 0
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const index = next++
      out[index] = await fn(items[index]!)
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker))
  return out
}

async function hashCoverage(parts: string[]): Promise<string> {
  const data = new TextEncoder().encode(parts.sort().join('\n'))
  const digest = await crypto.subtle.digest('SHA-256', data)
  return [...new Uint8Array(digest).slice(0, 16)].map(byte => byte.toString(16).padStart(2, '0')).join('')
}

/**
 * Per-table coverage of one requested range. Pure over the reader: the
 * host decides where synced dates live.
 */
export async function buildCoveragePlan(opts: BuildCoveragePlanOptions): Promise<CoveragePlan> {
  const { requested, searchType } = opts
  const graceEnd = opts.tailGraceDays && opts.tailGraceDays > 0 ? addDays(requested.end, -opts.tailGraceDays) : requested.end
  const gate: DateSpan = { start: requested.start, end: graceEnd < requested.start ? requested.start : graceEnd }

  const tables = await mapLimit(opts.tables, opts.concurrency ?? 3, async (raw) => {
    const input = typeof raw === 'string' ? { table: raw, required: true } : { table: raw.table, required: raw.required ?? true }
    const dates = await opts.reader.datesForTable({ table: input.table, searchType, start: requested.start, end: requested.end })
    const coveredSpans = consolidateDatesToSpans(dates.filter(date => date >= requested.start && date <= requested.end))
    return { table: input.table, required: input.required, coveredSpans, gaps: gapsForRange(coveredSpans, requested) }
  })
  const required = tables.filter(table => table.required)
  return {
    searchType,
    requested: { ...requested },
    tables,
    complete: required.length > 0 && required.every(table => gapsForRange(table.coveredSpans, gate).length === 0),
    coverageVersion: await hashCoverage(tables.flatMap(table => table.coveredSpans.map(span => `${table.table}\0${span.start}\0${span.end}`))),
  }
}

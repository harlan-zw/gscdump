/**
 * Analyzer period primitives. Core window algebra belongs to `gscdump/dates`.
 * This subpath re-exports it for analyzer consumers.
 */

import type { AnalysisParams } from '../analysis-types'
import { daysAgoUtc as daysAgo, MS_PER_DAY, toIsoDate } from 'gscdump/dates'

export type {
  ComparisonMode,
  ResolvedWindow,
  ResolveWindowOptions,
  WindowPreset,
} from 'gscdump/dates'
export { resolveWindow } from 'gscdump/dates'

export interface AnalysisPeriod {
  startDate: string
  endDate: string
}

export interface ComparisonPeriod {
  current: AnalysisPeriod
  previous: AnalysisPeriod
}

export function defaultEndDate(): string {
  return daysAgo(3)
}

function defaultStartDate(): string {
  return daysAgo(31)
}

export function periodOf(params: AnalysisParams): AnalysisPeriod {
  return {
    startDate: params.startDate || defaultStartDate(),
    endDate: params.endDate || defaultEndDate(),
  }
}

export function comparisonOf(params: AnalysisParams): ComparisonPeriod {
  if (!params.prevStartDate || !params.prevEndDate)
    throw new Error(`${params.type} analysis requires prevStartDate and prevEndDate`)
  return {
    current: periodOf(params),
    previous: { startDate: params.prevStartDate, endDate: params.prevEndDate },
  }
}

export interface PadTimeseriesOptions<T> {
  /** ISO date (YYYY-MM-DD), inclusive lower bound. */
  startDate: string
  /** ISO date (YYYY-MM-DD), inclusive upper bound. */
  endDate: string
  /**
   * Row to insert for missing dates. Defaults to `{ clicks: 0, impressions: 0, ctr: 0, position: 0 }`.
   * The `date` field is set automatically.
   */
  fill?: Omit<T, 'date'>
  /** Row-field that carries the ISO date. Defaults to `date`. */
  dateKey?: string
}

type DateRowShape = Record<string, unknown> & { date?: unknown }

const DEFAULT_FILL = { clicks: 0, impressions: 0, ctr: 0, position: 0 } as const

/**
 * Pad rows so every calendar day in `[startDate, endDate]` appears at least
 * once. Existing dates keep all their rows (grouped timeseries safe).
 */
export function padTimeseries<T extends DateRowShape = DateRowShape>(
  rows: readonly T[],
  options: PadTimeseriesOptions<T>,
): T[] {
  const { startDate, endDate } = options
  const dateKey = options.dateKey ?? 'date'
  const fill = options.fill ?? (DEFAULT_FILL as unknown as Omit<T, 'date'>)

  const byDate = new Map<string, T[]>()
  for (const row of rows) {
    const d = String(row[dateKey])
    const bucket = byDate.get(d)
    if (bucket)
      bucket.push(row)
    else
      byDate.set(d, [row])
  }

  const result: T[] = []
  const start = new Date(`${startDate}T00:00:00Z`)
  const end = new Date(`${endDate}T00:00:00Z`)
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()))
    throw new Error(`padTimeseries: invalid date range ${startDate}..${endDate}`)

  for (let cursorMs = start.getTime(), endMs = end.getTime(); cursorMs <= endMs; cursorMs += MS_PER_DAY) {
    const dateStr = toIsoDate(new Date(cursorMs))
    const existing = byDate.get(dateStr)
    if (existing)
      result.push(...existing)
    else
      result.push({ ...fill, [dateKey]: dateStr } as T)
  }
  return result
}

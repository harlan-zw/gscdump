/**
 * Period + window primitives for analytics queries.
 *
 * Dialect-agnostic: no database dependency. Single source of truth for:
 * - preset → [start, end] window resolution with comparison ranges
 * - AnalysisPeriod / ComparisonPeriod shapes consumed by source analyzers
 * - padTimeseries for dense daily series
 */

import type { AnalysisParams } from '../types'

export type WindowPreset
  = | 'last-7d'
    | 'last-28d'
    | 'last-30d'
    | 'last-90d'
    | 'last-180d'
    | 'last-365d'
    | 'mtd'
    | 'ytd'
    | 'custom'

export type ComparisonMode = 'none' | 'prev-period' | 'yoy'

export interface ResolveWindowOptions {
  preset: WindowPreset
  comparison?: ComparisonMode
  anchor?: string
  start?: string
  end?: string
}

export interface ResolvedWindow {
  start: string
  end: string
  days: number
  comparison?: {
    start: string
    end: string
  }
}

export interface AnalysisPeriod {
  startDate: string
  endDate: string
}

export interface ComparisonPeriod {
  current: AnalysisPeriod
  previous: AnalysisPeriod
}

function defaultEndDate(): string {
  return new Date(Date.now() - 3 * 86400000).toISOString().split('T')[0]!
}

function defaultStartDate(): string {
  return new Date(Date.now() - 31 * 86400000).toISOString().split('T')[0]!
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

function toIso(d: Date): string {
  return d.toISOString().slice(0, 10)
}

function parseIso(s: string): Date {
  return new Date(`${s}T00:00:00Z`)
}

function addDays(d: Date, n: number): Date {
  const out = new Date(d.getTime())
  out.setUTCDate(out.getUTCDate() + n)
  return out
}

function daysBetween(start: string, end: string): number {
  return Math.round((parseIso(end).getTime() - parseIso(start).getTime()) / 86400000) + 1
}

export function resolveWindow(opts: ResolveWindowOptions): ResolvedWindow {
  const anchor = opts.anchor ? parseIso(opts.anchor) : new Date()
  const anchorIso = toIso(anchor)

  let start: string
  let end: string

  switch (opts.preset) {
    case 'last-7d':
      end = anchorIso
      start = toIso(addDays(anchor, -6))
      break
    case 'last-28d':
      end = anchorIso
      start = toIso(addDays(anchor, -27))
      break
    case 'last-30d':
      end = anchorIso
      start = toIso(addDays(anchor, -29))
      break
    case 'last-90d':
      end = anchorIso
      start = toIso(addDays(anchor, -89))
      break
    case 'last-180d':
      end = anchorIso
      start = toIso(addDays(anchor, -179))
      break
    case 'last-365d':
      end = anchorIso
      start = toIso(addDays(anchor, -364))
      break
    case 'mtd':
      end = anchorIso
      start = toIso(new Date(Date.UTC(anchor.getUTCFullYear(), anchor.getUTCMonth(), 1)))
      break
    case 'ytd':
      end = anchorIso
      start = toIso(new Date(Date.UTC(anchor.getUTCFullYear(), 0, 1)))
      break
    case 'custom':
      if (!opts.start || !opts.end)
        throw new Error('resolveWindow: preset=custom requires start and end')
      start = opts.start
      end = opts.end
      break
  }

  const days = daysBetween(start, end)
  const result: ResolvedWindow = { start, end, days }

  const mode = opts.comparison ?? 'none'
  if (mode === 'prev-period') {
    const prevEnd = toIso(addDays(parseIso(start), -1))
    const prevStart = toIso(addDays(parseIso(prevEnd), -(days - 1)))
    result.comparison = { start: prevStart, end: prevEnd }
  }
  else if (mode === 'yoy') {
    const prevEnd = toIso(addDays(parseIso(end), -365))
    const prevStart = toIso(addDays(parseIso(start), -365))
    result.comparison = { start: prevStart, end: prevEnd }
  }

  return result
}

/** Convert a ResolvedWindow into the AnalysisPeriod / ComparisonPeriod shape. */
export function windowToPeriod(w: ResolvedWindow): AnalysisPeriod {
  return { startDate: w.start, endDate: w.end }
}

export function windowToComparisonPeriod(w: ResolvedWindow): ComparisonPeriod | undefined {
  if (!w.comparison)
    return undefined
  return {
    current: { startDate: w.start, endDate: w.end },
    previous: { startDate: w.comparison.start, endDate: w.comparison.end },
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

  for (let cursorMs = start.getTime(), endMs = end.getTime(); cursorMs <= endMs; cursorMs += 86_400_000) {
    const dateStr = new Date(cursorMs).toISOString().slice(0, 10)
    const existing = byDate.get(dateStr)
    if (existing)
      result.push(...existing)
    else
      result.push({ ...fill, [dateKey]: dateStr } as T)
  }
  return result
}

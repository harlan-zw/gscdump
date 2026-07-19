// Period algebra: maps user-facing period selectors (`7d`, `28d`, `this-month`,
// custom drag-zooms…) to absolute date ranges. PST-anchored to match GSC's
// processing timezone. Three comparison bases: previous-period, year-over-year,
// or none.
//
// Custom periods carry their own range and (optionally) an explicit prev range
// for drag-to-zoom interactions where the user chose both windows.

import type { WindowPreset } from '@gscdump/engine/period'
import { resolveWindow } from '@gscdump/engine/period'
import {
  startOfWeek as dfnsStartOfWeek,
  endOfMonth,
  format,
  startOfMonth,
  startOfQuarter,
  subDays,
  subMonths,
} from 'date-fns'
import { GSC_STABLE_LATENCY_DAYS } from './gsc-constants'

export type RollingPeriod = '7d' | '28d' | '3m' | '6m' | '12m'
export type CalendarPeriod = 'this-week' | 'this-month' | 'last-month' | 'this-quarter' | 'this-year'
/**
 * Custom date range from drag-to-zoom.
 *  - `custom:CS:CE` - current range only; prev range resolved by compareMode.
 *  - `custom:CS:CE:PS:PE` - explicit prev range.
 */
export type CustomPeriod = `custom:${string}:${string}` | `custom:${string}:${string}:${string}:${string}`
export type Period = RollingPeriod | CalendarPeriod | CustomPeriod
export type CompareMode = 'previous' | 'year' | 'none'

export interface DateRangeResult {
  start: string
  end: string
  prevStart: string
  prevEnd: string
  yearStart: string
  yearEnd: string
  days: number
}

export interface PeriodOptions {
  /** Subtract GSC's stable-data latency from `end`. Default `true`. */
  stableData?: boolean
  /** IANA timezone used to resolve today's calendar date. Default GSC/Pacific time. */
  timezone?: string
  /** Clock used to resolve today's calendar date. Defaults to the current time. */
  now?: Date
}

export function isCustomPeriod(p: Period | string): p is CustomPeriod {
  return typeof p === 'string' && p.startsWith('custom:')
}

export function parseCustomPeriod(p: Period | string): { start: string, end: string, prevStart?: string, prevEnd?: string } | null {
  if (!isCustomPeriod(p))
    return null
  const parts = p.split(':')
  const [, start, end, prevStart, prevEnd] = parts
  if (!start || !end)
    return null
  if (prevStart && prevEnd)
    return { start, end, prevStart, prevEnd }
  return { start, end }
}

function todayInTimezone(timezone = 'America/Los_Angeles', now = new Date()): Date {
  const date = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now)
  return new Date(`${date}T00:00:00`)
}

const ROLLING_TO_UPSTREAM: Record<string, WindowPreset> = {
  '7d': 'last-7d',
  '28d': 'last-28d',
  '3m': 'last-90d',
  '6m': 'last-180d',
  '12m': 'last-365d',
}

const CALENDAR_TO_UPSTREAM: Record<string, WindowPreset> = {
  'this-month': 'mtd',
  'this-year': 'ytd',
}

function fmt(d: Date): string {
  return format(d, 'yyyy-MM-dd')
}

function buildResultFromIso(start: string, end: string): DateRangeResult {
  const startDate = new Date(`${start}T00:00:00`)
  const endDate = new Date(`${end}T00:00:00`)
  const days = Math.round((endDate.getTime() - startDate.getTime()) / 86400000) + 1
  const prev = resolveWindow({ preset: 'custom', start, end, comparison: 'prev-period' })
  const yoy = resolveWindow({ preset: 'custom', start, end, comparison: 'yoy' })
  return {
    start,
    end,
    prevStart: prev.comparison!.start,
    prevEnd: prev.comparison!.end,
    yearStart: yoy.comparison!.start,
    yearEnd: yoy.comparison!.end,
    days,
  }
}

export function periodToDateRange(
  period: Period | string,
  stableDataOrOptions: boolean | PeriodOptions = true,
): DateRangeResult {
  const options = typeof stableDataOrOptions === 'boolean'
    ? { stableData: stableDataOrOptions }
    : stableDataOrOptions
  const stableData = options.stableData ?? true
  const custom = parseCustomPeriod(period)
  if (custom) {
    const result = buildResultFromIso(custom.start, custom.end)
    if (custom.prevStart && custom.prevEnd) {
      return {
        ...result,
        prevStart: custom.prevStart,
        prevEnd: custom.prevEnd,
        yearStart: custom.prevStart,
        yearEnd: custom.prevEnd,
      }
    }
    return result
  }

  const today = todayInTimezone(options.timezone, options.now)
  const end = stableData ? subDays(today, GSC_STABLE_LATENCY_DAYS) : subDays(today, 1)
  const endIso = fmt(end)

  const upstreamPreset = ROLLING_TO_UPSTREAM[period] ?? CALENDAR_TO_UPSTREAM[period]
  if (upstreamPreset) {
    const win = resolveWindow({ preset: upstreamPreset, anchor: endIso })
    return buildResultFromIso(win.start, win.end)
  }

  let start: Date
  switch (period) {
    case 'this-week':
      start = dfnsStartOfWeek(end, { weekStartsOn: 1 })
      break
    case 'last-month': {
      const prevMonth = subMonths(end, 1)
      return buildResultFromIso(fmt(startOfMonth(prevMonth)), fmt(endOfMonth(prevMonth)))
    }
    case 'this-quarter':
      start = startOfQuarter(end)
      break
    default:
      start = subDays(end, 27)
  }

  return buildResultFromIso(fmt(start), endIso)
}

export function periodToDays(
  period: Period | string,
  stableDataOrOptions: boolean | PeriodOptions = true,
): number {
  return periodToDateRange(period, stableDataOrOptions).days
}

export function compareRange(
  range: DateRangeResult,
  mode: CompareMode,
): { start: string, end: string } | null {
  if (mode === 'none')
    return null
  if (mode === 'year')
    return { start: range.yearStart, end: range.yearEnd }
  return { start: range.prevStart, end: range.prevEnd }
}

/**
 * GSC data within the last `GSC_STABLE_LATENCY_DAYS` (PST) is potentially
 * incomplete. Returns the cutoff date (YYYY-MM-DD); compare row dates against
 * this to dim/strike unstable points in charts.
 *
 * Uses YYYY-MM-DD string math directly to avoid UTC/local timezone shifts.
 */
export function getGscUnstableCutoffDate(): string {
  const pstStr = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' })
  const [y, m, d] = pstStr.split('-').map(Number) as [number, number, number]
  const cutoff = new Date(y, m - 1, d - GSC_STABLE_LATENCY_DAYS)
  return `${cutoff.getFullYear()}-${String(cutoff.getMonth() + 1).padStart(2, '0')}-${String(cutoff.getDate()).padStart(2, '0')}`
}

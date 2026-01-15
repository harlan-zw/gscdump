import type { Period } from '../core/types'
import { dayjs } from './dayjs'

export interface ResolvedPeriodRange {
  period: {
    startTimestamp: number
    start: Date
    startDateTime: string
    startDate: string
    end: Date
    endDate: string
    endTimestamp: number
    endDateTime: string
  }
  prevPeriod: {
    start: Date
    startDate: string
    end: Date
    endDate: string
  }
}

/**
 * Formats a date for GSC API queries (YYYY-MM-DD format).
 * @param d - Date object, date string, or null/undefined
 * @returns Formatted date string or null/undefined if input is falsy
 */
export function formatDateGsc(d?: Date | string | null): string | null | undefined {
  if (!d)
    return d as null | undefined
  if (typeof d === 'string')
    return d
  return `${d.getFullYear()}-${(d.getMonth() + 1).toString().padStart(2, '0')}-${d.getDate().toString().padStart(2, '0')}`
}

/**
 * Calculates the percentage difference between two values.
 * Returns 0 if either value is null, undefined, or 0 (no meaningful comparison).
 * @param a - Current value
 * @param b - Previous/comparison value
 * @returns Percentage difference (positive = increase, negative = decrease), or 0 if either value is falsy
 */
export function percentDifference(a?: number | null, b?: number | null): number {
  if (!b || !a)
    return 0
  return ((a - b) / ((a + b) / 2)) * 100
}

/**
 * Resolves a period string or object into start/end dates for current and previous periods.
 * @param periodRange - Period string (e.g., '30d', '3mo', 'all') or Period object with start/end dates
 * @returns Resolved period ranges with timestamps and formatted dates for both current and previous periods
 */
export function userPeriodRange(periodRange: string | Period = '30d'): ResolvedPeriodRange {
  let startPeriod
  let endPeriod
  let startPrevPeriod
  let endPrevPeriod
  if (typeof periodRange === 'string') {
    endPeriod = dayjs()
    if (periodRange === 'all') {
      // 100 years ago
      startPeriod = dayjs().subtract(100, 'year')
      startPrevPeriod = dayjs().subtract(200, 'year')
      endPrevPeriod = dayjs().subtract(100, 'year').subtract(1, 'day')
    }
    else if (periodRange === 'max') {
      // GSC provides ~16 months of historical data
      const maxDays = 480 // 16 months
      startPeriod = endPeriod.clone().subtract(maxDays, 'day')
      startPrevPeriod = endPeriod.clone().subtract(maxDays * 2, 'day')
      endPrevPeriod = endPeriod.clone().subtract(maxDays + 1, 'day')
    }
    else {
      const periodDays = periodRange.includes('d')
        ? Number.parseInt(periodRange.replace('d', ''))
        : (Number.parseInt(periodRange.replace('mo', '')) * 30)
      startPeriod = endPeriod.clone().subtract(periodDays, 'day')
      startPrevPeriod = endPeriod.clone().subtract(periodDays * 2, 'day')
      endPrevPeriod = endPeriod.clone().subtract(periodDays + 1, 'day')
    }
  }
  else {
    startPeriod = dayjs(periodRange.start)
    endPeriod = dayjs(periodRange.end)
    const dayDiff = endPeriod.diff(startPeriod, 'day')
    // sub the days of the current period to generate prev period
    startPrevPeriod = dayjs(periodRange.start).subtract(dayDiff, 'day')
    endPrevPeriod = dayjs(periodRange.end).subtract(dayDiff, 'day')
  }
  return {
    period: {
      startTimestamp: startPeriod.valueOf(),
      start: startPeriod.toDate(),
      startDateTime: startPeriod.format('YYYY-MM-DD HH:mm:ss'),
      startDate: startPeriod.format('YYYY-MM-DD'),
      end: endPeriod.toDate(),
      endDate: endPeriod.format('YYYY-MM-DD'),
      endTimestamp: endPeriod.valueOf(),
      endDateTime: endPeriod.format('YYYY-MM-DD HH:mm:ss'),
    },
    prevPeriod: {
      start: startPrevPeriod.toDate(),
      startDate: startPrevPeriod.format('YYYY-MM-DD'),
      end: endPrevPeriod.toDate(),
      endDate: endPrevPeriod.format('YYYY-MM-DD'),
    },
  }
}

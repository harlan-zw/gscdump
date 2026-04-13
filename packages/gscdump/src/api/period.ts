import { dayjsPst } from '../query/utils/dayjs'

export interface DateRange {
  startDate: string
  endDate: string
}

export interface PeriodRange {
  current: DateRange
  previous: DateRange
}

/**
 * Parse a period string or custom date range into start/end dates with comparison period.
 *
 * @param period - Period string ("7d", "28d", "3mo", "6mo", "12mo") or custom range { start, end }
 * @returns Current and previous period date ranges
 *
 * @example
 * // Preset periods
 * userPeriodRange("28d") // Last 28 days with previous 28 days
 * userPeriodRange("3mo") // Last 3 months with previous 3 months
 *
 * @example
 * // Custom range
 * userPeriodRange({ start: "2024-01-01", end: "2024-01-31" })
 */
export function userPeriodRange(period: string | { start: string, end: string }): PeriodRange {
  const today = dayjsPst()
  // GSC data has 3 day delay
  const dataEnd = today.subtract(3, 'day')

  if (typeof period === 'object') {
    // Custom date range
    const start = dayjsPst().set('year', Number.parseInt(period.start.slice(0, 4))).set('month', Number.parseInt(period.start.slice(5, 7)) - 1).set('date', Number.parseInt(period.start.slice(8, 10)))
    const end = dayjsPst().set('year', Number.parseInt(period.end.slice(0, 4))).set('month', Number.parseInt(period.end.slice(5, 7)) - 1).set('date', Number.parseInt(period.end.slice(8, 10)))

    const daysDiff = end.diff(start, 'day') + 1
    const prevEnd = start.subtract(1, 'day')
    const prevStart = prevEnd.subtract(daysDiff - 1, 'day')

    return {
      current: {
        startDate: period.start,
        endDate: period.end,
      },
      previous: {
        startDate: prevStart.format('YYYY-MM-DD'),
        endDate: prevEnd.format('YYYY-MM-DD'),
      },
    }
  }

  // Preset periods
  let days: number

  switch (period) {
    case '7d':
      days = 7
      break
    case '28d':
      days = 28
      break
    case '3mo':
      days = 90
      break
    case '6mo':
      days = 180
      break
    case '12mo':
      days = 365
      break
    default:
      // Try to parse as "Nd" format
      if (period.endsWith('d')) {
        days = Number.parseInt(period.slice(0, -1)) || 28
      }
      else if (period.endsWith('mo')) {
        const months = Number.parseInt(period.slice(0, -2)) || 1
        days = months * 30
      }
      else {
        days = 28
      }
  }

  const currentEnd = dataEnd
  const currentStart = currentEnd.subtract(days - 1, 'day')
  const previousEnd = currentStart.subtract(1, 'day')
  const previousStart = previousEnd.subtract(days - 1, 'day')

  return {
    current: {
      startDate: currentStart.format('YYYY-MM-DD'),
      endDate: currentEnd.format('YYYY-MM-DD'),
    },
    previous: {
      startDate: previousStart.format('YYYY-MM-DD'),
      endDate: previousEnd.format('YYYY-MM-DD'),
    },
  }
}

/**
 * Get just the current date range without comparison period.
 */
export function periodToDateRange(period: string | { start: string, end: string }): DateRange {
  return userPeriodRange(period).current
}

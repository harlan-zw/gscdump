// The Indexing window: the UTC days a portfolio indexing view shows.
//
// Ported from nuxtseo.com `layers/saas/shared/period-algebra.ts` (#2062).

import type { Period } from '../period'
import type { IndexingTrendReading } from './readings'
import { periodToDateRange } from '../period'

/** The hosted v1 Site indexing read accepts at most 90 days. */
export const INDEXING_MAX_READ_DAYS = 90

/** The longest change a past window's reading shows, in days: the 28 day change. */
const INDEXING_CHANGE_DAYS = 28

const DAY_MS = 86_400_000

/** The UTC days a portfolio indexing view shows, both ends inclusive. */
export interface IndexingWindow {
  /** `YYYY-MM-DD`. */
  start: string
  /** `YYYY-MM-DD`. */
  end: string
  /**
   * True when the window ends at the latest reporting day. Its Sites show their
   * summary. A past window shows each Site's trend reading at its end.
   */
  current: boolean
  /** The day count the indexing read sends, back from today. */
  readDays: number
  /** The first day the read reaches. After `start` when the read cap cuts the window. */
  readFrom: string
}

/** The window days, `YYYY-MM-DD`, both ends inclusive. */
export type IndexingWindowDays = Pick<IndexingWindow, 'start' | 'end'>

/** The window days, and whether the window ends at the latest reporting day. */
export type IndexingReadingWindow = Pick<IndexingWindow, 'start' | 'end' | 'current'>

function isoDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10)
}

/**
 * The Indexing window for a Period.
 *
 * Indexing readings have no reporting latency, so a Period that reaches the
 * latest reporting day keeps its length and ends today. A past range keeps its
 * own days. The indexing read takes a day count back from today only, at most
 * 90. A current window asks for its own length. A past window reads back to its
 * start, and to 28 days before its end, so the reading at the end has its
 * changes. The cap can stop either short, because a longer request fails the
 * whole read.
 */
export function indexingWindow(period: Period | string, stableData: boolean, now: Date): IndexingWindow {
  const range = periodToDateRange(period, { stableData, now })
  const latest = periodToDateRange('7d', { stableData, now }).end
  const todayMs = Date.parse(now.toISOString().slice(0, 10))
  const isCurrent = range.end >= latest
  const startMs = isCurrent ? todayMs - (range.days - 1) * DAY_MS : Date.parse(range.start)
  const endMs = isCurrent ? todayMs : Date.parse(range.end)
  const firstMs = Math.min(startMs, endMs - INDEXING_CHANGE_DAYS * DAY_MS)
  const readDays = Math.min(INDEXING_MAX_READ_DAYS, isCurrent ? range.days : Math.round((todayMs - firstMs) / DAY_MS) + 1)
  return {
    start: isoDay(startMs),
    end: isoDay(endMs),
    current: isCurrent,
    readDays,
    readFrom: isoDay(todayMs - (readDays - 1) * DAY_MS),
  }
}

/** The days in the window that any series reports, oldest first. */
export function readingDatesInWindow(series: readonly (readonly Pick<IndexingTrendReading, 'date'>[])[], window: IndexingWindowDays): string[] {
  return [...new Set(series.flatMap(points => points.filter(point => point.date >= window.start && point.date <= window.end).map(point => point.date)))].sort()
}

const noteDateFormat = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' })

/** Says where the read stops when the read cap cuts the window start. Null when it reaches it. */
export function indexingWindowNote(window: Pick<IndexingWindow, 'start' | 'end' | 'readFrom'>, series: readonly (readonly Pick<IndexingTrendReading, 'date'>[])[]): string | null {
  if (window.readFrom <= window.start)
    return null
  // The read's own clock can differ from ours by a day or two, so the note names
  // the first reading that arrived, never a computed day the chart contradicts.
  const first = readingDatesInWindow(series, window)[0] ?? window.readFrom
  return `Shows ${noteDateFormat.format(new Date(`${first}T00:00:00Z`))} onward. Indexing data goes back ${INDEXING_MAX_READ_DAYS} days.`
}

// GSC date helpers. Captures the timezone + retention rules of the Search
// Analytics API in one place: quotas reset at midnight PST, the freshest
// row is yesterday PST (still updating), the most recent finalized row is
// 3 days ago PST, and historical retention is ~16 months.

/** Milliseconds in a UTC day. Use for date arithmetic without DST surprises. */
export const MS_PER_DAY = 86_400_000

/** Format a Date as YYYY-MM-DD (UTC). */
export function toIsoDate(d: Date): string {
  return d.toISOString().slice(0, 10)
}

/** Most recent date GSC has fully finalized data for (no further updates). */
export const GSC_FINALIZED_LAG_DAYS = 3

/** Most recent date GSC will return data for, may still be updating. */
export const GSC_FRESHEST_LAG_DAYS = 1

/** Approximate historical retention window for Search Analytics. */
export const GSC_RETENTION_MONTHS = 16

/** Today's date (YYYY-MM-DD) in PST. */
export function getPstDate(): string {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' })
}

function getPstDateDaysAgo(daysAgo: number): string {
  const now = new Date()
  const pstNow = new Date(now.toLocaleString('en-US', { timeZone: 'America/Los_Angeles' }))
  pstNow.setDate(pstNow.getDate() - daysAgo)
  return toIsoDate(pstNow)
}

/** YYYY-MM-DD for `now() - n` days, UTC. */
export function daysAgo(n: number): string {
  return toIsoDate(new Date(Date.now() - n * MS_PER_DAY))
}

/** Most recent finalized date (3 days ago PST). */
export function getLatestGscDate(): string {
  return getPstDateDaysAgo(GSC_FINALIZED_LAG_DAYS)
}

/** Freshest date GSC will return (yesterday PST, may still update). */
export function getFreshestGscDate(): string {
  return getPstDateDaysAgo(GSC_FRESHEST_LAG_DAYS)
}

/**
 * Dates that are still pending (1-3 days ago PST). These need to be re-synced
 * each day until they finalize.
 */
export function getPendingDates(): string[] {
  const dates: string[] = []
  for (let daysAgo = GSC_FRESHEST_LAG_DAYS; daysAgo <= GSC_FINALIZED_LAG_DAYS; daysAgo++) {
    dates.push(getPstDateDaysAgo(daysAgo))
  }
  return dates
}

/** All dates between two YYYY-MM-DD strings (inclusive, oldest first). */
export function getDateRange(startDate: string, endDate: string): string[] {
  const dates: string[] = []
  const endMs = Date.parse(`${endDate}T00:00:00Z`)
  for (let cursor = Date.parse(`${startDate}T00:00:00Z`); cursor <= endMs; cursor += MS_PER_DAY) {
    dates.push(toIsoDate(new Date(cursor)))
  }
  return dates
}

/** Default span used when chunking long backfills into batches. */
export const DAYS_PER_RANGE = 30

/**
 * Like {@link getDateRange} but skips dates outside GSC's queryable window
 * (older than retention or newer than the freshest date).
 */
export function generateGscDateRange(startDate: string, endDate: string): string[] {
  const dates: string[] = []
  let current = startDate
  while (current <= endDate && isValidGscDate(current)) {
    dates.push(current)
    current = getNextDate(current)
  }
  return dates
}

/**
 * Group a sorted list of dates into contiguous runs, splitting on either a
 * gap or after `daysPerRange` dates accumulate. Useful for bucketing
 * backfill work into bounded jobs.
 */
export function groupIntoRanges(
  dates: string[],
  daysPerRange = DAYS_PER_RANGE,
): Array<{ startDate: string, endDate: string }> {
  if (dates.length === 0)
    return []

  const sorted = [...dates].sort()
  const ranges: Array<{ startDate: string, endDate: string }> = []

  let rangeStart = sorted[0]!
  let rangePrev = sorted[0]!

  for (let i = 1; i < sorted.length; i++) {
    const current = sorted[i]!
    const expected = getNextDate(rangePrev)
    const daysInRange = countDays(rangeStart, rangePrev)

    if (current !== expected || daysInRange >= daysPerRange) {
      ranges.push({ startDate: rangeStart, endDate: rangePrev })
      rangeStart = current
    }
    rangePrev = current
  }

  ranges.push({ startDate: rangeStart, endDate: rangePrev })
  return ranges
}

/** Inclusive day count between two YYYY-MM-DD strings. */
export function countDays(startDate: string, endDate: string): number {
  return Math.round((Date.parse(`${endDate}T00:00:00Z`) - Date.parse(`${startDate}T00:00:00Z`)) / MS_PER_DAY) + 1
}

/** Oldest date GSC retains (~16 months ago). */
export function getOldestGscDate(): string {
  const date = new Date()
  date.setMonth(date.getMonth() - GSC_RETENTION_MONTHS)
  return toIsoDate(date)
}

/** Add `n` UTC days to a YYYY-MM-DD string (n may be negative). */
export function addDays(dateStr: string, n: number): string {
  return toIsoDate(new Date(Date.parse(`${dateStr}T00:00:00Z`) + n * MS_PER_DAY))
}

export function getPreviousDate(dateStr: string): string {
  return addDays(dateStr, -1)
}

export function getNextDate(dateStr: string): string {
  return addDays(dateStr, 1)
}

/** True if `dateStr` falls within GSC's queryable window. */
export function isValidGscDate(dateStr: string): boolean {
  return dateStr >= getOldestGscDate() && dateStr <= getFreshestGscDate()
}

export interface BackfillProgress {
  progress: number
  daysAvailable: number
  daysSynced: number
  oldestGscDate: string
  isComplete: boolean
}

/**
 * Backfill progress (0-1) given the oldest + newest dates synced.
 * Returns null when no sync data exists.
 */
export function getBackfillProgress(
  oldestDateSynced: string | null,
  newestDateSynced: string | null,
): BackfillProgress | null {
  if (!oldestDateSynced || !newestDateSynced)
    return null

  const oldestGsc = getOldestGscDate()
  const newestGsc = getLatestGscDate()

  const totalDays = Math.ceil((new Date(newestGsc).getTime() - new Date(oldestGsc).getTime()) / MS_PER_DAY)
  const syncedDays = Math.ceil((new Date(newestDateSynced).getTime() - new Date(oldestDateSynced).getTime()) / MS_PER_DAY)

  return {
    progress: Math.round(Math.min(1, syncedDays / totalDays) * 100) / 100,
    daysAvailable: totalDays,
    daysSynced: syncedDays,
    oldestGscDate: oldestGsc,
    isComplete: oldestDateSynced <= oldestGsc,
  }
}

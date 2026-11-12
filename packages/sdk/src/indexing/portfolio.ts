// Portfolio indexing maths: the stacks, Portfolio issue counts, and Site
// readings behind a portfolio indexing view.
//
// Ported from nuxtseo.com `layers/pro/gsc/app/utils/indexing-portfolio.ts` and
// `indexing-group-trend.ts` (#2054, #2062).
//
// Indexing counts are a daily level, not a flow. Summing the days in a bucket
// suits clicks and would double a not-indexed count, so these stacks keep the
// last day of each bucket instead. Sites report on different days, so a Site
// carries its last known value forward: a Site that skipped a day must not read
// as if its URLs were indexed that day. It starts from its held reading, the
// last reading before the window. Without one it holds its first value, or a
// Site joining the window reads as a rise. A day with no inspected URLs is no
// reading at all, and a reading after the window never reaches it.

import type { IndexingSummaryReading, IndexingTrendReading } from './readings'
import type { SiteIndexingIssue } from './site-issues'
import type { IndexingReadingWindow, IndexingWindowDays } from './window'
import { clampIndexedPercent, crawlErrorCount, notIndexedCount } from './readings'
import { getSiteIndexingIssues } from './site-issues'
import { readingDatesInWindow } from './window'

export interface IndexingPortfolioSite {
  id: string
  label: string
  trend: readonly IndexingTrendReading[]
}

export interface IndexingStackBucket {
  /** First day folded into this bucket. */
  start: string
  /** Last day folded into this bucket. */
  end: string
}

export interface IndexingStackSeries {
  key: string
  label: string
  /** One value per bucket, aligned to `buckets`. */
  values: number[]
  isOther: boolean
}

export interface IndexingStack {
  buckets: IndexingStackBucket[]
  series: IndexingStackSeries[]
}

export interface IndexingStackOptions {
  /** Series kept by name before the rest fold into All Others. Default 5. */
  topN?: number
  /** Most buckets on the axis. Default 30. */
  maxBuckets?: number
}

export interface PortfolioIssueSiteCount {
  siteId: string
  label: string
  count: number
}

/** One issue across every Site in the Portfolio, at the window end. */
export interface PortfolioIssueRow {
  id: string
  label: string
  count: number
  siteCount: number
  filter: SiteIndexingIssue['filter']
  /** Largest count first. */
  sites: PortfolioIssueSiteCount[]
}

/** A Site's reading at the window end, and its indexed rate changes before it. */
export interface IndexingWindowReading {
  /** The trend reading its issues come from. Null when the Site has a summary and no trend. */
  point: IndexingTrendReading | null
  indexed: number
  totalUrls: number
  indexedPercent: number
  /** Points, against the last reading on or before 7 days earlier. Null without one. */
  change7d: number | null
  /** Points, against the last reading on or before 28 days earlier. Null without one. */
  change28d: number | null
}

/** One day of the Portfolio trend: every Site's held level summed. */
export interface PortfolioIndexingTrendPoint {
  date: string
  indexedPercent: number
  indexedCount: number
  /** Crawl errors: not found, soft 404, and server errors. */
  errors: number
}

const DEFAULT_TOP_N = 5
const DEFAULT_MAX_BUCKETS = 30
const OTHER_KEY = '__other'
const OTHER_LABEL = 'All Others'
const DAY_MS = 86_400_000

function byDate<T extends { date: string }>(a: T, b: T): number {
  return a.date.localeCompare(b.date)
}

function daysBefore(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) - days * DAY_MS).toISOString().slice(0, 10)
}

/**
 * The readings in the window, led by the held reading when one exists. A Site
 * with no reading in the window keeps its held reading, so it holds its level
 * across the window instead of leaving the Portfolio total.
 */
export function windowReadings<T extends Pick<IndexingTrendReading, 'date' | 'totalUrls'>>(trend: readonly T[], window: IndexingWindowDays): T[] {
  const readings = trend.filter(point => point.totalUrls > 0 && point.date <= window.end).toSorted(byDate)
  const start = readings.findIndex(point => point.date >= window.start)
  if (start < 0)
    return readings.slice(-1)
  return readings.slice(Math.max(0, start - 1))
}

/**
 * The trend reading at the window end: the last one on or before its end, or
 * the held reading. Changes compare it with earlier readings.
 */
function readingAtWindowEnd(trend: readonly IndexingTrendReading[], window: IndexingWindowDays): IndexingWindowReading | null {
  const point = windowReadings(trend, window).at(-1)
  if (!point)
    return null
  const readings = trend.filter(reading => reading.totalUrls > 0)
  function changeOver(days: number): number | null {
    const target = daysBefore(point!.date, days)
    const base = readings.filter(reading => reading.date <= target).toSorted(byDate).at(-1)
    return base ? Math.round((point!.indexedPercent - base.indexedPercent) * 10) / 10 : null
  }
  return {
    point,
    indexed: point.indexedCount,
    totalUrls: point.totalUrls,
    indexedPercent: point.indexedPercent,
    change7d: changeOver(7),
    change28d: changeOver(28),
  }
}

/** The reading a Site's issues come from: the latest on a current window, the window end on a past one. */
function windowEndPoint(trend: readonly IndexingTrendReading[], window: IndexingReadingWindow): IndexingTrendReading | null {
  if (!window.current)
    return readingAtWindowEnd(trend, window)?.point ?? null
  return trend.toSorted(byDate).at(-1) ?? null
}

/**
 * The one reading every Site value comes from: tiles, rows, cards, popovers,
 * export, and sort. A current window shows the Site summary, which carries the
 * latest level and its 7 and 28 day changes. A past window shows the trend
 * reading at its end, so it never shows today's level.
 */
export function siteIndexingReading(summary: IndexingSummaryReading | null | undefined, trend: readonly IndexingTrendReading[], window: IndexingReadingWindow): IndexingWindowReading | null {
  if (!window.current)
    return readingAtWindowEnd(trend, window)
  if (!summary || summary.totalUrls <= 0)
    return null
  return {
    point: windowEndPoint(trend, window),
    indexed: summary.indexed,
    totalUrls: summary.totalUrls,
    indexedPercent: summary.indexedPercent,
    change7d: summary.change7d ?? null,
    change28d: summary.change28d ?? null,
  }
}

/** The last day of each bucket, with the buckets evenly split across the axis. */
function bucketAxis(dates: readonly string[], maxBuckets: number): { bucket: IndexingStackBucket, last: number }[] {
  const size = Math.max(1, Math.ceil(dates.length / maxBuckets))
  const out: { bucket: IndexingStackBucket, last: number }[] = []
  for (let start = 0; start < dates.length; start += size) {
    const last = Math.min(start + size, dates.length) - 1
    out.push({ bucket: { start: dates[start]!, end: dates[last]! }, last })
  }
  return out
}

interface LevelSeries {
  key: string
  label: string
  /** One level per day of the axis. */
  levels: number[]
}

/**
 * Keep the largest series by their latest level, and fold the rest into one
 * band. One series past `topN` keeps its name: a band of one hides a label.
 */
function stackLevels(dates: readonly string[], levels: readonly LevelSeries[], options: IndexingStackOptions): IndexingStack {
  const topN = options.topN ?? DEFAULT_TOP_N
  const present = levels.filter(series => series.levels.some(level => level > 0))
  if (!dates.length || !present.length)
    return { buckets: [], series: [] }

  const ranked = [...present].sort((a, b) => (b.levels.at(-1) ?? 0) - (a.levels.at(-1) ?? 0))
  const axis = bucketAxis(dates, options.maxBuckets ?? DEFAULT_MAX_BUCKETS)
  const pick = (series: LevelSeries): number[] => axis.map(({ last }) => series.levels[last] ?? 0)

  const kept = ranked.length === topN + 1 ? ranked.length : topN
  const series: IndexingStackSeries[] = ranked.slice(0, kept).map(entry => ({
    key: entry.key,
    label: entry.label,
    values: pick(entry),
    isOther: false,
  }))
  const rest = ranked.slice(kept)
  if (rest.length) {
    series.push({
      key: OTHER_KEY,
      label: OTHER_LABEL,
      values: axis.map(({ last }) => rest.reduce((sum, entry) => sum + (entry.levels[last] ?? 0), 0)),
      isOther: true,
    })
  }
  return { buckets: axis.map(({ bucket }) => bucket), series }
}

/** A level per axis day, carrying the last reported value across a Site's gaps. */
function carryForward(points: readonly IndexingTrendReading[], dates: readonly string[], read: (point: IndexingTrendReading) => number): number[] {
  let next = 0
  let level = points[0] ? read(points[0]) : 0
  return dates.map((date) => {
    while (next < points.length && points[next]!.date <= date) {
      level = read(points[next]!)
      next++
    }
    return level
  })
}

/** Not-indexed URLs per day, stacked by Site: the largest Sites plus All Others. */
export function notIndexedStack(sites: readonly IndexingPortfolioSite[], window: IndexingWindowDays, options: IndexingStackOptions = {}): IndexingStack {
  const inWindow = sites.map(site => ({ site, points: windowReadings(site.trend, window) }))
  const dates = readingDatesInWindow(inWindow.map(entry => entry.points), window)
  return stackLevels(
    dates,
    inWindow.map(({ site, points }) => ({ key: site.id, label: site.label, levels: carryForward(points, dates, notIndexedCount) })),
    options,
  )
}

/** Reported URLs per day, stacked by issue across every Site. */
export function issueStack(sites: readonly IndexingPortfolioSite[], window: IndexingWindowDays, options: IndexingStackOptions = {}): IndexingStack {
  const inWindow = sites.map(site => windowReadings(site.trend, window))
  const dates = readingDatesInWindow(inWindow, window)
  const byIssue = new Map<string, LevelSeries>()
  for (const points of inWindow) {
    const issuesByDate = new Map(points.map(point => [point.date, getSiteIndexingIssues(point)]))
    const issues = [...issuesByDate.values()].flat()
    for (const id of new Set(issues.map(issue => issue.id))) {
      const levels = carryForward(points, dates, point => issuesByDate.get(point.date)?.find(issue => issue.id === id)?.count ?? 0)
      const label = issues.find(issue => issue.id === id)!.label
      const entry = byIssue.get(id)
      if (entry)
        entry.levels = entry.levels.map((level, index) => level + (levels[index] ?? 0))
      else
        byIssue.set(id, { key: id, label, levels })
    }
  }
  return stackLevels(dates, [...byIssue.values()], options)
}

/** The reported issues across every Site at the window end, largest count first. */
export function portfolioIssueCounts(sites: readonly IndexingPortfolioSite[], window: IndexingReadingWindow): PortfolioIssueRow[] {
  const rows = new Map<string, PortfolioIssueRow>()
  for (const site of sites) {
    for (const issue of getSiteIndexingIssues(windowEndPoint(site.trend, window))) {
      const row = rows.get(issue.id) ?? { id: issue.id, label: issue.label, count: 0, siteCount: 0, filter: issue.filter, sites: [] }
      row.count += issue.count
      row.siteCount += 1
      row.sites.push({ siteId: site.id, label: site.label, count: issue.count })
      rows.set(issue.id, row)
    }
  }
  return Array.from(rows.values(), row => ({ ...row, sites: row.sites.toSorted((a, b) => b.count - a.count) }))
    .sort((a, b) => b.count - a.count)
}

/**
 * The Portfolio trend, one point per reported day in the window. Each Site
 * carries its last reading forward, or skipping a day would read as its URLs
 * leaving the total. It starts from its held reading, or else holds its first
 * reading, so joining the window does not read as a rate change. The rate is
 * weighted by inspected URLs.
 */
export function portfolioIndexingTrend(series: readonly (readonly IndexingTrendReading[])[], window: IndexingWindowDays): PortfolioIndexingTrendPoint[] {
  const inWindow = series.map(trend => windowReadings(trend, window))
  const dates = readingDatesInWindow(inWindow, window)
  const days = new Map(dates.map(date => [date, { totalUrls: 0, indexedCount: 0, errors: 0 }]))
  for (const trend of inWindow) {
    let next = 0
    let latest = trend[0]
    for (const date of dates) {
      while (next < trend.length && trend[next]!.date <= date)
        latest = trend[next++]
      if (!latest)
        continue
      const day = days.get(date)!
      day.totalUrls += latest.totalUrls
      day.indexedCount += latest.indexedCount ?? 0
      day.errors += crawlErrorCount(latest)
    }
  }
  return Array.from(days, ([date, day]) => ({
    date,
    indexedPercent: day.totalUrls > 0 ? clampIndexedPercent(day.indexedCount / day.totalUrls * 100) : 0,
    indexedCount: day.indexedCount,
    errors: day.errors,
  })).sort(byDate)
}

/** The Portfolio rate change between the latest day and the day `days` before it, in points. */
export function portfolioRateChangeOver(trend: readonly PortfolioIndexingTrendPoint[], days: number): number | null {
  const last = trend.at(-1)
  if (!last)
    return null
  const target = daysBefore(last.date, days)
  const base = trend.findLast(point => point.date <= target)
  return base ? last.indexedPercent - base.indexedPercent : null
}

/** The rate change from the first to the last point, in points. Null below two points. */
export function indexedRateChange(trend: ReadonlyArray<{ indexedPercent: number }>): number | null {
  if (trend.length < 2)
    return null
  return trend.at(-1)!.indexedPercent - trend[0]!.indexedPercent
}

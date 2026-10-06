// Pure page statistics: date windows, row parsing, and totals. No I/O.

import type { DailyPoint, DateWindow, MetricTotals, QueryRow, SiteSummary } from './shared/protocol'

const DAY_MS = 86_400_000
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/

export function addDays(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10)
}

/**
 * The page as Search Console stores it for a Site: its path, with any query
 * string, without the fragment. Accepts a path, a full URL, or a bare path
 * without the leading slash. Returns `null` for an empty input.
 *
 * Search Console stores a host-scoped Site's pages by path, and the hosted read
 * reduces a full URL to its path, so the dev server's origin never matters.
 */
export function pagePathOf(input: string): string | null {
  const text = input.trim()
  if (!text)
    return null
  if (/^[a-z][a-z\d+.-]*:\/\//i.test(text)) {
    const url = URL.parse(text)
    return url ? `${url.pathname}${url.search}` : null
  }
  const path = text.split('#')[0]!
  return path.startsWith('/') ? path : `/${path}`
}

export interface PeriodWindows {
  current: DateWindow
  /** `null` when the Hosted record does not hold the whole preceding window. */
  previous: DateWindow | null
}

/**
 * The current window ends on the last day the Hosted record holds, so a read
 * never asks for days the record cannot serve. Returns `null` when the record
 * holds no days yet.
 */
export function periodWindows(days: number, site: Pick<SiteSummary, 'oldestDate' | 'newestDate'>): PeriodWindows | null {
  const { oldestDate, newestDate } = site
  if (!newestDate || !ISO_DATE.test(newestDate))
    return null
  const oldest = oldestDate && ISO_DATE.test(oldestDate) ? oldestDate : null
  const start = addDays(newestDate, -(days - 1))
  const current = { start: oldest && start < oldest ? oldest : start, end: newestDate }
  const previousEnd = addDays(start, -1)
  const previousStart = addDays(previousEnd, -(days - 1))
  const previous = oldest && previousStart < oldest ? null : { start: previousStart, end: previousEnd }
  return { current, previous }
}

function num(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(n) ? n : 0
}

interface WeightedTotals {
  clicks: number
  impressions: number
  positionWeight: number
}

function finish(sum: WeightedTotals): MetricTotals {
  return {
    clicks: sum.clicks,
    impressions: sum.impressions,
    ctr: sum.impressions > 0 ? sum.clicks / sum.impressions : 0,
    position: sum.impressions > 0 ? sum.positionWeight / sum.impressions : null,
  }
}

function accumulate(sum: WeightedTotals, row: Record<string, unknown>): void {
  const impressions = num(row.impressions)
  sum.clicks += num(row.clicks)
  sum.impressions += impressions
  sum.positionWeight += num(row.position) * impressions
}

function inWindow(date: string, window: DateWindow): boolean {
  return date >= window.start && date <= window.end
}

export interface PageSummary {
  totals: MetricTotals
  previousTotals: MetricTotals | null
  daily: DailyPoint[]
  previousDaily: DailyPoint[] | null
}

function fillDays(window: DateWindow, byDate: Map<string, DailyPoint>): DailyPoint[] {
  const days: DailyPoint[] = []
  for (let date = window.start; date <= window.end; date = addDays(date, 1))
    days.push(byDate.get(date) ?? { date, clicks: 0, impressions: 0, ctr: 0, position: null })
  return days
}

/**
 * Split daily rows that span both windows into each window's totals, and fill
 * each window with one point per day. Position is impression-weighted,
 * as Search Console computes it for a range.
 */
export function summariseDaily(rows: readonly Record<string, unknown>[], windows: PeriodWindows): PageSummary {
  const current: WeightedTotals = { clicks: 0, impressions: 0, positionWeight: 0 }
  const previous: WeightedTotals = { clicks: 0, impressions: 0, positionWeight: 0 }
  const byDate = new Map<string, DailyPoint>()
  for (const row of rows) {
    const date = String(row.date ?? '')
    const target = inWindow(date, windows.current)
      ? current
      : windows.previous && inWindow(date, windows.previous) ? previous : null
    if (!target)
      continue
    accumulate(target, row)
    const day: WeightedTotals = { clicks: 0, impressions: 0, positionWeight: 0 }
    accumulate(day, row)
    byDate.set(date, { date, ...finish(day) })
  }
  return {
    totals: finish(current),
    previousTotals: windows.previous ? finish(previous) : null,
    daily: fillDays(windows.current, byDate),
    previousDaily: windows.previous ? fillDays(windows.previous, byDate) : null,
  }
}

/** Query rows, most clicks first. Equal clicks rank by impressions, so zero-click rows keep a useful order. */
export function parseQueryRows(rows: readonly Record<string, unknown>[]): QueryRow[] {
  return rows
    .filter(row => typeof row.query === 'string' && row.query.length > 0)
    .map(row => ({
      query: String(row.query),
      clicks: num(row.clicks),
      impressions: num(row.impressions),
      ctr: num(row.ctr),
      position: row.position == null ? null : num(row.position),
    }))
    .sort((a, b) => b.clicks - a.clicks || b.impressions - a.impressions)
}

/** The page's view in the gscdump.com dashboard. */
export function dashboardPageUrl(origin: string, site: Pick<SiteSummary, 'siteId' | 'siteUrl'>, path: string): string {
  return `${origin}/app/sites/${encodeURIComponent(site.siteUrl)}/search-console/pages/${encodeURIComponent(path)}?siteId=${encodeURIComponent(site.siteId)}`
}

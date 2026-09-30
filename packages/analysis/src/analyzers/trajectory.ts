/**
 * `trajectory`: the shape of a Site's whole preserved daily record.
 *
 * Other windows in gscdump look at 28 or 90 days, so a launch peak ages out
 * and the story is lost. This analyzer reads every day it is given, finds the
 * peak 7-day window, compares it with the latest 7-day window, and names the
 * shape of the curve with a tagged classification.
 *
 * `analyzeTrajectory` is pure. The `trajectory` Analyzer feeds it from the
 * `dates` table. The caller decides how far back to read; pass the full record.
 * The last date in the input is the end of the latest window, so the caller
 * must not pass days Search Console has not finalized.
 */

import type { AnalysisParams } from '@gscdump/engine/analysis-types'
import type { Row } from '@gscdump/engine/contracts'
import type { DateRow } from '../types'
import { fetchBudgetOf } from '@gscdump/engine/analysis-types'
import { defineAnalyzer } from '@gscdump/engine/analyzer'
import { defaultEndDate } from '@gscdump/engine/period'
import { enumeratePartitions } from '@gscdump/engine/planner'
import { MS_PER_DAY, toIsoDate } from 'gscdump/dates'
import { datesQueryState } from '../analyzer/adapt-rows'
import { rowNumber as num, rowString as str } from '../analyzer/row-values'

// ── thresholds ──────────────────────────────────────────────────────────────
// Each constant says why it has this value. Change one only with a fixture.

/** Windows are one week: it absorbs the weekday cycle of Search Console traffic. */
export const TRAJECTORY_WINDOW_DAYS = 7

/** Under four weeks there is no peak worth comparing with a latest week. */
export const MIN_RECORD_DAYS = 28

/**
 * A peak week under this many clicks is noise. At 20 clicks a week, one
 * missing click moves the ratio by 5%.
 */
export const MIN_PEAK_WEEK_CLICKS = 20

/** The same floor for impressions, when clicks are too few to carry the read. */
export const MIN_PEAK_WEEK_IMPRESSIONS = 200

/**
 * Search Console over-counted impressions from 2025-05-13 until Google fixed
 * the report on 2026-04-27. Clicks were not affected. Source: Google Search
 * Console data anomalies, https://support.google.com/webmasters/answer/6211453
 */
export const IMPRESSIONS_OVERCOUNT_FROM = '2025-05-13'
export const IMPRESSIONS_OVERCOUNT_THROUGH = '2026-04-27'

/**
 * Clicks and impressions disagree when their latest-to-peak ratios differ by
 * more than this. A quarter is far outside the wobble of a healthy site.
 */
export const METRIC_DISAGREEMENT = 0.25

/**
 * The drop is complete when a 7-day window falls to 15% of the peak window.
 * A window that still holds a few peak days stays above this, so a hard stop
 * reads as complete about one window after it happens.
 */
export const CLIFF_FRACTION = 0.15

/**
 * A cliff lasts at most 21 days from the end of the peak window to the end of
 * the drop. That is "roughly two weeks" plus up to one window of smear from
 * the 7-day rolling sum.
 */
export const CLIFF_MAX_DAYS = 21

/**
 * "Stays low": after the drop, no 7-day window climbs back above 25% of the
 * peak. A rebound above that is a recovery, not a cliff.
 */
export const STAYS_LOW_FRACTION = 0.25

/**
 * A launch climbs to its peak within 8 weeks of the first traffic. Later peaks
 * belong to an established site.
 */
export const LAUNCH_CLIMB_MAX_DAYS = 56

/**
 * A launch starts near zero: the first week holds at most 25% of the peak week.
 * A record that starts high began at the backfill edge, not at launch.
 */
export const LAUNCH_START_FRACTION = 0.25

/** Latest at 90% of peak or better is "at its peak": growing or steady. */
export const NEAR_PEAK_RATIO = 0.9

/** Latest at 70% of peak or worse, without a cliff, is a gradual decline. */
export const DECLINE_RATIO = 0.7

/** Growth compares the latest week with the week 8 weeks earlier. */
export const GROWTH_LOOKBACK_DAYS = 56

/** Growing means the earlier week is at most 80% of the latest week. */
export const GROWTH_PRIOR_FRACTION = 0.8

// ── types ───────────────────────────────────────────────────────────────────

export interface TrajectoryDay {
  /** ISO calendar date, `YYYY-MM-DD`. */
  date: string
  clicks: number
  impressions: number
}

export interface TrajectoryWindow {
  startDate: string
  endDate: string
  clicks: number
  impressions: number
}

/** Which metric the peak, the ratio, and the classification read. */
export type TrajectoryBasis
  = | { _tag: 'impressions', note: string }
    | {
      _tag: 'clicks'
      reason: 'impressions-overcount-window' | 'impressions-clicks-disagree' | 'too-few-impressions'
      note: string
    }

export type TrajectoryCaveat
  = | {
    _tag: 'impressions-overcount'
    fromDate: string
    throughDate: string
    /** True when the impressions peak window sits inside the over-count period. */
    overlapsPeak: boolean
    note: string
  }
  | { _tag: 'skipped-rows', count: number, note: string }

export type TrajectoryClassification
  = | { _tag: 'insufficient-data', reason: 'too-few-days' | 'no-traffic', days: number }
    /** Fast climb from near zero, then a drop to a small fraction of peak within about 2 weeks, staying low. */
    | { _tag: 'launch-honeymoon-then-cliff', climbDays: number, dropDays: number }
    /** The same fast drop on a site that did not start from near zero. */
    | { _tag: 'sudden-drop', dropDays: number }
    /** Latest week is at or near the peak and clearly above 8 weeks earlier. */
    | { _tag: 'growing' }
    /** Latest week is near the peak or moderately below it. */
    | { _tag: 'steady' }
    /** Latest week is well below the peak with no cliff. */
    | { _tag: 'gradual-decline' }

export interface TrajectoryResult {
  /** First input date. Search Console history may begin at the backfill edge, not at launch. */
  recordStartDate: string | null
  /** First day with any clicks or impressions. */
  firstDataDate: string | null
  lastDataDate: string | null
  /** Days from the record start to the last date, gaps included. */
  days: number
  basis: TrajectoryBasis
  peak: TrajectoryWindow | null
  latest: TrajectoryWindow | null
  /** Latest 7-day total over peak 7-day total, on the basis metric. Null when the record is too thin. */
  latestToPeakRatio: number | null
  /** Whole weeks from the end of the peak window to the last date. */
  weeksSincePeak: number | null
  classification: TrajectoryClassification
  caveats: TrajectoryCaveat[]
}

// ── pure core ───────────────────────────────────────────────────────────────

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/

interface FilledSeries {
  startDate: string
  clicks: number[]
  impressions: number[]
  skipped: number
}

function parseDay(date: string): number | null {
  if (!ISO_DATE.test(date))
    return null
  const ms = Date.parse(`${date}T00:00:00Z`)
  return Number.isFinite(ms) ? ms : null
}

function dateAt(startMs: number, index: number): string {
  return toIsoDate(new Date(startMs + index * MS_PER_DAY))
}

/** Sum duplicate dates and fill gaps with zero, so a missing day reads as no traffic. */
function fillSeries(days: readonly TrajectoryDay[]): FilledSeries | null {
  const byMs = new Map<number, { clicks: number, impressions: number }>()
  let skipped = 0
  for (const day of days) {
    const ms = parseDay(day.date)
    if (ms === null) {
      skipped++
      continue
    }
    const held = byMs.get(ms) ?? { clicks: 0, impressions: 0 }
    held.clicks += Number.isFinite(day.clicks) ? day.clicks : 0
    held.impressions += Number.isFinite(day.impressions) ? day.impressions : 0
    byMs.set(ms, held)
  }
  if (!byMs.size)
    return null
  const keys = [...byMs.keys()]
  const first = Math.min(...keys)
  const last = Math.max(...keys)
  const length = Math.round((last - first) / MS_PER_DAY) + 1
  const clicks = Array.from<number>({ length }).fill(0)
  const impressions = Array.from<number>({ length }).fill(0)
  for (const [ms, value] of byMs) {
    const index = Math.round((ms - first) / MS_PER_DAY)
    clicks[index] = value.clicks
    impressions[index] = value.impressions
  }
  return { startDate: toIsoDate(new Date(first)), clicks, impressions, skipped }
}

/** `rolling[i]` is the sum of days `i - 6` to `i`. Indexes under 6 hold NaN. */
function rollingSums(series: readonly number[]): number[] {
  const out = Array.from<number>({ length: series.length }).fill(Number.NaN)
  let sum = 0
  for (let i = 0; i < series.length; i++) {
    sum += series[i]!
    if (i >= TRAJECTORY_WINDOW_DAYS)
      sum -= series[i - TRAJECTORY_WINDOW_DAYS]!
    if (i >= TRAJECTORY_WINDOW_DAYS - 1)
      out[i] = sum
  }
  return out
}

/** Index of the largest window. A plateau resolves to its last window, so a drop measures from the plateau's end. */
function peakIndex(rolling: readonly number[]): number {
  let best = -1
  for (let i = TRAJECTORY_WINDOW_DAYS - 1; i < rolling.length; i++) {
    if (best === -1 || rolling[i]! >= rolling[best]!)
      best = i
  }
  return best
}

function ratioOf(rolling: readonly number[]): number | null {
  const peak = rolling[peakIndex(rolling)]
  const latest = rolling[rolling.length - 1]
  return peak && peak > 0 && latest !== undefined ? latest / peak : null
}

function windowAt(filled: FilledSeries, startMs: number, endIndex: number, rc: readonly number[], ri: readonly number[]): TrajectoryWindow {
  return {
    startDate: dateAt(startMs, endIndex - (TRAJECTORY_WINDOW_DAYS - 1)),
    endDate: dateAt(startMs, endIndex),
    clicks: rc[endIndex]!,
    impressions: ri[endIndex]!,
  }
}

function overlapsOvercount(startDate: string, endDate: string): boolean {
  return startDate <= IMPRESSIONS_OVERCOUNT_THROUGH && endDate >= IMPRESSIONS_OVERCOUNT_FROM
}

const EMPTY_BASIS: TrajectoryBasis = { _tag: 'impressions', note: 'Impressions are the default basis. No record to read.' }

function emptyResult(
  filled: FilledSeries | null,
  classification: TrajectoryClassification,
  caveats: TrajectoryCaveat[],
): TrajectoryResult {
  const startMs = filled ? parseDay(filled.startDate)! : 0
  const days = filled?.clicks.length ?? 0
  const firstTraffic = filled ? filled.clicks.findIndex((c, i) => c > 0 || filled.impressions[i]! > 0) : -1
  return {
    recordStartDate: filled?.startDate ?? null,
    firstDataDate: firstTraffic >= 0 ? dateAt(startMs, firstTraffic) : null,
    lastDataDate: filled ? dateAt(startMs, days - 1) : null,
    days,
    basis: EMPTY_BASIS,
    peak: null,
    latest: null,
    latestToPeakRatio: null,
    weeksSincePeak: null,
    classification,
    caveats,
  }
}

function chooseBasis(
  rc: readonly number[],
  ri: readonly number[],
  startMs: number,
): { basis: TrajectoryBasis, overlapsPeak: boolean } | null {
  const peakC = rc[peakIndex(rc)]!
  const peakIdxI = peakIndex(ri)
  const peakI = ri[peakIdxI]!
  const enoughClicks = peakC >= MIN_PEAK_WEEK_CLICKS
  const enoughImpressions = peakI >= MIN_PEAK_WEEK_IMPRESSIONS
  const overlapsPeak = overlapsOvercount(
    dateAt(startMs, peakIdxI - (TRAJECTORY_WINDOW_DAYS - 1)),
    dateAt(startMs, peakIdxI),
  )

  if (!enoughClicks && !enoughImpressions)
    return null
  if (!enoughClicks)
    return { basis: { _tag: 'impressions', note: 'Too few clicks to read. Impressions carry this read.' }, overlapsPeak }
  if (!enoughImpressions)
    return { basis: { _tag: 'clicks', reason: 'too-few-impressions', note: 'Too few impressions to read. Clicks carry this read.' }, overlapsPeak }
  if (overlapsPeak) {
    return {
      basis: {
        _tag: 'clicks',
        reason: 'impressions-overcount-window',
        note: `Clicks carry this read. Search Console over-counted impressions through ${IMPRESSIONS_OVERCOUNT_THROUGH}, and the impressions peak sits in that period.`,
      },
      overlapsPeak,
    }
  }
  const ratioC = ratioOf(rc)
  const ratioI = ratioOf(ri)
  if (ratioC !== null && ratioI !== null && Math.abs(ratioC - ratioI) > METRIC_DISAGREEMENT) {
    return {
      basis: {
        _tag: 'clicks',
        reason: 'impressions-clicks-disagree',
        note: 'Clicks carry this read. Clicks and impressions disagree about how far the site fell from its peak.',
      },
      overlapsPeak,
    }
  }
  return { basis: { _tag: 'impressions', note: 'Impressions and clicks agree. Impressions carry this read.' }, overlapsPeak }
}

function classify(
  rolling: readonly number[],
  peakIdx: number,
  firstTrafficIdx: number,
): TrajectoryClassification {
  const peak = rolling[peakIdx]!
  const lastIdx = rolling.length - 1
  const latest = rolling[lastIdx]!
  const ratio = latest / peak

  // Cliff: the rolling sum falls to a small share of the peak soon after it,
  // and never climbs back.
  let dropIdx = -1
  for (let j = peakIdx + 1; j <= lastIdx; j++) {
    if (rolling[j]! <= CLIFF_FRACTION * peak) {
      dropIdx = j
      break
    }
  }
  if (dropIdx !== -1 && dropIdx - peakIdx <= CLIFF_MAX_DAYS) {
    let staysLow = true
    for (let k = dropIdx; k <= lastIdx; k++) {
      if (rolling[k]! > STAYS_LOW_FRACTION * peak) {
        staysLow = false
        break
      }
    }
    if (staysLow) {
      const dropDays = dropIdx - peakIdx
      const climbDays = peakIdx - firstTrafficIdx
      const firstWeekIdx = firstTrafficIdx + TRAJECTORY_WINDOW_DAYS - 1
      const startsNearZero = firstWeekIdx < peakIdx && rolling[firstWeekIdx]! <= LAUNCH_START_FRACTION * peak
      return climbDays <= LAUNCH_CLIMB_MAX_DAYS && startsNearZero
        ? { _tag: 'launch-honeymoon-then-cliff', climbDays, dropDays }
        : { _tag: 'sudden-drop', dropDays }
    }
  }

  if (ratio <= DECLINE_RATIO)
    return { _tag: 'gradual-decline' }
  if (ratio >= NEAR_PEAK_RATIO) {
    const priorIdx = lastIdx - GROWTH_LOOKBACK_DAYS
    if (priorIdx >= TRAJECTORY_WINDOW_DAYS - 1 && rolling[priorIdx]! <= GROWTH_PRIOR_FRACTION * latest)
      return { _tag: 'growing' }
  }
  return { _tag: 'steady' }
}

/**
 * Name the shape of a Site's full daily record.
 *
 * Pass every preserved day. Missing days count as zero. Rows with a date that
 * is not `YYYY-MM-DD` are skipped and counted in `caveats`.
 */
export function analyzeTrajectory(days: readonly TrajectoryDay[]): TrajectoryResult {
  const filled = fillSeries(days)
  const caveats: TrajectoryCaveat[] = []
  const skippedCount = filled ? filled.skipped : days.length
  if (skippedCount > 0)
    caveats.push({ _tag: 'skipped-rows', count: skippedCount, note: `${skippedCount} rows had no valid YYYY-MM-DD date and were skipped.` })
  if (!filled)
    return emptyResult(null, { _tag: 'insufficient-data', reason: 'too-few-days', days: 0 }, caveats)

  const length = filled.clicks.length
  if (length < MIN_RECORD_DAYS)
    return emptyResult(filled, { _tag: 'insufficient-data', reason: 'too-few-days', days: length }, caveats)

  const startMs = parseDay(filled.startDate)!
  const rc = rollingSums(filled.clicks)
  const ri = rollingSums(filled.impressions)

  const chosen = chooseBasis(rc, ri, startMs)
  if (!chosen)
    return emptyResult(filled, { _tag: 'insufficient-data', reason: 'no-traffic', days: length }, caveats)

  const lastDate = dateAt(startMs, length - 1)
  if (overlapsOvercount(filled.startDate, lastDate)) {
    caveats.push({
      _tag: 'impressions-overcount',
      fromDate: IMPRESSIONS_OVERCOUNT_FROM,
      throughDate: IMPRESSIONS_OVERCOUNT_THROUGH,
      overlapsPeak: chosen.overlapsPeak,
      note: `Search Console over-counted impressions from ${IMPRESSIONS_OVERCOUNT_FROM} through ${IMPRESSIONS_OVERCOUNT_THROUGH}. Clicks were not affected.`,
    })
  }

  const rolling = chosen.basis._tag === 'clicks' ? rc : ri
  const peakIdx = peakIndex(rolling)
  const firstTrafficIdx = filled.clicks.findIndex((c, i) => c > 0 || filled.impressions[i]! > 0)
  const lastIdx = length - 1

  return {
    recordStartDate: filled.startDate,
    firstDataDate: dateAt(startMs, firstTrafficIdx),
    lastDataDate: lastDate,
    days: length,
    basis: chosen.basis,
    peak: windowAt(filled, startMs, peakIdx, rc, ri),
    latest: windowAt(filled, startMs, lastIdx, rc, ri),
    latestToPeakRatio: rolling[lastIdx]! / rolling[peakIdx]!,
    weeksSincePeak: Math.floor((lastIdx - peakIdx) / 7),
    classification: classify(rolling, peakIdx, firstTrafficIdx),
    caveats,
  }
}

// ── Analyzer ────────────────────────────────────────────────────────────────

/**
 * Default read when the caller gives no start date: 16 months, the span Google
 * keeps. Hosted callers that preserve more pass `startDate` to read all of it.
 */
export const TRAJECTORY_DEFAULT_DAYS = 486

function trajectoryWindow(params: AnalysisParams): { startDate: string, endDate: string } {
  const endDate = params.endDate || defaultEndDate()
  const startDate = params.startDate
    || toIsoDate(new Date(Date.parse(endDate) - (TRAJECTORY_DEFAULT_DAYS - 1) * MS_PER_DAY))
  return { startDate, endDate }
}

export const trajectoryAnalyzer = defineAnalyzer<AnalysisParams, Row, TrajectoryResult[]>({
  id: 'trajectory',

  buildSql(params) {
    const { startDate, endDate } = trajectoryWindow(params)
    // CAST(date AS DATE) defends against union_by_name coercing `date` to
    // VARCHAR across parquets with mixed schemas. Same pattern as seasonality.
    const sql = `
    SELECT
      strftime(CAST(date AS DATE), '%Y-%m-%d') AS date,
      CAST(SUM(clicks) AS DOUBLE) AS clicks,
      CAST(SUM(impressions) AS DOUBLE) AS impressions
    FROM read_parquet({{FILES}}, union_by_name = true)
    WHERE date >= ? AND date <= ?
    GROUP BY 1
    ORDER BY 1
  `
    return {
      sql,
      params: [startDate, endDate],
      current: { table: 'dates', partitions: enumeratePartitions(startDate, endDate) },
    }
  },

  reduceSql(rows, params) {
    const arr = Array.isArray(rows) ? rows : []
    const { startDate, endDate } = trajectoryWindow(params)
    const result = analyzeTrajectory(arr.map(r => ({ date: str(r.date), clicks: num(r.clicks), impressions: num(r.impressions) })))
    return { results: [result], meta: { total: 1, startDate, endDate } }
  },

  buildRows(params) {
    return {
      dates: datesQueryState(trajectoryWindow(params), fetchBudgetOf(params)),
    }
  },

  reduceRows(rows, params) {
    const dates = (Array.isArray(rows) ? rows : []) as unknown as DateRow[]
    const { startDate, endDate } = trajectoryWindow(params)
    const result = analyzeTrajectory(dates.map(r => ({ date: r.date, clicks: r.clicks, impressions: r.impressions })))
    return { results: [result], meta: { total: 1, startDate, endDate } }
  },
})

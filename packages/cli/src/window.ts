/**
 * One window policy for `query`, `analyze`, `report` and MCP `run-report`.
 *
 * Every window ends on an anchor: the newest complete date in the data the
 * command reads. The local Store supplies its newest `done` sync day for the
 * tables a command needs; live reads use `getLatestGscDate()` (3 days ago,
 * Pacific time). The wall clock never sets a window end, so a 7-day window
 * holds 7 final days.
 *
 * `parseWindowFlags` is pure. `newestDoneDate` is the pure core of the Store
 * anchor; `resolveAnchor` is its effectful shell.
 */

import type { ComparisonMode, ResolvedWindow, WindowPreset } from '@gscdump/engine/period'
import type { Result } from 'gscdump/result'
import type { LocalStore, SyncState, TableName } from './local-store'
import { resolveWindow } from '@gscdump/engine/period'
import { getLatestGscDate } from 'gscdump/dates'
import { err, ok } from 'gscdump/result'

export const PERIOD_ALIASES: Readonly<Record<string, WindowPreset>> = {
  '7d': 'last-7d',
  '28d': 'last-28d',
  '30d': 'last-30d',
  '90d': 'last-90d',
  '180d': 'last-180d',
  '365d': 'last-365d',
  'last-7d': 'last-7d',
  'last-28d': 'last-28d',
  'last-30d': 'last-30d',
  'last-90d': 'last-90d',
  'last-180d': 'last-180d',
  'last-365d': 'last-365d',
  'mtd': 'mtd',
  'qtd': 'qtd',
  'ytd': 'ytd',
  'last-quarter': 'last-quarter',
  'custom': 'custom',
}

/** Period values shown in help and errors. */
export const PERIOD_FLAGS = ['7d', '28d', '30d', '90d', '180d', '365d', 'mtd', 'qtd', 'ytd', 'last-quarter', 'custom'] as const

export const COMPARISON_ALIASES: Readonly<Record<string, ComparisonMode>> = {
  'none': 'none',
  'prev': 'prev-period',
  'prev-period': 'prev-period',
  'prior': 'prev-period',
  'prior-period': 'prev-period',
  'yoy': 'yoy',
}

export const COMPARISON_FLAGS = ['none', 'prev-period', 'yoy'] as const

export type WindowFlagError
  = | { kind: 'unknown-period', value: string, message: string }
    | { kind: 'unknown-comparison', value: string, message: string }
    | { kind: 'invalid-date', flag: string, value: string, message: string }
    | { kind: 'inverted-range', message: string }
    | { kind: 'partial-comparison', message: string }
    | { kind: 'period-conflict', message: string }

export interface WindowFlags {
  period?: string
  vs?: string
  start?: string
  end?: string
  prevStart?: string
  prevEnd?: string
}

export interface WindowDefaults {
  preset: Exclude<WindowPreset, 'custom'>
  comparison: ComparisonMode
}

/** Default for `query` and `analyze`. Reports declare their own. */
export const DEFAULT_WINDOW: WindowDefaults = { preset: 'last-28d', comparison: 'none' }

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/

function isCalendarDate(value: string): boolean {
  if (!ISO_DATE_RE.test(value))
    return false
  const date = new Date(`${value}T00:00:00Z`)
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value
}

function checkDate(flag: string, value: string | undefined): WindowFlagError | undefined {
  if (value === undefined || isCalendarDate(value))
    return undefined
  return { kind: 'invalid-date', flag, value, message: `Invalid ${flag} "${value}". Use a calendar date in YYYY-MM-DD format.` }
}

/**
 * Parse window flags into a resolved window that ends on `anchor`.
 *
 * - `--start` or `--end` without `--period` selects a custom window. A
 *   missing `--end` is the anchor. A missing `--start` gives the default
 *   preset's length, ending on `--end`.
 * - `--period` other than `custom` together with `--start`/`--end` is an error.
 * - `--prev-start` and `--prev-end` go together. Both override the comparison.
 */
/**
 * Check the flags that need no anchor: calendar dates, known names, paired
 * comparison bounds and ordered explicit ranges. Commands run it before
 * they resolve a Site, so a typo fails fast.
 */
export function checkWindowFlags(flags: WindowFlags): WindowFlagError | undefined {
  for (const [flag, value] of [['--start', flags.start], ['--end', flags.end], ['--prev-start', flags.prevStart], ['--prev-end', flags.prevEnd]] as const) {
    const invalid = checkDate(flag, value)
    if (invalid)
      return invalid
  }
  const preset = flags.period ? PERIOD_ALIASES[flags.period.toLowerCase()] : undefined
  if (flags.period && !preset)
    return { kind: 'unknown-period', value: flags.period, message: `Unknown --period "${flags.period}". Supported: ${PERIOD_FLAGS.join(', ')}.` }
  if (flags.vs && !COMPARISON_ALIASES[flags.vs.toLowerCase()])
    return { kind: 'unknown-comparison', value: flags.vs, message: `Unknown --vs "${flags.vs}". Supported: ${COMPARISON_FLAGS.join(', ')}.` }
  if ((flags.prevStart === undefined) !== (flags.prevEnd === undefined))
    return { kind: 'partial-comparison', message: 'Pass --prev-start and --prev-end together.' }
  if (preset && preset !== 'custom' && (flags.start !== undefined || flags.end !== undefined))
    return { kind: 'period-conflict', message: `--period ${flags.period} sets its own dates. Remove --start/--end, or pass --period custom.` }
  if (flags.start !== undefined && flags.end !== undefined && flags.start > flags.end)
    return { kind: 'inverted-range', message: `Invalid date range. --start ${flags.start} is after --end ${flags.end}.` }
  if (flags.prevStart !== undefined && flags.prevEnd !== undefined && flags.prevStart > flags.prevEnd)
    return { kind: 'inverted-range', message: `Invalid comparison range. --prev-start ${flags.prevStart} is after --prev-end ${flags.prevEnd}.` }
  return undefined
}

export function parseWindowFlags(
  flags: WindowFlags,
  defaults: WindowDefaults,
  anchor: string,
): Result<ResolvedWindow, WindowFlagError> {
  const invalid = checkWindowFlags(flags)
  if (invalid)
    return err(invalid)
  const preset = flags.period ? PERIOD_ALIASES[flags.period.toLowerCase()] : undefined
  const comparison = flags.vs ? COMPARISON_ALIASES[flags.vs.toLowerCase()]! : defaults.comparison
  const hasBounds = flags.start !== undefined || flags.end !== undefined

  let window: ResolvedWindow
  if (preset === 'custom' || hasBounds) {
    const end = flags.end ?? anchor
    const start = flags.start ?? resolveWindow({ preset: defaults.preset, anchor: end }).start
    if (start > end)
      return err({ kind: 'inverted-range', message: `Invalid date range. --start ${start} is after --end ${end}.` })
    window = resolveWindow({ preset: 'custom', start, end, comparison })
  }
  else {
    window = resolveWindow({ preset: preset ?? defaults.preset, anchor, comparison })
  }

  if (flags.prevStart !== undefined && flags.prevEnd !== undefined)
    window = { ...window, comparison: { start: flags.prevStart, end: flags.prevEnd } }
  return ok(window)
}

export function windowFlagErrorToException(error: WindowFlagError): Error {
  const exception = new Error(error.message)
  ;(exception as Error & { windowFlagError?: WindowFlagError }).windowFlagError = error
  return exception
}

/**
 * Newest date that every listed table has synced (`done`, web search type).
 * An empty table list means any table. Returns undefined when a table has no
 * synced day. Pure.
 */
export function newestDoneDate(states: readonly SyncState[], tables: readonly TableName[]): string | undefined {
  const wanted = tables.length ? tables : [...new Set(states.map(state => state.table))]
  if (!wanted.length)
    return undefined
  let anchor: string | undefined
  for (const table of wanted) {
    let newest: string | undefined
    for (const state of states) {
      if (state.table === table && state.state === 'done' && (state.searchType ?? 'web') === 'web' && (!newest || state.date > newest))
        newest = state.date
    }
    if (!newest)
      return undefined
    if (!anchor || newest < anchor)
      anchor = newest
  }
  return anchor
}

/** One table that a run reads over one window. */
export interface WindowRead {
  window: 'current' | 'comparison'
  table: TableName
  start: string
  end: string
}

/** A read whose window holds days with no `done` sync state. */
export interface CoverageGap extends WindowRead {
  /** First and last day without a `done` sync state. */
  missingStart: string
  missingEnd: string
  missingDays: number
  expectedDays: number
}

export type WindowCoverage
  = | { kind: 'covered' }
    | { kind: 'gaps', gaps: CoverageGap[] }

function daysBetween(start: string, end: string): string[] {
  const out: string[] = []
  for (let time = Date.parse(`${start}T00:00:00Z`); time <= Date.parse(`${end}T00:00:00Z`); time += 86_400_000)
    out.push(new Date(time).toISOString().slice(0, 10))
  return out
}

/**
 * Check that every day of every read has a `done` web sync state. A failed,
 * pending or absent day is a gap: the run would read partial data and report
 * wrong numbers. Duplicate reads count once. Pure.
 */
export function windowCoverage(states: readonly SyncState[], reads: readonly WindowRead[]): WindowCoverage {
  const done = new Set<string>()
  for (const state of states) {
    if (state.state === 'done' && (state.searchType ?? 'web') === 'web')
      done.add(`${state.table}:${state.date}`)
  }
  const seen = new Set<string>()
  const gaps: CoverageGap[] = []
  for (const read of reads) {
    const key = `${read.window}:${read.table}:${read.start}:${read.end}`
    if (seen.has(key))
      continue
    seen.add(key)
    const expected = daysBetween(read.start, read.end)
    const missing = expected.filter(date => !done.has(`${read.table}:${date}`))
    if (missing.length)
      gaps.push({ ...read, missingStart: missing[0]!, missingEnd: missing.at(-1)!, missingDays: missing.length, expectedDays: expected.length })
  }
  return gaps.length ? { kind: 'gaps', gaps } : { kind: 'covered' }
}

export type AnchorTarget
  = | { kind: 'live' }
    | { kind: 'local', store: LocalStore, siteUrl: string, tables: readonly TableName[] }

/**
 * The anchor for a command's window. `local` reads the Store's sync states.
 * When a table has no synced day, `onMissing` runs so the caller can warn,
 * and the window anchors on the GSC date instead.
 */
export async function resolveAnchor(
  target: AnchorTarget,
  onMissing: (tables: readonly TableName[], fallback: string) => void,
): Promise<string> {
  if (target.kind === 'live')
    return getLatestGscDate()
  const states = await target.store.engine.getSyncStates({
    userId: target.store.userId,
    siteId: target.store.siteIdFor(target.siteUrl),
    state: 'done',
  })
  const anchor = newestDoneDate(states, target.tables)
  if (anchor)
    return anchor
  const fallback = getLatestGscDate()
  onMissing(target.tables, fallback)
  return fallback
}

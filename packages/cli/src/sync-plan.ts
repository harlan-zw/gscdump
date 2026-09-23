// Which (table, search type) pairs Google can answer. Pure data, shared by
// `sync` planning and its tests.

import type { SearchType } from 'gscdump/query'
import type { TableName } from './local-store'
import { searchTypeSupportsDimensions, searchTypeSupportsQueries } from '@gscdump/contracts'
import { addDays, getDateRange } from 'gscdump/dates'

/** What a table's Google fetch needs from the search type. */
const TABLE_NEEDS: Record<TableName, { queries: boolean, dimensions: boolean }> = {
  pages: { queries: false, dimensions: false },
  queries: { queries: true, dimensions: false },
  countries: { queries: false, dimensions: true },
  // The `dates` row pivots devices and adds query-grained impressions.
  dates: { queries: true, dimensions: true },
  page_queries: { queries: true, dimensions: false },
  // Search appearance is a Web-family facet, like country and device.
  search_appearance: { queries: false, dimensions: true },
  search_appearance_pages: { queries: false, dimensions: true },
  search_appearance_queries: { queries: true, dimensions: true },
  search_appearance_page_queries: { queries: true, dimensions: true },
  hourly_pages: { queries: false, dimensions: false },
}

/**
 * Days a plain `sync` fetches for a table with no history. It matches the
 * 28 day window of Search Console and of the Analyzers.
 */
/** URLs a sync inspects per run unless `--inspect-limit` says otherwise. */
export const DEFAULT_INSPECT_LIMIT = 50

export const FIRST_SYNC_DAYS = 28

/**
 * Google documents 16 months of retention, but a probe of a real Site still
 * returned rows 12 days past that. `--full` asks for 14 extra days; a day
 * with no rows costs one call.
 */
export const RETENTION_MARGIN_DAYS = 14

/** Google serves hourly rows for about the last 10 days only. */
export const HOURLY_WINDOW_DAYS = 10

export function tableSupportsType(table: TableName, type: SearchType): boolean {
  const needs = TABLE_NEEDS[table]
  return (!needs.queries || searchTypeSupportsQueries(type))
    && (!needs.dimensions || searchTypeSupportsDimensions(type))
}

export interface SyncJob {
  table: TableName
  type: SearchType
  label: string
}

/** Every (table, type) pair Google can answer, plus the pairs it cannot. */
export function planSyncJobs(tables: readonly TableName[], types: readonly SearchType[]): { jobs: SyncJob[], unsupported: SyncJob[] } {
  const jobs: SyncJob[] = []
  const unsupported: SyncJob[] = []
  for (const table of tables) {
    for (const type of types) {
      const job = { table, type, label: type === 'web' ? table : `${table}/${type}` }
      if (tableSupportsType(table, type))
        jobs.push(job)
      else
        unsupported.push(job)
    }
  }
  return { jobs, unsupported }
}

/** Dates a job fetches. Hourly jobs keep only dates inside Google's hourly window. */
export function datesForJob(table: TableName, dates: readonly string[], today: string): string[] {
  if (table !== 'hourly_pages')
    return [...dates]
  const cutoff = new Date(Date.parse(`${today}T00:00:00Z`) - HOURLY_WINDOW_DAYS * 86_400_000).toISOString().slice(0, 10)
  return dates.filter(date => date >= cutoff)
}

/**
 * Which dates a sync covers.
 * - `catch-up`: a plain sync. Each table starts at its oldest synced date,
 *   or `FIRST_SYNC_DAYS` back when that is newer or it has no history.
 * - `range`: `--start`, `--end`, `--days`, or `--full`.
 */
export type SyncWindow
  = | { kind: 'catch-up', firstStart: string, floor: string, end: string }
    | { kind: 'range', start: string, end: string }

/** How done and failed dates are treated. */
export type SyncMode = 'resume' | 'force' | 'retry-failed'

export interface JobDates {
  /** Dates to fetch, newest first, so recent data lands first. */
  dates: string[]
  /** Dates in the window that are already done and stay untouched. */
  skippedDone: number
}

/** A stored sync state, reduced to what planning reads. */
interface JobState {
  date: string
  state: string
}

/** The first date of a job's window. */
export function jobWindowStart(window: SyncWindow, states: readonly JobState[]): string {
  if (window.kind === 'range')
    return window.start
  let oldest: string | undefined
  for (const state of states) {
    if (state.date >= window.floor && (oldest === undefined || state.date < oldest))
      oldest = state.date
  }
  const start = oldest !== undefined && oldest < window.firstStart ? oldest : window.firstStart
  return start < window.floor ? window.floor : start
}

/** The dates one (table, search type) job fetches in this run. */
export function planJobDates(input: {
  table: TableName
  window: SyncWindow
  states: readonly JobState[]
  today: string
  mode: SyncMode
}): JobDates {
  const window = datesForJob(input.table, getDateRange(jobWindowStart(input.window, input.states), input.window.end), input.today)
  const stateByDate = new Map(input.states.map(state => [state.date, state.state]))
  let skippedDone = 0
  const dates = window.filter((date) => {
    const state = stateByDate.get(date)
    if (input.mode === 'force')
      return true
    if (input.mode === 'retry-failed')
      return state === 'failed'
    if (state === 'done') {
      skippedDone++
      return false
    }
    return true
  })
  return { dates: dates.reverse(), skippedDone }
}

/** Start date for `--full`: Google's retention floor plus the margin. */
export function fullHistoryStart(oldestGscDate: string): string {
  return addDays(oldestGscDate, -RETENTION_MARGIN_DAYS)
}

/**
 * The fewest Search Analytics calls one date of a table costs. Plain tables
 * stop on a short page, so a day under 25,000 rows is one call. `dates` adds
 * device and query calls. The engine's slice runners page until an empty
 * page, and search appearance tables add two calls per appearance found.
 */
export function minimumCallsPerDate(table: TableName): number {
  if (table === 'dates')
    return 3
  if (table === 'search_appearance' || table === 'hourly_pages')
    return 2
  if (table.startsWith('search_appearance_'))
    return 2
  return 1
}

/** The dates this run covers, from the flags. */
export function resolveWindow(input: {
  start?: string
  end?: string
  days?: number
  full: boolean
  latest: string
  floor: string
}): SyncWindow {
  const end = input.end ?? input.latest
  if (input.start)
    return { kind: 'range', start: input.start, end }
  if (input.full)
    return { kind: 'range', start: fullHistoryStart(input.floor), end }
  if (input.days !== undefined)
    return { kind: 'range', start: addDays(end, -(input.days - 1)), end }
  return { kind: 'catch-up', firstStart: addDays(end, -(FIRST_SYNC_DAYS - 1)), floor: input.floor, end }
}

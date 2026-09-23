// Which (table, search type) pairs Google can answer. Pure data, shared by
// `sync` planning and its tests.

import type { SearchType } from 'gscdump/query'
import type { TableName } from './local-store'
import { searchTypeSupportsDimensions, searchTypeSupportsQueries } from '@gscdump/contracts'

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

/** Google keeps about 16 months of Search Analytics data. */
export const FULL_HISTORY_DAYS = 486

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
 * Earlier failed dates a plain sync re-runs, by job label. It keeps only
 * dates Google still serves for that job and that the current range misses.
 */
export function planHealDates(opts: {
  jobs: readonly SyncJob[]
  failed: ReadonlyArray<{ table: TableName, searchType?: SearchType | null, date: string }>
  rangeDates: readonly string[]
  today: string
}): Map<string, string[]> {
  const oldestKept = new Date(Date.parse(`${opts.today}T00:00:00Z`) - FULL_HISTORY_DAYS * 86_400_000).toISOString().slice(0, 10)
  const inRange = new Set(opts.rangeDates)
  const heal = new Map<string, string[]>()
  for (const job of opts.jobs) {
    const failed = opts.failed
      .filter(state => state.table === job.table && (state.searchType ?? 'web') === job.type && state.date >= oldestKept && !inRange.has(state.date))
      .map(state => state.date)
    const dates = datesForJob(job.table, failed, opts.today)
    if (dates.length > 0)
      heal.set(job.label, dates)
  }
  return heal
}

import type { SearchType, TableName } from '@gscdump/engine/contracts'
import { TABLES_BY_SEARCH_TYPE } from '@gscdump/engine/sync-config'
import { addDays } from 'gscdump/dates'

export interface GscSyncFanoutEntry {
  table: string
  searchType?: SearchType
}

export interface GscSyncLedgerRow {
  table: string
  searchType: string
  date: string
}

export interface GscSyncWindow extends GscSyncFanoutEntry {
  startDate: string
  endDate: string
}

export interface PlanGscSyncWorkOptions {
  dates: readonly string[]
  fanout: readonly GscSyncFanoutEntry[]
  ledger: readonly GscSyncLedgerRow[]
  pagesPerDayEstimate?: number | null
  /** Target rows per window. The default is the hosted Worker's tested budget. */
  rowBudget?: number
  /** Target window cap. A maxWindowsPerRun limit can widen it. */
  maxSpanDays?: number
  /** Largest number of windows per contiguous run. */
  maxWindowsPerRun?: number
}

export interface GscSyncEntryWork {
  entry: GscSyncFanoutEntry
  missingDates: string[]
  windows: GscSyncWindow[]
}

export interface GscSyncWorkPlan {
  entries: GscSyncEntryWork[]
  missingDates: string[]
  windows: GscSyncWindow[]
}

const DEFAULT_ROW_BUDGET = 25_000
const DEFAULT_MAX_SPAN_DAYS = 31
const DEFAULT_MAX_WINDOWS_PER_RUN = 14

const TABLE_DENSITY: Record<string, number> = {
  pages: 1,
  countries: 0.3,
  dates: 1,
  queries: 3,
  page_queries: 8,
}

/** Build the standard Search Analytics fanout. Web keeps its legacy absent searchType field. */
export function gscSyncFanout(
  searchTypes: readonly SearchType[],
  options: { omitWebDates?: boolean } = {},
): GscSyncFanoutEntry[] {
  return searchTypes.flatMap(searchType => TABLES_BY_SEARCH_TYPE[searchType]
    .filter(table => !(searchType === 'web' && options.omitWebDates && table === 'dates'))
    .map(table => ({
      table,
      ...(searchType === 'web' ? {} : { searchType }),
    })))
}

/** The web queries slice also writes the dates table. Other search types use a dates slice. */
export function tablesCoveredByGscSync(entry: GscSyncFanoutEntry): TableName[] {
  switch (entry.table) {
    case 'pages': return ['pages']
    case 'countries': return ['countries']
    case 'page_queries': return ['page_queries']
    case 'search_appearance': return ['search_appearance']
    case 'search_appearance_pages': return ['search_appearance_pages']
    case 'search_appearance_queries': return ['search_appearance_queries']
    case 'search_appearance_page_queries': return ['search_appearance_page_queries']
    case 'hourly_pages': return ['hourly_pages']
    case 'queries': return entry.searchType === undefined || entry.searchType === 'web' ? ['queries', 'dates'] : ['queries']
    // Empty on purpose: the web queries slice already writes the dates table.
    case 'dates': return entry.searchType === undefined || entry.searchType === 'web' ? [] : ['dates']
    default: throw new RangeError(`Unknown GSC sync fanout table: '${entry.table}'`)
  }
}

/** The minimal set of ledger tables needed to inspect this fanout. */
export function ledgerTablesForGscSync(fanout: readonly GscSyncFanoutEntry[]): TableName[] {
  return [...new Set(fanout.flatMap(tablesCoveredByGscSync))]
}

function positiveInteger(value: number | undefined, fallback: number): number {
  if (value === undefined)
    return fallback
  if (!Number.isFinite(value))
    throw new RangeError('Sync window limits must be finite numbers')
  return Math.max(1, Math.floor(value))
}

function windowDays(
  estimate: number | null | undefined,
  table: string,
  totalDays: number,
  options: PlanGscSyncWorkOptions,
): number {
  const maxSpan = positiveInteger(options.maxSpanDays, DEFAULT_MAX_SPAN_DAYS)
  const maxWindows = positiveInteger(options.maxWindowsPerRun, DEFAULT_MAX_WINDOWS_PER_RUN)
  const rowBudget = positiveInteger(options.rowBudget, DEFAULT_ROW_BUDGET)
  const density = estimate && estimate > 0
    ? Math.max(1, Math.floor(rowBudget / Math.max(1, estimate * (TABLE_DENSITY[table] ?? 1))))
    : 1
  return Math.max(Math.min(maxSpan, density), Math.ceil(totalDays / maxWindows))
}

function contiguousRuns(dates: readonly string[]): Array<{ start: string, end: string, days: number }> {
  const runs: Array<{ start: string, end: string, days: number }> = []
  for (const date of dates) {
    const last = runs.at(-1)
    if (last && addDays(last.end, 1) === date) {
      last.end = date
      last.days++
    }
    else {
      runs.push({ start: date, end: date, days: 1 })
    }
  }
  return runs
}

function windowsForRun(
  entry: GscSyncFanoutEntry,
  run: { start: string, end: string },
  spanDays: number,
): GscSyncWindow[] {
  const windows: GscSyncWindow[] = []
  for (let startDate = run.start; startDate <= run.end; startDate = addDays(windows.at(-1)!.endDate, 1)) {
    const endDate = addDays(startDate, spanDays - 1)
    windows.push({
      ...entry,
      startDate,
      endDate: endDate < run.end ? endDate : run.end,
    })
  }
  return windows
}

/** Plan only slices missing at least one table that their job must write. */
export function planGscSyncWork(options: PlanGscSyncWorkOptions): GscSyncWorkPlan {
  const dates = [...new Set(options.dates)].sort()
  const covered = new Set(options.ledger.map(row => `${row.searchType}|${row.table}|${row.date}`))
  const entries: GscSyncEntryWork[] = []

  for (const entry of options.fanout) {
    const tables = tablesCoveredByGscSync(entry)
    if (tables.length === 0)
      continue
    const searchType = entry.searchType ?? 'web'
    const missingDates = dates.filter(date => tables.some(table => !covered.has(`${searchType}|${table}|${date}`)))
    if (missingDates.length === 0)
      continue
    const windows = contiguousRuns(missingDates).flatMap(run => windowsForRun(
      entry,
      run,
      windowDays(options.pagesPerDayEstimate, entry.table, run.days, options),
    ))
    entries.push({ entry, missingDates, windows })
  }

  return {
    entries,
    missingDates: [...new Set(entries.flatMap(entry => entry.missingDates))].sort(),
    windows: entries.flatMap(entry => entry.windows),
  }
}

export interface PlanGscBackfillDatesOptions {
  _tag: 'repair'
  /** Interior repair never probes before this date. */
  oldestCoveredDate: string
  newestAvailableDate: string
  coveredDates: Iterable<string>
  targetDays: number
}

export interface PlanGscBackwardDatesOptions {
  _tag: 'backfill'
  startFromDate: string
  oldestAvailableDate: string
  targetDays: number
  maxDays: number
}

/** Pick interior gaps or extend history backwards from the oldest covered date. */
export function planGscBackfillDates(options: PlanGscBackfillDatesOptions | PlanGscBackwardDatesOptions): string[] {
  if (!Number.isFinite(options.targetDays) || (options._tag === 'backfill' && !Number.isFinite(options.maxDays)))
    throw new RangeError('Backfill limits must be finite numbers')
  const limit = Math.max(0, Math.floor(Math.min(options.targetDays, options._tag === 'backfill' ? options.maxDays : options.targetDays)))
  if (options._tag === 'repair') {
    const covered = new Set(options.coveredDates)
    const dates: string[] = []
    for (let date = options.oldestCoveredDate; date <= options.newestAvailableDate && dates.length < limit; date = addDays(date, 1)) {
      if (!covered.has(date))
        dates.push(date)
    }
    return dates
  }

  const dates: string[] = []
  for (let date = options.startFromDate; date >= options.oldestAvailableDate && dates.length < limit; date = addDays(date, -1))
    dates.push(date)
  return dates
}

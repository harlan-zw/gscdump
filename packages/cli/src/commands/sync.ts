import type { googleSearchConsole } from 'gscdump/client'
import type { GscSearchAnalyticsMetadata } from 'gscdump/contracts'
import type { SearchType } from 'gscdump/query'
import type { FetchOptions } from 'ofetch'
import type { ResolvedGscdumpConfig } from '../config'
import type { StoreCoverage } from '../coverage'
import type { InspectionSyncResult, SitemapSyncResult } from '../local-entities'
import type { GscApiRow, LocalStore, Row, TableName, WriteCtx } from '../local-store'
import type { QuotaLedger } from '../quota-ledger'
import type { RequestPacer } from '../request-pacer'
import type { SyncJob, SyncMode, SyncWindow } from '../sync-plan'
import type { SyncRun } from '../sync-run'
import { randomUUID } from 'node:crypto'
import process from 'node:process'
import { runGscSearchAppearanceContextSlice, runGscSyncSlice } from '@gscdump/engine-gsc-api'
import { createEmptyTypesStore } from '@gscdump/engine/entities'
import { createRowAccumulator } from '@gscdump/engine/ingest'
import { DEFAULT_ROLLUPS, rebuildRollups } from '@gscdump/engine/rollups'
import { defineCommand } from 'citty'
import { getLatestGscDate, getOldestGscDate, getPstDate, groupIntoRanges } from 'gscdump/dates'
import { SearchTypes } from 'gscdump/query'
import { syncCommandMeta } from '../command-meta'
import { createCommandContext } from '../context'
import { analyticsCoverage, readStoreCoverage, renderCoverage } from '../coverage'
import { INSPECTION_QPD_PER_PROPERTY } from '../inspection-record'
import { inspectionCandidates, syncInspections, syncSitemaps } from '../local-entities'
import { allTables, assembleDatesRow, createLocalStore, TABLE_DIMS } from '../local-store'
import { googleErrorMessage, openQuotaLedger, parseQuotaRefusal, QUOTA_CAPS } from '../quota-ledger'
import { createRequestPacer } from '../request-pacer'
import { loadSitemapUrls } from '../sitemap'
import { DEFAULT_INSPECT_LIMIT, minimumCallsPerDate, planJobDates, planSyncJobs, resolveWindow, RETENTION_MARGIN_DAYS } from '../sync-plan'
import { isProcessAlive, readSyncRun, startSyncRun, syncRunStatus } from '../sync-run'
import { applyOutputMode, clearLine, displayPath, formatAge, logger, OUTPUT_ARGS, parseIntegerOption, parseNameList, progressBar, runWithConcurrency } from '../utils'

const ALL_SEARCH_TYPES = Object.values(SearchTypes) as readonly SearchType[]
// Every table and every search type. Stored empty-type markers skip types
// with no data, and capability rules skip pairs Google cannot answer.
const DEFAULT_TABLES: readonly TableName[] = allTables()
const DEFAULT_TYPES: readonly SearchType[] = ALL_SEARCH_TYPES
const GSC_ROW_LIMIT = 25_000
const MAX_SLICE_ROWS = 5_000_000
const SLICE_TABLES = ['search_appearance', 'search_appearance_pages', 'search_appearance_queries', 'search_appearance_page_queries', 'hourly_pages'] as const
type SliceTable = typeof SLICE_TABLES[number]

function isSliceTable(table: TableName): table is SliceTable {
  return (SLICE_TABLES as readonly string[]).includes(table)
}
const DEFAULT_CONCURRENCY = 8
// Google allows 1,200 Search Analytics queries per minute per site and per
// user, plus a load quota on expensive queries. Every table and search type
// shares one gate: 8 requests in flight and 600 starts per minute, half the
// per-minute limit, so a default full sync stays under both.
const DEFAULT_MAX_IN_FLIGHT = 8
const DEFAULT_REQUESTS_PER_MINUTE = 600
// 50 calls at 4 in flight add about 15 seconds to a daily sync. At that
// rate a site with 1,500 URLs gets each URL inspected about once a month.
const INSPECT_CONCURRENCY = 4
// Minimum days synced before we trust a zero-row result enough to persist
// an empty-type marker. Shorter windows fire false positives on intermittent
// outages or low-traffic sites that happen to have zero clicks one day.
const EMPTY_TYPE_PROBE_MIN_DAYS = 7
// `web` is never skipped — it's the default coverage surface and users
// almost always want it even when the detector sees a transient zero week.
const EMPTY_TYPE_PROTECTED: readonly SearchType[] = ['web']

interface ProgressTracker {
  tick: (label: string) => void
  done: () => void
}

function createProgressTracker(total: number, quiet: boolean): ProgressTracker {
  if (quiet) {
    return { tick: () => {}, done: () => {} }
  }
  let current = 0
  let lastLabel = ''
  let timer: NodeJS.Timeout | null = null
  const render = (): void => {
    clearLine()
    process.stdout.write(progressBar(current, total, lastLabel))
  }
  timer = setInterval(render, 100)
  return {
    tick: (label: string) => {
      current++
      lastLabel = label
    },
    done: () => {
      if (timer) {
        clearInterval(timer)
        timer = null
      }
      clearLine()
    },
  }
}

/**
 * Why a run stopped early. Both leave the unfetched dates `pending`, so the
 * next run continues. Neither is a failure.
 */
export type SyncStop
  = | { kind: 'quota', reason: string, resetsAt: number }
    | { kind: 'budget', maxCalls: number }

/** Stop state for one Site. `budget` stops every Site; `quota` stops only this one. */
interface SiteControl {
  stop?: SyncStop
}

const SYNC_STOP = Symbol('syncStop')

function stopError(stop: SyncStop): Error {
  return Object.assign(new Error(describeStop(stop)), { [SYNC_STOP]: stop })
}

function stopOf(error: unknown): SyncStop | undefined {
  return (error as { [SYNC_STOP]?: SyncStop } | null)?.[SYNC_STOP]
}

function describeStop(stop: SyncStop): string {
  if (stop.kind === 'budget')
    return `Reached --max-calls ${stop.maxCalls}.`
  return `Google quota: ${stop.reason}`
}

interface JobTotals {
  rows: number
  /** Dates already done that this run left alone. */
  skipped: number
  failed: number
  /** Dates fetched but not final yet, or not reached before a stop. */
  pending: number
  /** Dates fetched in this run, final or not. */
  fetched: number
}

async function syncTable(opts: {
  store: LocalStore
  siteUrl: string
  job: SyncJob
  dates: string[]
  skipped: number
  client: ReturnType<typeof googleSearchConsole>
  concurrency: number
  latest: string
  control: SiteControl
  progress: ProgressTracker
  run: Pick<SyncRun, 'tick'>
}): Promise<JobTotals> {
  const { store, siteUrl, job, control, progress } = opts
  const { table, type: searchType } = job
  const dims = TABLE_DIMS[table]
  const siteId = store.siteIdFor(siteUrl)
  const totals: JobTotals = { rows: 0, skipped: opts.skipped, failed: 0, pending: 0, fetched: 0 }

  await runWithConcurrency(opts.dates, opts.concurrency, async (date) => {
    if (control.stop) {
      totals.pending++
      progress.tick(`${job.label} ${date} (later)`)
      return
    }

    const scope = { userId: store.userId, siteId, table, date, searchType }
    await store.engine.setSyncState(scope, 'inflight')

    const result = await runOneDate(store, opts.client, siteUrl, table, searchType, dims, date, opts.latest)
      .catch((err: unknown) => ({ kind: 'error' as const, error: err }))

    if (result.kind === 'error') {
      const stop = stopOf(result.error)
      if (stop) {
        control.stop ??= stop
        await store.engine.setSyncState(scope, 'pending', { error: describeStop(stop) })
        totals.pending++
        progress.tick(`${job.label} ${date} (later)`)
        return
      }
      await store.engine.setSyncState(scope, 'failed', { error: googleErrorMessage(result.error) })
      totals.failed++
      progress.tick(`${job.label} ${date} (fail)`)
      opts.run.tick()
      return
    }

    // A day Google has not finalized stays `pending`, so the next sync fetches it again.
    await store.engine.setSyncState(scope, result.final ? 'done' : 'pending')
    totals.rows += result.rows
    totals.fetched++
    if (!result.final)
      totals.pending++
    progress.tick(`${job.label} ${date}`)
    opts.run.tick()
  })

  return totals
}

/** True when Google has finalized `date`: it is not newer than the latest final date, and no metadata says otherwise. */
function isFinalDate(date: string, latest: string, metadata: GscSearchAnalyticsMetadata | undefined): boolean {
  if (date > latest)
    return false
  const incompleteDate = metadata?.first_incomplete_date
  if (incompleteDate && incompleteDate <= date)
    return false
  const incompleteHour = metadata?.first_incomplete_hour
  return !(incompleteHour && incompleteHour.slice(0, 10) <= date)
}

async function fetchDateRows(
  client: ReturnType<typeof googleSearchConsole>,
  siteUrl: string,
  searchType: SearchType,
  dims: string[],
  date: string,
): Promise<GscApiRow[]> {
  const rows: GscApiRow[] = []
  let startRow = 0

  while (true) {
    const response = await client.searchAnalytics.query(siteUrl, {
      startDate: date,
      endDate: date,
      dimensions: dims,
      // GSC accepts `searchType` (legacy) and the newer `type`. Both work;
      // sending `searchType` is documented and broadly compatible.
      searchType,
      rowLimit: GSC_ROW_LIMIT,
      startRow,
    } as any)
    const batch = response.rows || []
    for (const apiRow of batch) {
      rows.push({
        keys: (apiRow.keys ?? []) as string[],
        clicks: apiRow.clicks ?? 0,
        impressions: apiRow.impressions ?? 0,
        ctr: apiRow.ctr ?? 0,
        position: apiRow.position ?? 0,
      })
    }
    // Google returns at most `rowLimit` rows a page. A shorter page is the
    // last one, so the empty page Google's guide asks for costs a call and
    // adds nothing.
    if (batch.length < GSC_ROW_LIMIT)
      break
    startRow += batch.length
  }
  return rows
}

interface DateResult { kind: 'ok', rows: number, final: boolean }

async function runOneDate(
  store: LocalStore,
  client: ReturnType<typeof googleSearchConsole>,
  siteUrl: string,
  table: TableName,
  searchType: SearchType,
  dims: string[],
  date: string,
  latest: string,
): Promise<DateResult> {
  if (isSliceTable(table))
    return runSliceDate(store, client, siteUrl, table, searchType, date, latest)
  const apiRows = await fetchDateRows(client, siteUrl, searchType, dims, date)
  let rows: Row[] = []
  if (table === 'dates') {
    const totals = apiRows.find(row => row.keys[0] === date)
    if (totals) {
      const deviceRows = await fetchDateRows(client, siteUrl, searchType, ['date', 'device'], date)
      const queryRows = await fetchDateRows(client, siteUrl, searchType, TABLE_DIMS.queries, date)
      const queryImpressions = queryRows.reduce((sum, row) => sum + row.impressions, 0)
      rows.push(assembleDatesRow(date, totals, deviceRows, queryImpressions).row)
    }
  }
  else {
    const accumulator = createRowAccumulator({ maxRows: apiRows.length })
    accumulator.push(table, apiRows)
    rows = accumulator.drain().get(table)?.get(date) ?? []
  }
  // These queries use Google's default `final` data state.
  return writeDayRows(store, siteUrl, table, searchType, date, rows, isFinalDate(date, latest, undefined))
}

// Search appearance and hourly tables need Google's own query shapes, so
// they go through the engine's slice runners instead of `fetchDateRows`.
async function runSliceDate(
  store: LocalStore,
  client: ReturnType<typeof googleSearchConsole>,
  siteUrl: string,
  table: SliceTable,
  searchType: SearchType,
  date: string,
  latest: string,
): Promise<DateResult> {
  const base = { client, siteUrl, startDate: date, endDate: date, searchType, rowLimit: GSC_ROW_LIMIT, cpuBudgetMs: Infinity }
  const drainDay = (accumulator: ReturnType<typeof createRowAccumulator>): Row[] => {
    if (accumulator.overflowed)
      throw new Error(`${table} ${date}: more rows than one sync can hold`)
    return accumulator.drain().get(table)?.get(date) ?? []
  }
  let rows: Row[]
  let metadata: GscSearchAnalyticsMetadata | undefined
  if (table === 'search_appearance' || table === 'hourly_pages') {
    // GSC groups `searchAppearance` only on its own, so the day comes from the query range.
    const accumulator = createRowAccumulator({ maxRows: MAX_SLICE_ROWS, date })
    const result = await runGscSyncSlice({ ...base, table, onBatch: async (batch) => {
      accumulator.push(table, batch)
    } })
    if (result.hasMore)
      throw new Error(`${table} ${date}: Google stopped before the last page`)
    // These slices use the `all` and `hourly_all` data states, which include fresh data.
    metadata = result.metadata
    rows = drainDay(accumulator)
  }
  else {
    // Discover each appearance, then fetch its rows with a filter on it.
    const byAppearance = new Map<string, ReturnType<typeof createRowAccumulator>>()
    const result = await runGscSearchAppearanceContextSlice({
      ...base,
      table,
      onContextBatch: async ({ searchAppearance, rows: batch }) => {
        let accumulator = byAppearance.get(searchAppearance)
        if (!accumulator) {
          accumulator = createRowAccumulator({ maxRows: MAX_SLICE_ROWS, searchAppearance })
          byAppearance.set(searchAppearance, accumulator)
        }
        accumulator.push(table, batch)
      },
    })
    if (result.hasMore)
      throw new Error(`${table} ${date}: Google stopped before the last page`)
    rows = [...byAppearance.values()].flatMap(drainDay)
  }
  return writeDayRows(store, siteUrl, table, searchType, date, rows, isFinalDate(date, latest, metadata))
}

async function writeDayRows(
  store: LocalStore,
  siteUrl: string,
  table: TableName,
  searchType: SearchType,
  date: string,
  rows: Row[],
  final: boolean,
): Promise<DateResult> {
  const writeCtx: WriteCtx = {
    userId: store.userId,
    siteId: store.siteIdFor(siteUrl),
    table,
    date,
    searchType,
  }
  await store.engine.writeDay(writeCtx, rows)
  return { kind: 'ok', rows: rows.length, final }
}

/**
 * The quota ledger is the one budget authority for sync. The core client
 * retries a quota 403 after 5s, 15s and 45s, and each retry is a Google call
 * the ledger never reserved. Sync drops that retry: the gate records the
 * refusal and stops the run, and the next run continues.
 */
const LEDGER_FETCH_OPTIONS: FetchOptions = {
  onResponseError(ctx) {
    if (ctx.options.retryStatusCodes)
      ctx.options.retryStatusCodes = ctx.options.retryStatusCodes.filter(status => status !== 403)
  },
}

export const syncCommand = defineCommand({
  meta: syncCommandMeta,
  args: {
    'site': {
      type: 'string',
      alias: 's',
      description: 'Site URL',
    },
    'all-sites': {
      type: 'boolean',
      default: false,
      description: 'Sync every verified Site, one after another (they share one Google quota)',
    },
    'start': {
      type: 'string',
      description: 'Start date (YYYY-MM-DD) for backfill',
    },
    'end': {
      type: 'string',
      description: 'End date (YYYY-MM-DD); defaults to the latest date Google has finalized',
    },
    'days': {
      type: 'string',
      description: 'Sync the last N final days instead of catching up',
    },
    'tables': {
      type: 'string',
      alias: 't',
      description: `Tables to sync (default: ${DEFAULT_TABLES.join(',')}); comma-separated`,
    },
    'types': {
      type: 'string',
      description: `GSC search types to sync (default: ${DEFAULT_TYPES.join(',')}); comma-separated. Allowed: ${ALL_SEARCH_TYPES.join(',')}.`,
    },
    'force-types': {
      type: 'boolean',
      default: false,
      description: 'Ignore stored empty-type markers and re-probe every requested type',
    },
    'rollups': {
      type: 'boolean',
      default: true,
      description: 'Rebuild rollups after sync (daily and weekly totals, top-N tables)',
      negativeDescription: 'Skip the post-sync rollup rebuild',
    },
    'sitemaps': {
      type: 'boolean',
      default: true,
      description: 'Save the Search Console sitemap list and the URLs in each sitemap',
      negativeDescription: 'Skip saving sitemaps',
    },
    'inspections': {
      type: 'boolean',
      default: true,
      description: 'Run URL Inspection on URLs that are due and save the results',
      negativeDescription: 'Skip URL Inspection',
    },
    'inspect-limit': {
      type: 'string',
      description: `Most URLs to inspect in this run (default: ${DEFAULT_INSPECT_LIMIT}; Google allows ${INSPECTION_QPD_PER_PROPERTY} per Site per day)`,
    },
    'full': {
      type: 'boolean',
      description: `Backfill all the Search Console data Google keeps (16 months, plus ${RETENTION_MARGIN_DAYS} days Google often still serves)`,
    },
    'max-calls': {
      type: 'string',
      description: 'Most Search Analytics calls this run makes. The next run continues where it stopped.',
    },
    ...OUTPUT_ARGS,
    'force': {
      type: 'boolean',
      default: false,
      description: 'Re-sync dates already marked done (default: skip them for idempotent resume)',
    },
    'status': {
      type: 'boolean',
      default: false,
      description: 'Print coverage, gaps, and the running sync instead of syncing',
    },
    'concurrency': {
      type: 'string',
      alias: 'c',
      description: `Concurrent day fetches per table (default: ${DEFAULT_CONCURRENCY}). All tables share ${DEFAULT_MAX_IN_FLIGHT} requests in flight.`,
    },
    'requests-per-minute': {
      type: 'string',
      description: `Most Search Analytics requests to start per minute, across all tables (default: ${DEFAULT_REQUESTS_PER_MINUTE}; Google allows 1,200)`,
    },
    'serial-tables': {
      type: 'boolean',
      default: false,
      description: 'Run tables sequentially (default: run all tables in parallel)',
    },
    'retry-failed': {
      type: 'boolean',
      default: false,
      description: 'Only re-run dates currently in `failed` state (a plain sync also retries them)',
    },
    'dry-run': {
      type: 'boolean',
      default: false,
      description: 'Print the planned (table, searchType, date) work and exit without hitting the API',
    },
  },
  async run({ args }) {
    const { json, quiet } = applyOutputMode(args)
    const days = parseIntegerOption(args.days, '--days')
    const concurrency = parseIntegerOption(args.concurrency, '--concurrency') ?? DEFAULT_CONCURRENCY
    const maxCalls = parseIntegerOption(args['max-calls'], '--max-calls')
    const inspectLimit = Math.min(
      parseIntegerOption(args['inspect-limit'], '--inspect-limit', 0) ?? DEFAULT_INSPECT_LIMIT,
      INSPECTION_QPD_PER_PROPERTY,
    )
    const tables = args.tables ? parseNameList(args.tables, allTables(), '--tables') : DEFAULT_TABLES
    const requestedTypes = args.types ? parseNameList(args.types, ALL_SEARCH_TYPES, '--types') : DEFAULT_TYPES
    if (args.status) {
      const ctx = await createCommandContext()
      await printSyncStatus({ config: ctx.config, dataDir: ctx.dataDir }, args.site ? String(args.site) : undefined, json, inspectLimit)
      return
    }

    const ctx = await createCommandContext({ needsAuth: true, needsStore: true, fetchOptions: LEDGER_FETCH_OPTIONS })
    const store = ctx.store!
    const siteUrls = args['all-sites']
      ? (await ctx.loadSites()).map(site => site.siteUrl)
      : [await ctx.resolveSite(args.site ? String(args.site) : undefined)]

    const latest = getLatestGscDate()
    const window = resolveWindow({
      start: args.start ? String(args.start) : undefined,
      end: args.end ? String(args.end) : undefined,
      days,
      full: Boolean(args.full),
      latest,
      floor: getOldestGscDate(),
    })
    const mode: SyncMode = args['retry-failed'] ? 'retry-failed' : args.force || args['force-types'] ? 'force' : 'resume'

    if (!args['dry-run']) {
      const existing = syncRunStatus(await readSyncRun(store.dataDir), { now: Date.now(), isAlive: isProcessAlive })
      if (existing.kind === 'running') {
        logger.error(`Another sync is running (pid ${existing.record.pid}, ${existing.record.done}/${existing.record.planned} days). Wait for it to finish, or run \`gscdump sync --status\`.`)
        process.exit(1)
      }
    }

    const ledger = await openQuotaLedger({ dataDir: store.dataDir })
    const pacer = createRequestPacer({
      maxInFlight: DEFAULT_MAX_IN_FLIGHT,
      perMinute: Math.min(
        parseIntegerOption(args['requests-per-minute'], '--requests-per-minute') ?? DEFAULT_REQUESTS_PER_MINUTE,
        QUOTA_CAPS.searchAnalytics.perMinute,
      ),
    })
    const calls = { made: 0 }
    const client = gatedClient(ctx.client!, { pacer, ledger, calls, maxCalls })

    const common = { store, client, ledger, tables, requestedTypes, window, mode, latest, concurrency, inspectLimit, json, quiet, args }
    if (args['dry-run']) {
      const plans = []
      for (const siteUrl of siteUrls)
        plans.push(await planSite({ ...common, siteUrl }))
      if (json)
        console.log(JSON.stringify(plans.length === 1 ? plans[0] : { sites: plans }, null, 2))
      return
    }

    const run = await startSyncRun({ dataDir: store.dataDir, sites: siteUrls, onHeartbeat: () => ledger.flush() })
    const onInterrupt = (): void => {
      clearLine()
      logger.warn('Sync interrupted. Run the same command to resume.')
      void Promise.all([run.finish('interrupted'), ledger.flush()])
        .catch((error: Error) => logger.warn(`Could not save sync progress: ${error.message}`))
        .finally(() => process.exit(130))
    }
    process.once('SIGINT', onInterrupt)

    const results: SiteSyncResult[] = []
    for (const siteUrl of siteUrls) {
      run.setSite(siteUrl)
      const result = await syncSite({ ...common, siteUrl, run })
      results.push(result)
      if (result.stop?.kind === 'budget')
        break
    }
    process.off('SIGINT', onInterrupt)

    const failed = results.some(result => result.status === 'failed')
    const stopped = results.some(result => result.status === 'partial')
    await ledger.flush()
    await run.finish(failed ? 'failed' : stopped ? 'stopped' : 'completed')
    if (json) {
      const skippedSites = siteUrls.slice(results.length)
      const reports = results.map(result => result.report)
      console.log(JSON.stringify(siteUrls.length === 1 ? reports[0] : { sites: reports, notStarted: skippedSites }, null, 2))
    }
    else if (siteUrls.length > results.length && !quiet) {
      logger.info(`Not started: ${siteUrls.slice(results.length).join(', ')}. The next sync covers them.`)
    }
    if (failed)
      process.exit(1)
  },
})

interface SiteOptions {
  store: LocalStore
  siteUrl: string
  client: ReturnType<typeof googleSearchConsole>
  ledger: QuotaLedger
  tables: readonly TableName[]
  requestedTypes: readonly SearchType[]
  window: SyncWindow
  mode: SyncMode
  latest: string
  concurrency: number
  inspectLimit: number
  json: boolean
  quiet: boolean
  args: Record<string, unknown>
}

interface SitePlan {
  types: SearchType[]
  skippedTypes: SearchType[]
  jobs: Array<{ job: SyncJob, dates: string[], skipped: number }>
}

async function resolveTypes(opts: SiteOptions, dryRun: boolean): Promise<{ types: SearchType[], skippedTypes: SearchType[], emptyTypes: readonly string[] }> {
  const { store, siteUrl, requestedTypes, quiet } = opts
  const scope = { userId: store.userId, siteId: store.siteIdFor(siteUrl) }
  const emptyTypesStore = createEmptyTypesStore({ dataSource: store.dataSource })
  let emptyTypesDoc = await emptyTypesStore.load(scope)
  // Older sync runs could mark populated types empty after skipping done dates.
  // Existing rows disprove those markers, including rows in unselected tables.
  if (emptyTypesDoc.emptyTypes.length > 0) {
    const entries = await store.engine.listLive(scope)
    const populated = new Set(entries.filter(entry => entry.rowCount > 0).map(entry => entry.searchType ?? 'web'))
    const toClear = requestedTypes.filter(type => emptyTypesDoc.emptyTypes.includes(type) && populated.has(type))
    if (toClear.length > 0) {
      if (!dryRun)
        emptyTypesDoc = await emptyTypesStore.clear(scope, toClear)
      else
        emptyTypesDoc.emptyTypes = emptyTypesDoc.emptyTypes.filter(type => !toClear.includes(type as SearchType))
    }
  }
  const forceTypes = Boolean(opts.args['force-types'])
  const skippedTypes: SearchType[] = []
  const types: SearchType[] = []
  for (const t of requestedTypes) {
    if (!forceTypes && emptyTypesDoc.emptyTypes.includes(t) && !EMPTY_TYPE_PROTECTED.includes(t)) {
      skippedTypes.push(t)
      continue
    }
    types.push(t)
  }
  if (skippedTypes.length > 0 && !quiet) {
    logger.info(
      `Skipping ${skippedTypes.join(', ')} (marked empty for this site; pass --force-types to re-probe).`,
    )
  }
  return { types, skippedTypes, emptyTypes: emptyTypesDoc.emptyTypes }
}

async function buildSitePlan(opts: SiteOptions, types: SearchType[], skippedTypes: SearchType[]): Promise<SitePlan> {
  const { store, siteUrl, tables, quiet, args } = opts
  const { jobs, unsupported } = planSyncJobs(tables, types)
  if (unsupported.length > 0 && !quiet && (args.tables || args.types))
    logger.info(`Skipping ${unsupported.map(job => job.label).join(', ')}: Google has no such breakdown for that search type.`)
  const states = await store.engine.getSyncStates({ userId: store.userId, siteId: store.siteIdFor(siteUrl) })
  const today = getPstDate()
  return {
    types,
    skippedTypes,
    jobs: jobs.map((job) => {
      const jobStates = states.filter(state => state.table === job.table && (state.searchType ?? 'web') === job.type)
      const planned = planJobDates({ table: job.table, window: opts.window, states: jobStates, today, mode: opts.mode })
      return { job, dates: planned.dates, skipped: planned.skippedDone }
    }),
  }
}

function windowLabel(window: SyncWindow): string {
  return window.kind === 'range'
    ? `${window.start} → ${window.end}`
    : `catch up to ${window.end} (new tables start ${window.firstStart})`
}

async function planSite(opts: SiteOptions): Promise<Record<string, unknown>> {
  const { types, skippedTypes } = await resolveTypes(opts, true)
  const plan = await buildSitePlan(opts, types, skippedTypes)
  const items = plan.jobs.flatMap(({ job, dates }) => dates.map(date => ({ table: job.table, searchType: job.type, date, calls: minimumCallsPerDate(job.table) })))
  const minimumCalls = items.reduce((sum, item) => sum + item.calls, 0)
  const ranges = groupIntoRanges([...new Set(items.map(item => item.date))])
  if (!opts.json) {
    console.log()
    logger.info(`Plan: at least ${minimumCalls.toLocaleString('en-US')} Search Analytics call(s) for ${opts.siteUrl}`)
    console.log(`  Tables:   ${opts.tables.join(', ')}`)
    console.log(`  Types:    ${types.join(', ')}`)
    console.log(`  Window:   ${windowLabel(opts.window)}`)
    console.log(`  Dates:    ${ranges.length === 0 ? 'none; every date is done' : ranges.map(range => range.startDate === range.endDate ? range.startDate : `${range.startDate}..${range.endDate}`).join(', ')}`)
    console.log()
    logger.info('Pass without --dry-run to execute. Google may need more calls for large days and search appearances.')
  }
  return {
    siteUrl: opts.siteUrl,
    window: opts.window,
    tables: opts.tables,
    types,
    skippedTypes,
    ranges,
    minimumCalls,
    totalCalls: minimumCalls,
    plan: items,
  }
}

interface SiteSyncResult {
  status: 'completed' | 'partial' | 'failed' | 'skipped'
  stop?: SyncStop
  report: Record<string, unknown>
}

async function syncSite(opts: SiteOptions & { run: SyncRun }): Promise<SiteSyncResult> {
  const { store, siteUrl, client, quiet, run } = opts
  const siteId = store.siteIdFor(siteUrl)
  const scope = { userId: store.userId, siteId }
  const { types, skippedTypes, emptyTypes } = await resolveTypes(opts, false)
  const forceTypes = Boolean(opts.args['force-types'])

  const report = async (status: SiteSyncResult['status'], totals: Record<string, JobTotals>, extra: Record<string, unknown> = {}): Promise<Record<string, unknown>> => ({
    status,
    siteUrl,
    window: opts.window,
    tables: opts.tables,
    types,
    skippedTypes,
    totals,
    watermarks: await store.engine.getWatermarks(scope),
    ...extra,
  })

  if (types.length === 0) {
    if (!quiet)
      logger.warn(`All requested types are marked empty. Pass --force-types to check them again.`)
    return { status: 'skipped', report: await report('skipped', {}, { reason: 'empty-types' }) }
  }

  const plan = await buildSitePlan(opts, types, skippedTypes)
  const plannedDates = plan.jobs.reduce((sum, entry) => sum + entry.dates.length, 0)
  if (opts.mode === 'retry-failed' && plannedDates === 0) {
    if (!quiet)
      logger.success('No failed dates in range. Nothing to retry.')
    return { status: 'skipped', report: await report('skipped', {}, { reason: 'no-failed-dates' }) }
  }

  // Mark the whole plan pending first, so status and coverage see it and a
  // killed run leaves an honest record.
  await store.engine.setSyncStates(
    plan.jobs.flatMap(({ job, dates }) => dates.map(date => ({ userId: store.userId, siteId, table: job.table, date, searchType: job.type }))),
    'pending',
  )
  run.addPlanned(plannedDates)

  if (!quiet) {
    const ranges = groupIntoRanges([...new Set(plan.jobs.flatMap(entry => entry.dates))])
    logger.info(`Syncing ${siteUrl} (${opts.tables.join(', ')}) [${types.join(', ')}] → ${displayPath(store.dataDir)}`)
    logger.info(ranges.length === 0
      ? `Every date is done up to ${opts.latest}.`
      : `${plannedDates.toLocaleString('en-US')} table days, newest first: ${ranges.slice(-3).reverse().map(range => range.startDate === range.endDate ? range.startDate : `${range.startDate}..${range.endDate}`).join(', ')}${ranges.length > 3 ? `, and ${ranges.length - 3} more range(s)` : ''}`)
  }

  const control: SiteControl = {}
  const start = Date.now()
  const totals: Record<string, JobTotals> = {}
  const progress = createProgressTracker(plannedDates, quiet)
  const runJob = (entry: SitePlan['jobs'][number]): Promise<JobTotals> => syncTable({
    store,
    siteUrl,
    job: entry.job,
    dates: entry.dates,
    skipped: entry.skipped,
    client,
    concurrency: opts.concurrency,
    latest: opts.latest,
    control,
    progress,
    run,
  })
  if (opts.args['serial-tables']) {
    for (const entry of plan.jobs)
      totals[entry.job.label] = await runJob(entry)
  }
  else {
    const results = await Promise.all(plan.jobs.map(runJob))
    plan.jobs.forEach((entry, i) => {
      totals[entry.job.label] = results[i]!
    })
  }
  progress.done()
  await run.save()

  const seconds = ((Date.now() - start) / 1000).toFixed(1)
  if (!quiet) {
    logger.success(`Synced ${siteUrl} in ${seconds}s`)
    for (const [t, n] of Object.entries(totals)) {
      const suffix = [
        n.skipped > 0 ? `${n.skipped} already done` : null,
        n.pending > 0 ? `${n.pending} for the next sync` : null,
        n.failed > 0 ? `\x1B[31m${n.failed} failed\x1B[0m` : null,
      ].filter(Boolean).join(', ')
      const tail = suffix ? ` (${suffix})` : ''
      console.log(`  ${t}: ${n.rows.toLocaleString()} rows${tail}`)
    }
    console.log()
  }
  // A budget stop is planned progress. A quota refusal blocks progress, so it warns.
  if (control.stop?.kind === 'budget' && !quiet)
    logger.info(`${describeStop(control.stop)} The next sync continues from here.`)
  else if (control.stop?.kind === 'quota' && !opts.json)
    logger.warn(`${describeStop(control.stop)} The next sync continues after ${clockTime(control.stop.resetsAt)}.`)

  const anyFailed = Object.values(totals).some(t => t.failed > 0)

  // Only fresh, complete probes can establish emptiness. Skipped dates
  // provide no evidence. Existing rows also rule out a site-wide marker.
  if (!forceTypes && opts.tables.length > 0 && !control.stop) {
    const toMark: SearchType[] = []
    for (const type of types) {
      if (EMPTY_TYPE_PROTECTED.includes(type))
        continue
      const typeTotals = plan.jobs.filter(entry => entry.job.type === type).map(entry => totals[entry.job.label]!)
      const probed = typeTotals.length > 0 && typeTotals.every(t => t.fetched >= EMPTY_TYPE_PROBE_MIN_DAYS && t.skipped === 0 && t.failed === 0 && t.rows === 0)
      if (!probed)
        continue
      const entries = await store.engine.listLive({ ...scope, searchType: type })
      if (entries.some(entry => entry.rowCount > 0))
        continue
      toMark.push(type)
    }
    if (toMark.length > 0) {
      await createEmptyTypesStore({ dataSource: store.dataSource }).mark(scope, toMark)
      if (!quiet)
        logger.info(`Marked empty for future syncs: ${toMark.join(', ')} (0 rows across ${EMPTY_TYPE_PROBE_MIN_DAYS}+ days; pass --force-types to re-probe).`)
    }
  }
  // If --force-types surfaced real data for a type we previously marked,
  // drop that marker so subsequent plain syncs pick it up automatically.
  if (forceTypes && emptyTypes.length > 0) {
    const toClear = types.filter(type => emptyTypes.includes(type)
      && plan.jobs.some(entry => entry.job.type === type && totals[entry.job.label]!.rows > 0))
    if (toClear.length > 0) {
      await createEmptyTypesStore({ dataSource: store.dataSource }).clear(scope, toClear)
      if (!quiet)
        logger.info(`Cleared empty markers for: ${toClear.join(', ')} (re-probe found data).`)
    }
  }

  // Post-sync rollups: rebuild aggregates so the dashboard's cached widgets
  // reflect the sync we just ran. Skipped on --no-rollups, on zero-row syncs
  // (nothing to aggregate), and on full-failure runs (would read stale data).
  const noRollups = opts.args.rollups === false
  let rollupError: string | undefined
  const anyRowsSynced = Object.values(totals).some(t => t.rows > 0)
  if (!noRollups && anyRowsSynced) {
    if (!quiet)
      logger.info(`Rebuilding rollups for [${siteId}] (${DEFAULT_ROLLUPS.length} rollups)…`)
    const rollupStart = Date.now()
    const results = await rebuildRollups({
      engine: {
        runSQL: sqlOpts => store.engine.runSQL(sqlOpts),
        listPartitions: async ({ ctx, table, searchType }) => {
          const entries = await store.engine.listLive({
            userId: ctx.userId,
            ...(ctx.siteId !== undefined ? { siteId: ctx.siteId } : {}),
            table,
            ...(searchType !== undefined ? { searchType } : {}),
          })
          return entries.map(e => ({ partition: e.partition, bytes: e.bytes }))
        },
      },
      dataSource: store.dataSource,
      ctx: scope,
      defs: DEFAULT_ROLLUPS,
    }).catch((err: Error) => {
      rollupError = err.message
      logger.warn(`Rollup rebuild failed: ${err.message}`)
      return [] as Awaited<ReturnType<typeof rebuildRollups>>
    })
    if (!quiet && results.length > 0) {
      const kb = results.reduce((a, r) => a + r.bytes, 0) / 1024
      const ms = Date.now() - rollupStart
      logger.success(`Rebuilt ${results.length} rollup(s) in ${ms}ms — ${kb.toFixed(1)} KB`)
    }
  }

  const entities = await syncEntities({
    store,
    client,
    siteUrl,
    ledger: opts.ledger,
    sitemaps: opts.args.sitemaps !== false,
    inspections: opts.args.inspections !== false,
    inspectLimit: opts.inspectLimit,
    quiet,
  })

  await opts.ledger.flush()
  const coverage = await readStoreCoverage({ store, site: siteUrl, inspectLimit: opts.inspectLimit, run: { kind: 'none' } })
  if (!quiet) {
    for (const line of renderCoverage(coverage))
      console.log(`  ${line}`)
    console.log()
  }

  const status: SiteSyncResult['status'] = anyFailed || rollupError ? 'failed' : control.stop ? 'partial' : 'completed'
  return {
    status,
    ...(control.stop ? { stop: control.stop } : {}),
    report: await report(status, totals, {
      ...(control.stop ? { stopped: control.stop } : {}),
      ...(rollupError ? { rollupError } : {}),
      ...entities,
      coverage,
    }),
  }
}

type EntityStep<T> = T | { _tag: 'disabled' } | { _tag: 'failed', reason: string }

export interface EntitySyncReport {
  sitemaps: EntityStep<SitemapSyncResult>
  inspections: EntityStep<InspectionSyncResult>
}

function failureReason(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function clockTime(at: number): string {
  return new Date(at).toLocaleString('en-US', { hour: 'numeric', minute: '2-digit', month: 'short', day: 'numeric' })
}

/**
 * Save sitemaps and URL Inspection results after the analytics sync. A
 * failure here is logged and reported. It never fails the analytics sync.
 */
async function syncEntities(opts: {
  store: LocalStore
  client: ReturnType<typeof googleSearchConsole>
  siteUrl: string
  ledger: QuotaLedger
  sitemaps: boolean
  inspections: boolean
  inspectLimit: number
  quiet: boolean
}): Promise<EntitySyncReport> {
  const { store, client, siteUrl, quiet } = opts
  const ctx = { userId: store.userId, siteId: store.siteIdFor(siteUrl) }
  const now = (): Date => new Date()

  let sitemaps: EntitySyncReport['sitemaps'] = { _tag: 'disabled' }
  if (opts.sitemaps) {
    if (!quiet)
      logger.info('Saving sitemaps…')
    sitemaps = await syncSitemaps({
      client,
      dataSource: store.dataSource,
      ctx,
      siteUrl,
      now,
      generationId: randomUUID,
      loadFeed: async (url) => {
        const loaded = await loadSitemapUrls(url, { maxUrls: 500_000, maxDocuments: 1000 })
        return loaded._tag === 'ok'
          ? { _tag: 'ok', entries: loaded.value.entries, complete: loaded.value.complete }
          : loaded
      },
    }).catch((error: unknown) => ({ _tag: 'failed' as const, reason: failureReason(error) }))
    if (sitemaps._tag === 'failed') {
      logger.warn(`Sitemaps not saved: ${sitemaps.reason}`)
    }
    else if (sitemaps._tag === 'list_only') {
      logger.warn(`Saved ${sitemaps.sitemaps} sitemap(s). Kept the stored sitemap URLs: ${sitemaps.reason}`)
    }
    else if (!quiet) {
      logger.success(`Saved ${sitemaps.sitemaps} sitemap(s) with ${sitemaps.urls.toLocaleString()} URL(s)`)
    }
    if (sitemaps._tag === 'saved' || sitemaps._tag === 'list_only') {
      for (const feed of sitemaps.feeds) {
        if (feed._tag === 'unreachable')
          logger.warn(`  ${feed.path}: ${feed.message}`)
        else if (!feed.complete)
          logger.warn(`  ${feed.path}: read stopped early; saved ${feed.urls.toLocaleString()} URL(s)`)
      }
    }
  }

  let inspections: EntitySyncReport['inspections'] = { _tag: 'disabled' }
  if (opts.inspections && opts.inspectLimit > 0) {
    inspections = await (async () => {
      const candidates = await inspectionCandidates(store, siteUrl)
      const progress = createProgressTracker(Math.min(opts.inspectLimit, candidates.length), quiet)
      const result = await syncInspections({
        client,
        dataSource: store.dataSource,
        ctx,
        siteUrl,
        candidates,
        limit: opts.inspectLimit,
        concurrency: INSPECT_CONCURRENCY,
        ledger: opts.ledger,
        now,
        onProgress: () => progress.tick('inspect'),
      }).finally(() => progress.done())
      return result
    })().catch((error: unknown) => ({ _tag: 'failed' as const, reason: failureReason(error) }))
    if (inspections._tag === 'failed') {
      logger.warn(`URL Inspection not saved: ${inspections.reason}`)
    }
    else if (inspections._tag === 'quota_exhausted') {
      logger.warn(`URL Inspection paused until ${clockTime(inspections.resetsAt)}: ${inspections.reason}`)
    }
    else if (inspections._tag === 'inspected') {
      if (!quiet)
        logger.success(`Inspected ${inspections.inspected} URL(s); ${inspections.deferred} due URL(s) left for later runs`)
      if (inspections.stopped)
        logger.warn(`URL Inspection paused until ${clockTime(inspections.stopped.resetsAt)}: ${inspections.stopped.reason}`)
      if (inspections.failed > 0) {
        logger.warn(`${inspections.failed} URL Inspection call(s) failed:`)
        for (const failure of inspections.failures.slice(0, 5))
          logger.warn(`  ${failure.url}: ${failure.error}`)
      }
    }
    else if (!quiet) {
      logger.info(inspections.quotaLeft === 0
        ? 'URL Inspection quota is used up for today'
        : 'No URLs are due for URL Inspection')
    }
  }

  return { sitemaps, inspections }
}

/**
 * Every Search Analytics query goes through the quota ledger, the
 * `--max-calls` budget, and the shared pacer. A quota refusal from Google,
 * after the client's own backoff, blocks the api in the ledger and stops the
 * Site's run. Other calls pass through.
 */
function gatedClient(
  client: ReturnType<typeof googleSearchConsole>,
  gate: { pacer: RequestPacer, ledger: QuotaLedger, calls: { made: number }, maxCalls: number | undefined },
): ReturnType<typeof googleSearchConsole> {
  const query = client.searchAnalytics.query
  return {
    ...client,
    searchAnalytics: {
      ...client.searchAnalytics,
      query: async (...args: Parameters<typeof query>) => {
        const [siteUrl] = args
        if (gate.maxCalls !== undefined && gate.calls.made >= gate.maxCalls)
          throw stopError({ kind: 'budget', maxCalls: gate.maxCalls })
        const decision = gate.ledger.reserve('searchAnalytics', siteUrl, 1)
        if (decision.kind === 'exhausted')
          throw stopError({ kind: 'quota', reason: decision.reason, resetsAt: decision.resetsAt })
        gate.calls.made++
        return pacer(gate.pacer, () => query(...args)).catch((error: unknown) => {
          const refusal = parseQuotaRefusal(error)
          if (!refusal)
            throw error
          gate.ledger.record('searchAnalytics', siteUrl, { kind: 'refused', reason: refusal })
          const status = gate.ledger.status('searchAnalytics', siteUrl)
          throw stopError({ kind: 'quota', reason: refusal, resetsAt: status.blocked?.until ?? Date.now() })
        })
      },
    },
  }
}

function pacer<T>(requestPacer: RequestPacer, task: () => Promise<T>): Promise<T> {
  return requestPacer.run(task)
}

async function printSyncStatus(
  resolved: ResolvedGscdumpConfig,
  siteFilter: string | undefined,
  asJson: boolean,
  inspectLimit: number,
): Promise<void> {
  const store = createLocalStore({ dataDir: resolved.dataDir })
  const siteId = siteFilter ? store.siteIdFor(siteFilter) : undefined
  const run = syncRunStatus(await readSyncRun(store.dataDir), { now: Date.now(), isAlive: isProcessAlive })

  const watermarks = await store.engine.getWatermarks({ userId: store.userId, siteId })
  const states = await store.engine.getSyncStates({ userId: store.userId, siteId })
  const failed = states.filter(s => s.state === 'failed')
  // An inflight date with no live sync belongs to a killed run. The next sync retries it.
  const inflight = states.filter(s => s.state === 'inflight')
  const staleInflight = run.kind === 'running' ? [] : inflight

  const bySite = new Map<string, typeof states>()
  for (const state of states) {
    const key = state.siteId ?? ''
    bySite.set(key, [...(bySite.get(key) ?? []), state])
  }
  const latest = getLatestGscDate()
  const gaps = [...bySite].flatMap(([id, siteStates]) =>
    analyticsCoverage({ states: siteStates, latest, floor: getOldestGscDate(), today: getPstDate() }).jobs.map(job => ({
      siteId: id,
      table: job.table,
      searchType: job.searchType,
      from: job.from,
      to: job.to,
      done: job.coverage.kind === 'complete' ? job.coverage.done : job.coverage.kind === 'partial' ? job.coverage.done : 0,
      missing: job.coverage.kind === 'partial' ? job.coverage.pending : 0,
      failed: job.coverage.kind === 'partial' ? job.coverage.failed : 0,
    })))

  const coverageSites = siteFilter
    ? [siteFilter]
    : [...new Set([...(run.kind === 'none' ? [] : run.record.sites), ...(resolved.config.defaultSite ? [resolved.config.defaultSite] : [])])]
  const coverages: StoreCoverage[] = []
  for (const site of coverageSites)
    coverages.push(await readStoreCoverage({ store, site, inspectLimit, run }))

  if (asJson) {
    console.log(JSON.stringify({
      dataDir: store.dataDir,
      siteFilter: siteFilter ?? null,
      run,
      gaps,
      coverage: coverages,
      watermarks,
      failed,
      inflight,
      staleInflight: staleInflight.length,
    }, null, 2))
    return
  }

  console.log()
  console.log(`  \x1B[1m${displayPath(store.dataDir)}\x1B[0m`)
  if (siteFilter)
    console.log(`  \x1B[90mSite: ${siteFilter}\x1B[0m`)
  console.log()

  if (run.kind === 'running')
    console.log(`  Sync running: ${run.record.done}/${run.record.planned} days${run.record.site ? ` for ${run.record.site}` : ''}, pid ${run.record.pid}, started ${formatAge(run.record.startedAt)}.`)
  else if (run.kind === 'stale')
    console.log(`  \x1B[33mThe last sync stopped without finishing (pid ${run.record.pid}, ${run.reason === 'process-gone' ? 'process gone' : 'no heartbeat'}). The next sync retries its dates.\x1B[0m`)

  if (gaps.length === 0 && watermarks.length === 0) {
    console.log(`  No synced data. Run \`gscdump sync\` to fill the Store.`)
    console.log()
    return
  }

  console.log(`  \x1B[1mTables:\x1B[0m`)
  for (const gap of gaps) {
    const label = `${gap.searchType === 'web' ? gap.table : `${gap.table}/${gap.searchType}`}${siteFilter ? '' : `@${gap.siteId}`}`
    const parts = [`${gap.done} done`]
    if (gap.missing > 0)
      parts.push(`${gap.missing} missing`)
    if (gap.failed > 0)
      parts.push(`\x1B[31m${gap.failed} failed\x1B[0m`)
    console.log(`  ${label.padEnd(34)} \x1B[36m${gap.from}\x1B[0m → \x1B[36m${gap.to}\x1B[0m  ${parts.join(', ')}`)
  }

  if (staleInflight.length > 0) {
    console.log()
    console.log(`  \x1B[33m${staleInflight.length} date(s) stale from a stopped sync. The next sync retries them.\x1B[0m`)
  }

  if (failed.length > 0) {
    console.log()
    console.log(`  \x1B[31m${failed.length} failed:\x1B[0m`)
    for (const s of failed.slice(0, 20))
      console.log(`    ${s.table}${s.siteId ? `@${s.siteId}` : ''} ${s.date}: ${s.error ?? 'unknown'}`)
    if (failed.length > 20)
      console.log(`    and ${failed.length - 20} more`)
  }

  for (const coverage of coverages) {
    console.log()
    console.log(`  \x1B[1m${coverage.site}\x1B[0m`)
    for (const line of renderCoverage(coverage))
      console.log(`  ${line}`)
  }
  if (coverages.length === 0) {
    console.log()
    console.log(`  Pass --site to see inspection and sitemap coverage.`)
  }
  console.log()
}

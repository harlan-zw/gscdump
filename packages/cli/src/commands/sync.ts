import type { googleSearchConsole } from 'gscdump/client'
import type { SearchType } from 'gscdump/query'
import type { ResolvedGscdumpConfig } from '../config'
import type { InspectionSyncResult, SitemapSyncResult } from '../local-entities'
import type { GscApiRow, LocalStore, Row, TableName, WriteCtx } from '../local-store'
import type { RequestPacer } from '../request-pacer'
import { randomUUID } from 'node:crypto'
import process from 'node:process'
import { runGscSearchAppearanceContextSlice, runGscSyncSlice } from '@gscdump/engine-gsc-api'
import { createEmptyTypesStore } from '@gscdump/engine/entities'
import { createRowAccumulator } from '@gscdump/engine/ingest'
import { DEFAULT_ROLLUPS, rebuildRollups } from '@gscdump/engine/rollups'
import { defineCommand } from 'citty'
import { daysAgoUtc as daysAgo, getDateRange } from 'gscdump/dates'
import { SearchTypes } from 'gscdump/query'
import { syncCommandMeta } from '../command-meta'
import { createCommandContext } from '../context'
import { INSPECTION_QPD_PER_PROPERTY } from '../inspection-record'
import { loadSitemapGenerationUrls, resolvePagePaths, syncInspections, syncSitemaps } from '../local-entities'
import { allTables, assembleDatesRow, createLocalStore, TABLE_DIMS } from '../local-store'
import { createRequestPacer } from '../request-pacer'
import { loadSitemapUrls } from '../sitemap'
import { datesForJob, FULL_HISTORY_DAYS, planSyncJobs } from '../sync-plan'
import { formatSiteIdCollision, readSiteMap, recordStoreSite, siteUrlForId } from '../store-sites'
import { applyOutputMode, clearLine, displayPath, formatAge, logger, OUTPUT_ARGS, parseIntegerOption, progressBar, runWithConcurrency } from '../utils'

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
const DEFAULT_PENDING_DAYS = 3
const DEFAULT_CONCURRENCY = 8
// Google allows 1,200 Search Analytics queries per minute per site and per
// user, plus a load quota on expensive queries. Every table and search type
// shares one gate: 8 requests in flight and 600 starts per minute, half the
// per-minute limit, so a default full sync stays under both.
const DEFAULT_MAX_IN_FLIGHT = 8
const DEFAULT_REQUESTS_PER_MINUTE = 600
// 50 calls at 4 in flight add about 15 seconds to a daily sync. At that
// rate a site with 1,500 URLs gets each URL inspected about once a month.
const DEFAULT_INSPECT_LIMIT = 50
const INSPECT_CONCURRENCY = 4
// Traffic-ranked pages to consider for inspection, before sitemap URLs.
const INSPECT_PAGE_CANDIDATES = 5000
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

async function syncTable(
  store: LocalStore,
  siteUrl: string,
  table: TableName,
  searchType: SearchType,
  dates: string[],
  client: ReturnType<typeof googleSearchConsole>,
  concurrency: number,
  force: boolean,
  progress: ProgressTracker,
): Promise<{ rows: number, skipped: number, failed: number }> {
  const dims = TABLE_DIMS[table]
  const siteId = store.siteIdFor(siteUrl)
  let totalRows = 0
  let skipped = 0
  let failed = 0

  const priorStates = await store.engine.getSyncStates({
    userId: store.userId,
    siteId,
    table,
    searchType,
  })
  const stateByDate = new Map(priorStates.map(s => [s.date, s]))
  const label = searchType === 'web' ? table : `${table}/${searchType}`

  await runWithConcurrency(dates, concurrency, async (date) => {
    const prior = stateByDate.get(date)
    if (!force && prior?.state === 'done') {
      skipped++
      progress.tick(`${label} ${date} (skip)`)
      return
    }

    const scope = { userId: store.userId, siteId, table, date, searchType }
    await store.engine.setSyncState(scope, 'inflight')

    const result = await runOneDate(store, client, siteUrl, table, searchType, dims, date)
      .catch((err: Error) => ({ kind: 'error' as const, error: err }))

    if (result.kind === 'error') {
      await store.engine.setSyncState(scope, 'failed', { error: result.error.message })
      failed++
      progress.tick(`${label} ${date} (fail)`)
      return
    }

    await store.engine.setSyncState(scope, 'done')
    totalRows += result.rows
    progress.tick(`${label} ${date}`)
  })

  return { rows: totalRows, skipped, failed }
}

async function fetchDateRows(
  client: ReturnType<typeof googleSearchConsole>,
  siteUrl: string,
  searchType: SearchType,
  dims: string[],
  date: string,
): Promise<GscApiRow[]> {
  const rowLimit = 25000
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
      rowLimit,
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
    if (batch.length === 0)
      break
    startRow += batch.length
  }
  return rows
}

async function runOneDate(
  store: LocalStore,
  client: ReturnType<typeof googleSearchConsole>,
  siteUrl: string,
  table: TableName,
  searchType: SearchType,
  dims: string[],
  date: string,
): Promise<{ kind: 'ok', rows: number }> {
  if (isSliceTable(table))
    return runSliceDate(store, client, siteUrl, table, searchType, date)
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
  return writeDayRows(store, siteUrl, table, searchType, date, rows)
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
): Promise<{ kind: 'ok', rows: number }> {
  const base = { client, siteUrl, startDate: date, endDate: date, searchType, rowLimit: GSC_ROW_LIMIT, cpuBudgetMs: Infinity }
  const drainDay = (accumulator: ReturnType<typeof createRowAccumulator>): Row[] => {
    if (accumulator.overflowed)
      throw new Error(`${table} ${date}: more rows than one sync can hold`)
    return accumulator.drain().get(table)?.get(date) ?? []
  }
  let rows: Row[]
  if (table === 'search_appearance' || table === 'hourly_pages') {
    // GSC groups `searchAppearance` only on its own, so the day comes from the query range.
    const accumulator = createRowAccumulator({ maxRows: MAX_SLICE_ROWS, date })
    const result = await runGscSyncSlice({ ...base, table, onBatch: async (batch) => {
      accumulator.push(table, batch)
    } })
    if (result.hasMore)
      throw new Error(`${table} ${date}: Google stopped before the last page`)
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
  return writeDayRows(store, siteUrl, table, searchType, date, rows)
}

async function writeDayRows(
  store: LocalStore,
  siteUrl: string,
  table: TableName,
  searchType: SearchType,
  date: string,
  rows: Row[],
): Promise<{ kind: 'ok', rows: number }> {
  const writeCtx: WriteCtx = {
    userId: store.userId,
    siteId: store.siteIdFor(siteUrl),
    table,
    date,
    searchType,
  }
  await store.engine.writeDay(writeCtx, rows)
  return { kind: 'ok', rows: rows.length }
}

export const syncCommand = defineCommand({
  meta: syncCommandMeta,
  args: {
    'site': {
      type: 'string',
      alias: 's',
      description: 'Site, for example example.com',
    },
    'start': {
      type: 'string',
      description: 'Start date (YYYY-MM-DD) for backfill',
    },
    'end': {
      type: 'string',
      description: 'End date (YYYY-MM-DD); defaults to 3 days ago',
    },
    'days': {
      type: 'string',
      description: `Number of days back to sync (default: ${DEFAULT_PENDING_DAYS})`,
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
      description: `Most URLs to inspect in this run (default: ${DEFAULT_INSPECT_LIMIT}; Google allows ${INSPECTION_QPD_PER_PROPERTY} per property per day)`,
    },
    'full': {
      type: 'boolean',
      description: `Backfill up to ${FULL_HISTORY_DAYS} days, all the Search Console data Google keeps`,
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
      description: 'Print watermarks + sync-state summary instead of syncing',
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
      description: 'Only re-run dates currently in `failed` state (cheaper than --force)',
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
    const inspectLimit = Math.min(
      parseIntegerOption(args['inspect-limit'], '--inspect-limit', 0) ?? DEFAULT_INSPECT_LIMIT,
      INSPECTION_QPD_PER_PROPERTY,
    )
    if (args.status) {
      const ctx = await createCommandContext()
      const siteUrl = args.site ? await ctx.resolveSite(String(args.site), { scope: 'store' }) : undefined
      await printSyncStatus({ config: ctx.config, dataDir: ctx.dataDir }, siteUrl, json)
      return
    }

    const ctx = await createCommandContext({ needsAuth: true, needsStore: true })
    const pacer = createRequestPacer({
      maxInFlight: DEFAULT_MAX_IN_FLIGHT,
      perMinute: parseIntegerOption(args['requests-per-minute'], '--requests-per-minute') ?? DEFAULT_REQUESTS_PER_MINUTE,
    })
    const client = pacedClient(ctx.client!, pacer)
    const siteUrl = await ctx.resolveSite(args.site ? String(args.site) : undefined)

    const tables = args.tables
      ? String(args.tables).split(',').map(t => t.trim()).filter(isKnownTable)
      : DEFAULT_TABLES

    const requestedTypes = args.types
      ? String(args.types).split(',').map(t => t.trim()).filter(isKnownSearchType)
      : DEFAULT_TYPES
    if (requestedTypes.length === 0) {
      logger.error(`No valid search types specified. Allowed: ${ALL_SEARCH_TYPES.join(',')}`)
      process.exit(1)
    }

    const store = ctx.store!
    const claim = await recordStoreSite(store.dataDir, siteUrl, { userId: store.userId, write: !args['dry-run'] })
    if (!claim.ok) {
      logger.error(formatSiteIdCollision(claim.error))
      process.exit(1)
    }
    const siteId = store.siteIdFor(siteUrl)
    const scope = { userId: store.userId, siteId }
    const emptyTypesStore = createEmptyTypesStore({ dataSource: store.dataSource })
    let emptyTypesDoc = await emptyTypesStore.load(scope)
    // Older sync runs could mark populated types empty after skipping done dates.
    // Existing rows disprove those markers, including rows in unselected tables.
    if (emptyTypesDoc.emptyTypes.length > 0) {
      const entries = await store.engine.listLive(scope)
      const populated = new Set(entries.filter(entry => entry.rowCount > 0).map(entry => entry.searchType ?? 'web'))
      const toClear = requestedTypes.filter(type => emptyTypesDoc.emptyTypes.includes(type) && populated.has(type))
      if (toClear.length > 0) {
        if (!args['dry-run'])
          emptyTypesDoc = await emptyTypesStore.clear(scope, toClear)
        else
          emptyTypesDoc.emptyTypes = emptyTypesDoc.emptyTypes.filter(type => !toClear.includes(type as SearchType))
      }
    }
    const forceTypes = Boolean(args['force-types'])
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

    const endDate = args.end ? String(args.end) : daysAgo(DEFAULT_PENDING_DAYS)
    let startDate: string
    if (args.start) {
      startDate = String(args.start)
    }
    else if (args.full) {
      startDate = daysAgo(FULL_HISTORY_DAYS)
    }
    else if (days !== undefined) {
      startDate = daysAgo(days + DEFAULT_PENDING_DAYS - 1)
    }
    else {
      startDate = daysAgo(DEFAULT_PENDING_DAYS + DEFAULT_PENDING_DAYS - 1)
    }

    let dates = getDateRange(startDate, endDate)
    if (dates.length === 0) {
      logger.error(`No dates to sync (start=${startDate}, end=${endDate})`)
      process.exit(1)
    }

    const printCompletion = async (status: 'completed' | 'failed' | 'skipped', totals: Record<string, { rows: number, skipped: number, failed: number }>, reason?: string, rollupError?: string, entities?: EntitySyncReport): Promise<void> => {
      if (!json)
        return
      console.log(JSON.stringify({
        status,
        ...(reason ? { reason } : {}),
        siteUrl,
        range: { start: startDate, end: endDate },
        tables,
        types,
        skippedTypes,
        totals,
        watermarks: await store.engine.getWatermarks({ userId: store.userId, siteId }),
        ...(rollupError ? { rollupError } : {}),
        ...(entities ?? {}),
      }, null, 2))
    }
    if (types.length === 0) {
      if (!quiet)
        logger.warn(`All requested types are marked empty. Pass --force-types to check them again.`)
      await printCompletion('skipped', {}, 'empty-types')
      return
    }

    const today = new Date().toISOString().slice(0, 10)
    const { jobs, unsupported } = planSyncJobs(tables, types)
    if (unsupported.length > 0 && !quiet && (args.tables || args.types)) {
      logger.info(`Skipping ${unsupported.map(job => job.label).join(', ')}: Google has no such breakdown for that search type.`)
    }

    // --retry-failed shrinks the date list to exactly the dates currently in
    // `failed` state for the requested (table, type) jobs. Force-mode is
    // implied; the loop will re-run those dates and overwrite their state.
    if (args['retry-failed']) {
      const failedSet = new Set<string>()
      const selectedTables = new Set<TableName>(tables)
      const selectedTypes = new Set<SearchType>(types)
      const states = await store.engine.getSyncStates({ userId: store.userId, siteId })
      for (const s of states) {
        if (selectedTables.has(s.table)
          && selectedTypes.has(s.searchType ?? 'web')
          && s.state === 'failed'
          && s.date >= startDate
          && s.date <= endDate) {
          failedSet.add(s.date)
        }
      }
      dates = dates.filter(d => failedSet.has(d))
      if (dates.length === 0) {
        if (!quiet)
          logger.success('No failed dates in range. Nothing to retry.')
        await printCompletion('skipped', {}, 'no-failed-dates')
        return
      }
      // Force-mode is implied so the syncer overwrites the existing `failed`
      // state instead of skipping it as already-attempted.
      ;(args as Record<string, unknown>).force = true
      if (!quiet)
        logger.info(`--retry-failed: ${dates.length} date(s) to retry`)
    }

    if (args['dry-run']) {
      const plan: Array<{ table: string, searchType: string, date: string }> = []
      for (const job of jobs) {
        for (const date of datesForJob(job.table, dates, today))
          plan.push({ table: job.table, searchType: job.type, date })
      }
      if (json) {
        console.log(JSON.stringify({
          siteUrl,
          range: { start: startDate, end: endDate },
          tables,
          types,
          totalCalls: plan.length,
          plan,
        }, null, 2))
        return
      }
      console.log()
      logger.info(`Plan: ${plan.length} API call(s) for ${siteUrl}`)
      console.log(`  Tables:   ${tables.join(', ')}`)
      console.log(`  Types:    ${types.join(', ')}`)
      console.log(`  Range:    ${startDate} → ${endDate} (${dates.length} days)`)
      console.log()
      logger.info('Pass without --dry-run to execute.')
      return
    }

    if (!quiet) {
      logger.info(`Syncing ${siteUrl} (${tables.join(', ')}) [${types.join(', ')}] → ${displayPath(store.dataDir)}`)
      logger.info(`Range: ${startDate} → ${endDate} (${dates.length} days)`)
    }

    const serialTables = Boolean(args['serial-tables'])

    const start = Date.now()
    const totals: Record<string, { rows: number, skipped: number, failed: number }> = {}
    // Build the (table, searchType) work list. Each pair is an independent
    // sync stream — runs in parallel by default, sequentially with
    // --serial-tables for predictable ordering / debug.
    const progress = createProgressTracker(
      jobs.reduce((sum, job) => sum + datesForJob(job.table, dates, today).length, 0),
      quiet,
    )

    if (serialTables) {
      for (const job of jobs) {
        totals[job.label] = await syncTable(
          store,
          siteUrl,
          job.table,
          job.type,
          datesForJob(job.table, dates, today),
          client,
          concurrency,
          args.force || forceTypes,
          progress,
        )
      }
    }
    else {
      const results = await Promise.all(
        jobs.map(job => syncTable(
          store,
          siteUrl,
          job.table,
          job.type,
          datesForJob(job.table, dates, today),
          client,
          concurrency,
          args.force || forceTypes,
          progress,
        )),
      )
      jobs.forEach((job, i) => {
        totals[job.label] = results[i]
      })
    }
    progress.done()

    const seconds = ((Date.now() - start) / 1000).toFixed(1)
    if (!quiet) {
      logger.success(`Synced ${siteUrl} in ${seconds}s`)
      for (const [t, n] of Object.entries(totals)) {
        const suffix = [
          n.skipped > 0 ? `${n.skipped} skipped` : null,
          n.failed > 0 ? `\x1B[31m${n.failed} failed\x1B[0m` : null,
        ].filter(Boolean).join(', ')
        const tail = suffix ? ` (${suffix})` : ''
        console.log(`  ${t}: ${n.rows.toLocaleString()} rows${tail}`)
      }
      console.log()
    }

    const anyFailed = Object.values(totals).some(t => t.failed > 0)

    // Only fresh, complete probes can establish emptiness. Skipped dates
    // provide no evidence. Existing rows also rule out a site-wide marker.
    const rowsByType = new Map<SearchType, number>()
    const failedByType = new Map<SearchType, number>()
    const skippedByType = new Map<SearchType, number>()
    for (const job of jobs) {
      const t = totals[job.label]
      rowsByType.set(job.type, (rowsByType.get(job.type) ?? 0) + t.rows)
      failedByType.set(job.type, (failedByType.get(job.type) ?? 0) + t.failed)
      skippedByType.set(job.type, (skippedByType.get(job.type) ?? 0) + t.skipped)
    }
    if (!forceTypes && tables.length > 0 && dates.length >= EMPTY_TYPE_PROBE_MIN_DAYS) {
      const toMark: SearchType[] = []
      for (const type of types) {
        if (EMPTY_TYPE_PROTECTED.includes(type))
          continue
        if ((failedByType.get(type) ?? 0) > 0)
          continue
        if ((skippedByType.get(type) ?? 0) > 0 || (rowsByType.get(type) ?? 0) > 0)
          continue
        const entries = await store.engine.listLive({ ...scope, searchType: type })
        if (entries.some(entry => entry.rowCount > 0))
          continue
        toMark.push(type)
      }
      if (toMark.length > 0) {
        await emptyTypesStore.mark({ userId: store.userId, siteId }, toMark)
        if (!quiet)
          logger.info(`Marked empty for future syncs: ${toMark.join(', ')} (0 rows across ${dates.length} days; pass --force-types to re-probe).`)
      }
    }
    // If --force-types surfaced real data for a type we previously marked,
    // drop that marker so subsequent plain syncs pick it up automatically.
    if (forceTypes && emptyTypesDoc.emptyTypes.length > 0) {
      const toClear: SearchType[] = []
      for (const type of types) {
        if (emptyTypesDoc.emptyTypes.includes(type) && (rowsByType.get(type) ?? 0) > 0)
          toClear.push(type)
      }
      if (toClear.length > 0) {
        await emptyTypesStore.clear({ userId: store.userId, siteId }, toClear)
        if (!quiet)
          logger.info(`Cleared empty markers for: ${toClear.join(', ')} (re-probe found data).`)
      }
    }

    // Post-sync rollups: rebuild aggregates so the dashboard's cached widgets
    // reflect the sync we just ran. Skipped on --no-rollups, on zero-row syncs
    // (nothing to aggregate), and on full-failure runs (would read stale data).
    const noRollups = args.rollups === false
    let rollupError: string | undefined
    const anyRowsSynced = Object.values(totals).some(t => t.rows > 0)
    if (!noRollups && anyRowsSynced) {
      if (!quiet)
        logger.info(`Rebuilding rollups for [${siteId}] (${DEFAULT_ROLLUPS.length} rollups)…`)
      const rollupStart = Date.now()
      const results = await rebuildRollups({
        engine: {
          runSQL: opts => store.engine.runSQL(opts),
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
        ctx: { userId: store.userId, siteId },
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
      sitemaps: args.sitemaps !== false,
      inspections: args.inspections !== false,
      inspectLimit,
      quiet,
    })

    await printCompletion(anyFailed || rollupError ? 'failed' : 'completed', totals, undefined, rollupError, entities)
    if (anyFailed || rollupError)
      process.exit(1)
  },
})

type EntityStep<T> = T | { _tag: 'disabled' } | { _tag: 'failed', reason: string }

export interface EntitySyncReport {
  sitemaps: EntityStep<SitemapSyncResult>
  inspections: EntityStep<InspectionSyncResult>
}

function failureReason(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

// Pages with the most impressions come first, so the inspection budget goes
// to the URLs that matter most.
async function topPagePaths(store: LocalStore, siteUrl: string): Promise<string[]> {
  const entries = await store.engine.listLive({ userId: store.userId, siteId: store.siteIdFor(siteUrl), table: 'pages' })
  if (entries.length === 0)
    return []
  const { rows } = await store.runRawSql({
    sql: `SELECT url, SUM(impressions) AS impressions FROM read_parquet({{FILES}}, union_by_name = true) GROUP BY url ORDER BY impressions DESC LIMIT ${INSPECT_PAGE_CANDIDATES}`,
    siteUrl,
    table: 'pages',
  })
  return rows.map(row => String(row.url))
}

/**
 * Save sitemaps and URL Inspection results after the analytics sync. A
 * failure here is logged and reported. It never fails the analytics sync.
 */
async function syncEntities(opts: {
  store: LocalStore
  client: ReturnType<typeof googleSearchConsole>
  siteUrl: string
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
      const sitemapUrls = await loadSitemapGenerationUrls(store.dataSource, ctx)
      const candidates = [
        ...resolvePagePaths(await topPagePaths(store, siteUrl), siteUrl, sitemapUrls),
        ...sitemapUrls,
      ]
      const progress = createProgressTracker(Math.min(opts.inspectLimit, candidates.length), quiet)
      const result = await syncInspections({
        client,
        dataSource: store.dataSource,
        ctx,
        siteUrl,
        candidates,
        limit: opts.inspectLimit,
        concurrency: INSPECT_CONCURRENCY,
        now,
        onProgress: () => progress.tick('inspect'),
      }).finally(() => progress.done())
      return result
    })().catch((error: unknown) => ({ _tag: 'failed' as const, reason: failureReason(error) }))
    if (inspections._tag === 'failed') {
      logger.warn(`URL Inspection not saved: ${inspections.reason}`)
    }
    else if (inspections._tag === 'inspected') {
      if (!quiet)
        logger.success(`Inspected ${inspections.inspected} URL(s); ${inspections.deferred} due URL(s) left for later runs`)
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

// Route every Search Analytics query through the shared pacer. Other calls pass through.
function pacedClient(
  client: ReturnType<typeof googleSearchConsole>,
  pacer: RequestPacer,
): ReturnType<typeof googleSearchConsole> {
  const query = client.searchAnalytics.query
  return {
    ...client,
    searchAnalytics: {
      ...client.searchAnalytics,
      query: (...args: Parameters<typeof query>) => pacer.run(() => query(...args)),
    },
  }
}

function isKnownTable(name: string): name is TableName {
  return (allTables() as readonly string[]).includes(name)
}

function isKnownSearchType(name: string): name is SearchType {
  return (ALL_SEARCH_TYPES as readonly string[]).includes(name)
}

async function printSyncStatus(
  resolved: ResolvedGscdumpConfig,
  siteFilter: string | undefined,
  asJson: boolean,
): Promise<void> {
  const store = createLocalStore({ dataDir: resolved.dataDir })
  const siteId = siteFilter ? store.siteIdFor(siteFilter) : undefined
  const siteMap = await readSiteMap(store.dataDir, store.userId)
  const siteLabel = (id: string | undefined): string => id ? `@${siteUrlForId(siteMap, id)}` : ''

  const watermarks = (await store.engine.getWatermarks({ userId: store.userId, siteId }))
    .map(w => ({ ...w, siteUrl: w.siteId ? siteUrlForId(siteMap, w.siteId) : null }))
  const states = await store.engine.getSyncStates({ userId: store.userId, siteId })
  const failed = states.filter(s => s.state === 'failed')
  const inflight = states.filter(s => s.state === 'inflight')

  if (asJson) {
    console.log(JSON.stringify({
      dataDir: store.dataDir,
      siteFilter: siteFilter ?? null,
      watermarks,
      failed,
      inflight,
    }, null, 2))
    return
  }

  console.log()
  console.log(`  \x1B[1m${displayPath(store.dataDir)}\x1B[0m`)
  if (siteFilter)
    console.log(`  \x1B[90mSite: ${siteFilter}\x1B[0m`)
  console.log()

  if (watermarks.length === 0) {
    console.log(`  No sync watermarks. Run \`gscdump sync\` to ingest data.`)
    console.log()
    return
  }

  console.log(`  \x1B[1mWatermarks:\x1B[0m`)
  const sorted = [...watermarks].sort((a, b) => {
    if (a.table !== b.table)
      return a.table.localeCompare(b.table)
    return (a.siteId ?? '').localeCompare(b.siteId ?? '')
  })
  for (const w of sorted) {
    const scope = `${w.table}${siteLabel(w.siteId)}`
    console.log(`  ${scope.padEnd(28)} \x1B[36m${w.oldestDateSynced}\x1B[0m → \x1B[36m${w.newestDateSynced}\x1B[0m  \x1B[90m(last ${formatAge(w.lastSyncAt)})\x1B[0m`)
  }

  if (inflight.length > 0) {
    console.log()
    console.log(`  \x1B[33m${inflight.length} inflight:\x1B[0m`)
    for (const s of inflight)
      console.log(`    ${s.table}${siteLabel(s.siteId)} ${s.date} (attempt ${s.attempts}, started ${formatAge(s.updatedAt)})`)
  }

  if (failed.length > 0) {
    console.log()
    console.log(`  \x1B[31m${failed.length} failed:\x1B[0m`)
    for (const s of failed)
      console.log(`    ${s.table}${siteLabel(s.siteId)} ${s.date}: ${s.error ?? 'unknown'}`)
    console.log()
    console.log(`  Re-run \`gscdump sync --force\` to retry failed dates.`)
  }

  console.log()
}

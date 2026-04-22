import type { googleSearchConsole } from 'gscdump'
import type { SearchType } from 'gscdump/query'
import type { LocalStore, Row, TableName, WriteCtx } from '../local-store'
import process from 'node:process'
import { createEmptyTypesStore } from '@gscdump/engine/entities'
import { DEFAULT_ROLLUPS, rebuildRollups } from '@gscdump/engine/rollups'
import { defineCommand } from 'citty'
import { SearchTypes } from 'gscdump/query'
import { loadConfig, resolveDataDir } from '../config'
import { createCommandContext } from '../context'
import { allTables, createLocalStore, TABLE_DIMS, transformGscRow } from '../local-store'
import { clearLine, logger, progressBar } from '../utils'

const DEFAULT_TABLES: TableName[] = ['pages', 'keywords', 'countries', 'devices']
const DEFAULT_TYPES: readonly SearchType[] = ['web']
const ALL_SEARCH_TYPES = Object.values(SearchTypes) as readonly SearchType[]
const DEFAULT_PENDING_DAYS = 3
const DEFAULT_CONCURRENCY = 8
const DAY_MS = 86_400_000
// Minimum days synced before we trust a zero-row result enough to persist
// an empty-type marker. Shorter windows fire false positives on intermittent
// outages or low-traffic sites that happen to have zero clicks one day.
const EMPTY_TYPE_PROBE_MIN_DAYS = 7
// `web` is never skipped — it's the default coverage surface and users
// almost always want it even when the detector sees a transient zero week.
const EMPTY_TYPE_PROTECTED: readonly SearchType[] = ['web']

async function runPool<T>(
  items: T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<void>,
): Promise<void> {
  let cursor = 0
  const workers = Array.from({ length: Math.max(1, Math.min(concurrency, items.length)) }, async () => {
    while (true) {
      const i = cursor++
      if (i >= items.length)
        return
      await fn(items[i], i)
    }
  })
  await Promise.all(workers)
}

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

function isoDay(offsetDays: number): string {
  return new Date(Date.now() - offsetDays * DAY_MS).toISOString().split('T')[0]
}

function enumerateDates(start: string, end: string): string[] {
  const out: string[] = []
  const endMs = Date.parse(end)
  let cursor = Date.parse(start)
  while (cursor <= endMs) {
    out.push(new Date(cursor).toISOString().split('T')[0])
    cursor += DAY_MS
  }
  return out
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

  await runPool(dates, concurrency, async (date) => {
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

async function runOneDate(
  store: LocalStore,
  client: ReturnType<typeof googleSearchConsole>,
  siteUrl: string,
  table: TableName,
  searchType: SearchType,
  dims: string[],
  date: string,
): Promise<{ kind: 'ok', rows: number }> {
  const rowLimit = 25000
  const rows: Row[] = []
  let startRow = 0

  while (true) {
    const response = await client._rawQuery(siteUrl, {
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
      const transformed = transformGscRow(table, {
        keys: (apiRow.keys ?? []) as string[],
        clicks: apiRow.clicks ?? 0,
        impressions: apiRow.impressions ?? 0,
        ctr: apiRow.ctr ?? 0,
        position: apiRow.position ?? 0,
      })
      if (transformed)
        rows.push(transformed.row)
    }
    if (batch.length < rowLimit)
      break
    startRow += batch.length
  }

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
  meta: {
    name: 'sync',
    description: 'Sync GSC data to local Parquet store',
  },
  args: {
    'site': {
      type: 'string',
      alias: 's',
      description: 'Site URL',
    },
    'start': {
      type: 'string',
      description: 'Start date (YYYY-MM-DD) for historical sync',
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
    'no-rollups': {
      type: 'boolean',
      default: false,
      description: 'Skip the post-sync rollup rebuild (daily/weekly totals, top-N tables)',
    },
    'full': {
      type: 'boolean',
      description: 'Sync the last 450 days (full GSC history)',
    },
    'quiet': {
      type: 'boolean',
      alias: 'q',
      default: false,
      description: 'Suppress progress output',
    },
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
    'json': {
      type: 'boolean',
      default: false,
      description: 'With --status: emit JSON',
    },
    'concurrency': {
      type: 'string',
      alias: 'c',
      description: `Concurrent in-flight day fetches per table (default: ${DEFAULT_CONCURRENCY})`,
    },
    'serial-tables': {
      type: 'boolean',
      default: false,
      description: 'Run tables sequentially (default: run all tables in parallel)',
    },
  },
  async run({ args }) {
    if (args.status) {
      const config = await loadConfig()
      await printSyncStatus(config, args.site ? String(args.site) : undefined, Boolean(args.json))
      return
    }

    const ctx = await createCommandContext({ needsAuth: true, needsStore: true })
    const client = ctx.client!
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

    const siteId = ctx.store!.siteIdFor(siteUrl)
    const emptyTypesStore = createEmptyTypesStore({ dataSource: ctx.store!.dataSource })
    const emptyTypesDoc = await emptyTypesStore.load({ userId: ctx.store!.userId, siteId })
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
    if (types.length === 0) {
      logger.warn(
        `All requested types (${requestedTypes.join(', ')}) are marked empty for this site. Pass --force-types to re-probe.`,
      )
      return
    }
    if (skippedTypes.length > 0 && !args.quiet) {
      logger.info(
        `Skipping ${skippedTypes.join(', ')} (marked empty for this site; pass --force-types to re-probe).`,
      )
    }

    const endDate = args.end ? String(args.end) : isoDay(DEFAULT_PENDING_DAYS)
    let startDate: string
    if (args.start) {
      startDate = String(args.start)
    }
    else if (args.full) {
      startDate = isoDay(450)
    }
    else if (args.days) {
      startDate = isoDay(Number.parseInt(String(args.days), 10) + DEFAULT_PENDING_DAYS - 1)
    }
    else {
      startDate = isoDay(DEFAULT_PENDING_DAYS + DEFAULT_PENDING_DAYS - 1)
    }

    const dates = enumerateDates(startDate, endDate)
    if (dates.length === 0) {
      logger.error(`No dates to sync (start=${startDate}, end=${endDate})`)
      process.exit(1)
    }

    const store = ctx.store!
    if (!args.quiet) {
      logger.info(`Syncing ${siteUrl} (${tables.join(', ')}) [${types.join(', ')}] → ${store.dataDir}`)
      logger.info(`Range: ${startDate} → ${endDate} (${dates.length} days)`)
    }

    const concurrency = args.concurrency
      ? Math.max(1, Number.parseInt(String(args.concurrency), 10) || DEFAULT_CONCURRENCY)
      : DEFAULT_CONCURRENCY
    const serialTables = Boolean(args['serial-tables'])

    const start = Date.now()
    const totals: Record<string, { rows: number, skipped: number, failed: number }> = {}
    // Build the (table, searchType) work list. Each pair is an independent
    // sync stream — runs in parallel by default, sequentially with
    // --serial-tables for predictable ordering / debug.
    const jobs: Array<{ table: TableName, type: SearchType, label: string }> = []
    for (const table of tables) {
      for (const type of types) {
        const label = type === 'web' ? table : `${table}/${type}`
        jobs.push({ table, type, label })
      }
    }
    const progress = createProgressTracker(dates.length * jobs.length, Boolean(args.quiet))

    if (serialTables) {
      for (const job of jobs) {
        totals[job.label] = await syncTable(
          store,
          siteUrl,
          job.table,
          job.type,
          dates,
          client,
          concurrency,
          args.force,
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
          dates,
          client,
          concurrency,
          args.force,
          progress,
        )),
      )
      jobs.forEach((job, i) => {
        totals[job.label] = results[i]
      })
    }
    progress.done()

    const seconds = ((Date.now() - start) / 1000).toFixed(1)
    if (!args.quiet) {
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

    // Empty-type detection: a type whose full sync window yielded zero rows
    // (across every table, every date) almost certainly has no coverage for
    // this site. Persist a marker so future syncs skip it until --force-types
    // is passed. Requires a wide-enough window (`EMPTY_TYPE_PROBE_MIN_DAYS`)
    // to avoid false positives on outages / low-traffic sites.
    const rowsByType = new Map<SearchType, number>()
    const failedByType = new Map<SearchType, number>()
    for (const job of jobs) {
      const t = totals[job.label]
      rowsByType.set(job.type, (rowsByType.get(job.type) ?? 0) + t.rows)
      failedByType.set(job.type, (failedByType.get(job.type) ?? 0) + t.failed)
    }
    if (!forceTypes && dates.length >= EMPTY_TYPE_PROBE_MIN_DAYS) {
      const toMark: SearchType[] = []
      for (const type of types) {
        if (EMPTY_TYPE_PROTECTED.includes(type))
          continue
        if ((failedByType.get(type) ?? 0) > 0)
          continue
        if ((rowsByType.get(type) ?? 0) === 0)
          toMark.push(type)
      }
      if (toMark.length > 0) {
        await emptyTypesStore.mark({ userId: store.userId, siteId }, toMark)
        if (!args.quiet)
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
        if (!args.quiet)
          logger.info(`Cleared empty markers for: ${toClear.join(', ')} (re-probe found data).`)
      }
    }

    // Post-sync rollups: rebuild aggregates so the dashboard's cached widgets
    // reflect the sync we just ran. Skipped on --no-rollups, on zero-row syncs
    // (nothing to aggregate), and on full-failure runs (would read stale data).
    const noRollups = Boolean(args['no-rollups'])
    const anyRowsSynced = Object.values(totals).some(t => t.rows > 0)
    if (!noRollups && anyRowsSynced) {
      if (!args.quiet)
        logger.info(`Rebuilding rollups for [${siteId}] (${DEFAULT_ROLLUPS.length} rollups)…`)
      const rollupStart = Date.now()
      const results = await rebuildRollups({
        engine: store.engine,
        dataSource: store.dataSource,
        ctx: { userId: store.userId, siteId },
        defs: DEFAULT_ROLLUPS,
      }).catch((err: Error) => {
        logger.warn(`Rollup rebuild failed: ${err.message}`)
        return [] as Awaited<ReturnType<typeof rebuildRollups>>
      })
      if (!args.quiet && results.length > 0) {
        const kb = results.reduce((a, r) => a + r.bytes, 0) / 1024
        const ms = Date.now() - rollupStart
        logger.success(`Rebuilt ${results.length} rollup(s) in ${ms}ms — ${kb.toFixed(1)} KB`)
      }
    }

    if (anyFailed)
      process.exit(1)
  },
})

function isKnownTable(name: string): name is TableName {
  return (allTables() as readonly string[]).includes(name)
}

function isKnownSearchType(name: string): name is SearchType {
  return (ALL_SEARCH_TYPES as readonly string[]).includes(name)
}

async function printSyncStatus(
  config: Awaited<ReturnType<typeof loadConfig>>,
  siteFilter: string | undefined,
  asJson: boolean,
): Promise<void> {
  const store = createLocalStore({ dataDir: resolveDataDir(config) })
  const siteId = siteFilter ? store.siteIdFor(siteFilter) : undefined

  const watermarks = await store.engine.getWatermarks({ userId: store.userId, siteId })
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
  console.log(`  \x1B[1m${store.dataDir}\x1B[0m`)
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
    const scope = w.siteId ? `${w.table}@${w.siteId}` : w.table
    console.log(`  ${scope.padEnd(28)} \x1B[36m${w.oldestDateSynced}\x1B[0m → \x1B[36m${w.newestDateSynced}\x1B[0m  \x1B[90m(last ${formatAge(w.lastSyncAt)})\x1B[0m`)
  }

  if (inflight.length > 0) {
    console.log()
    console.log(`  \x1B[33m${inflight.length} inflight:\x1B[0m`)
    for (const s of inflight)
      console.log(`    ${s.table}${s.siteId ? `@${s.siteId}` : ''} ${s.date} (attempt ${s.attempts}, started ${formatAge(s.updatedAt)})`)
  }

  if (failed.length > 0) {
    console.log()
    console.log(`  \x1B[31m${failed.length} failed:\x1B[0m`)
    for (const s of failed)
      console.log(`    ${s.table}${s.siteId ? `@${s.siteId}` : ''} ${s.date}: ${s.error ?? 'unknown'}`)
    console.log()
    console.log(`  Re-run \`gscdump sync --force\` to retry failed dates.`)
  }

  console.log()
}

function formatAge(ms: number): string {
  const delta = Date.now() - ms
  if (delta < 60_000)
    return 'just now'
  if (delta < 3_600_000)
    return `${Math.floor(delta / 60_000)}m ago`
  if (delta < 86_400_000)
    return `${Math.floor(delta / 3_600_000)}h ago`
  return `${Math.floor(delta / 86_400_000)}d ago`
}

import type { googleSearchConsole } from 'gscdump'
import type { LocalStore, Row, TableName, WriteCtx } from '../local-store'
import process from 'node:process'
import { defineCommand } from 'citty'
import { loadConfig, resolveDataDir } from '../config'
import { createCommandContext } from '../context'
import { allTables, createLocalStore, TABLE_DIMS, transformGscRow } from '../local-store'
import { clearLine, logger, progressBar } from '../utils'

const DEFAULT_TABLES: TableName[] = ['pages', 'keywords', 'countries', 'devices']
const DEFAULT_PENDING_DAYS = 3
const DEFAULT_CONCURRENCY = 8
const DAY_MS = 86_400_000

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
  })
  const stateByDate = new Map(priorStates.map(s => [s.date, s]))

  await runPool(dates, concurrency, async (date) => {
    const prior = stateByDate.get(date)
    if (!force && prior?.state === 'done') {
      skipped++
      progress.tick(`${table} ${date} (skip)`)
      return
    }

    const scope = { userId: store.userId, siteId, table, date }
    await store.engine.setSyncState(scope, 'inflight')

    const result = await runOneDate(store, client, siteUrl, table, dims, date)
      .catch((err: Error) => ({ kind: 'error' as const, error: err }))

    if (result.kind === 'error') {
      await store.engine.setSyncState(scope, 'failed', { error: result.error.message })
      failed++
      progress.tick(`${table} ${date} (fail)`)
      return
    }

    await store.engine.setSyncState(scope, 'done')
    totalRows += result.rows
    progress.tick(`${table} ${date}`)
  })

  return { rows: totalRows, skipped, failed }
}

async function runOneDate(
  store: LocalStore,
  client: ReturnType<typeof googleSearchConsole>,
  siteUrl: string,
  table: TableName,
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
      logger.info(`Syncing ${siteUrl} (${tables.join(', ')}) → ${store.dataDir}`)
      logger.info(`Range: ${startDate} → ${endDate} (${dates.length} days)`)
    }

    const concurrency = args.concurrency
      ? Math.max(1, Number.parseInt(String(args.concurrency), 10) || DEFAULT_CONCURRENCY)
      : DEFAULT_CONCURRENCY
    const serialTables = Boolean(args['serial-tables'])

    const start = Date.now()
    const totals: Record<string, { rows: number, skipped: number, failed: number }> = {}
    const progress = createProgressTracker(dates.length * tables.length, Boolean(args.quiet))

    if (serialTables) {
      for (const table of tables) {
        totals[table] = await syncTable(store, siteUrl, table, dates, client, concurrency, args.force, progress)
      }
    }
    else {
      const results = await Promise.all(
        tables.map(table => syncTable(store, siteUrl, table, dates, client, concurrency, args.force, progress)),
      )
      tables.forEach((table, i) => {
        totals[table] = results[i]
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
    if (anyFailed)
      process.exit(1)
  },
})

function isKnownTable(name: string): name is TableName {
  return (allTables() as readonly string[]).includes(name)
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

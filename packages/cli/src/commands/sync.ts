import type { Row, TableName, WriteCtx } from 'gscdump/analytics'
import type { DriverQueryRow, DriverSite } from 'gscdump/driver'
import type { AnalyticsHarness } from '../analytics'
import process from 'node:process'
import { cancel, isCancel, select } from '@clack/prompts'
import { defineCommand } from 'citty'
import { allTables, normalizeUrl } from 'gscdump/analytics'
import { isCloudDriver } from 'gscdump/driver'
import { createAnalyticsHarness } from '../analytics'
import { getAuth } from '../auth'
import { loadConfig } from '../config'
import { getDriver } from '../driver'

import { clearLine, logger, progressBar } from '../utils'

const TABLE_DIMS: Record<TableName, string[]> = {
  pages: ['page', 'date'],
  keywords: ['query', 'date'],
  countries: ['country', 'date'],
  devices: ['device', 'date'],
  page_keywords: ['page', 'query', 'date'],
}

const DEFAULT_TABLES: TableName[] = ['pages', 'keywords', 'countries', 'devices']
const DEFAULT_PENDING_DAYS = 3
const DAY_MS = 86_400_000

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

function toRow(table: TableName, raw: DriverQueryRow): Row {
  const impressions = Number(raw.impressions ?? 0)
  const position = Number(raw.position ?? 0)
  const sumPosition = position > 0 ? (position - 1) * impressions : 0
  const base: Row = {
    date: String(raw.date ?? ''),
    clicks: Number(raw.clicks ?? 0),
    impressions,
    sum_position: sumPosition,
  }
  switch (table) {
    case 'pages':
      base.url = normalizeUrl(String(raw.page ?? ''))
      return base
    case 'keywords':
      base.query = String(raw.query ?? '')
      return base
    case 'countries':
      base.country = String(raw.country ?? '')
      return base
    case 'devices':
      base.device = String(raw.device ?? '')
      return base
    case 'page_keywords':
      base.url = normalizeUrl(String(raw.page ?? ''))
      base.query = String(raw.query ?? '')
      return base
  }
}

async function resolveSiteUrl(sites: DriverSite[], target?: string): Promise<string> {
  if (target) {
    const match = sites.find(s => s.siteUrl === target || s.siteUrl.includes(target))
    if (match)
      return match.siteUrl
  }
  if (sites.length === 1)
    return sites[0].siteUrl

  const selected = await select({
    message: 'Select a site',
    options: sites.map(s => ({ value: s.siteUrl, label: s.siteUrl })),
  })
  if (isCancel(selected)) {
    cancel('Cancelled')
    process.exit(0)
  }
  return selected as string
}

async function syncTable(
  harness: AnalyticsHarness,
  siteUrl: string,
  table: TableName,
  dates: string[],
  driver: Awaited<ReturnType<typeof getDriver>>,
  quiet: boolean,
): Promise<{ rows: number }> {
  const dims = TABLE_DIMS[table]
  let totalRows = 0

  for (let i = 0; i < dates.length; i++) {
    const date = dates[i]
    if (!quiet) {
      clearLine()
      process.stdout.write(progressBar(i + 1, dates.length, `${table} ${date}`))
    }

    const result = await driver.query(siteUrl, {
      startDate: date,
      endDate: date,
      dimensions: dims,
      rowLimit: 25000,
    })

    const rows = result.rows.map(r => toRow(table, r))
    const writeCtx: WriteCtx = {
      userId: harness.userId,
      siteId: harness.siteIdFor(siteUrl),
      table,
      date,
    }
    await harness.engine.writeDay(writeCtx, rows)
    totalRows += rows.length
  }

  if (!quiet)
    clearLine()

  return { rows: totalRows }
}

const statusCommand = defineCommand({
  meta: {
    name: 'status',
    description: 'Check sync status for a site (cloud mode)',
  },
  args: {
    site: {
      type: 'string',
      alias: 's',
      description: 'Site URL',
    },
    json: {
      type: 'boolean',
      default: false,
      description: 'Output as JSON',
    },
  },
  async run({ args }) {
    const driver = await getDriver({ interactive: false })
    if (!isCloudDriver(driver)) {
      logger.error('sync status is only available in cloud mode')
      process.exit(1)
    }
    const config = await loadConfig()
    const sites = await driver.sitesWithSync().catch((e: Error) => {
      logger.error(`Failed to fetch sites: ${e.message}`)
      process.exit(1)
    })
    if (sites.length === 0) {
      logger.error('No registered sites. Run gscdump register first.')
      process.exit(1)
    }
    const target = args.site || config.defaultSite
    const match = target ? sites.find(s => s.siteUrl === target || s.siteUrl.includes(target)) : undefined
    const siteUrl = match?.siteUrl ?? (sites.length === 1 ? sites[0].siteUrl : await resolveSiteUrl(sites, target))

    const status = await driver.syncStatus(siteUrl).catch((e: Error) => {
      logger.error(`Failed to fetch sync status: ${e.message}`)
      process.exit(1)
    })

    if (args.json) {
      console.log(JSON.stringify(status, null, 2))
      return
    }

    console.log()
    console.log(`  \x1B[1m${status.siteUrl}\x1B[0m`)
    console.log()

    const statusColor = status.syncStatus === 'synced'
      ? '\x1B[32m'
      : status.isSyncing
        ? '\x1B[33m'
        : status.syncStatus === 'error'
          ? '\x1B[31m'
          : '\x1B[90m'
    console.log(`  Status:   ${statusColor}${status.syncStatus}\x1B[0m`)
    console.log(`  Progress: ${progressBar(status.progress, 100, `${status.progress}%`)}`)
    console.log(`  Days:     \x1B[36m${status.daysSynced}\x1B[0m / ${status.daysAvailable} synced`)

    if (status.oldestDateSynced)
      console.log(`  Range:    ${status.oldestDateSynced} \x1B[90m→\x1B[0m ${status.newestDateSynced}`)

    console.log()
    console.log('  \x1B[1mJobs\x1B[0m')
    console.log(`  Queued:     ${status.jobs.queued}`)
    console.log(`  Processing: ${status.jobs.processing}`)
    console.log(`  Completed:  \x1B[32m${status.jobs.completed}\x1B[0m`)
    if (status.jobs.failed > 0)
      console.log(`  Failed:     \x1B[31m${status.jobs.failed}\x1B[0m`)

    const tableNames = Object.keys(status.tables)
    if (tableNames.length > 0) {
      console.log()
      console.log('  \x1B[1mTables\x1B[0m')
      for (const name of tableNames) {
        const t = status.tables[name]
        const rows = t.totalRows > 0 ? ` (${t.totalRows.toLocaleString()} rows)` : ''
        console.log(`  ${name}: \x1B[32m${t.completed}\x1B[0m done, ${t.queued} queued${t.failed > 0 ? `, \x1B[31m${t.failed} failed\x1B[0m` : ''}${rows}`)
      }
    }

    if (status.failedJobs.length > 0) {
      console.log()
      console.log('  \x1B[31mFailed Jobs\x1B[0m')
      for (const j of status.failedJobs.slice(0, 5))
        console.log(`  ${j.date} ${j.tableName}: ${j.error}`)
      if (status.failedJobs.length > 5)
        console.log(`  \x1B[90m... and ${status.failedJobs.length - 5} more\x1B[0m`)
    }

    console.log()
  },
})

const triggerCommand = defineCommand({
  meta: {
    name: 'trigger',
    description: 'Trigger a fresh sync for a site (cloud mode)',
  },
  args: {
    site: {
      type: 'string',
      alias: 's',
      description: 'Site URL',
    },
  },
  async run({ args }) {
    const driver = await getDriver({ interactive: false })
    if (!isCloudDriver(driver)) {
      logger.error('sync trigger is only available in cloud mode')
      process.exit(1)
    }
    const config = await loadConfig()
    const sites = await driver.sitesWithSync().catch((e: Error) => {
      logger.error(`Failed to fetch sites: ${e.message}`)
      process.exit(1)
    })
    if (sites.length === 0) {
      logger.error('No registered sites. Run gscdump register first.')
      process.exit(1)
    }
    const target = args.site || config.defaultSite
    const match = target ? sites.find(s => s.siteUrl === target || s.siteUrl.includes(target)) : undefined
    const siteUrl = match?.siteUrl ?? (sites.length === 1 ? sites[0].siteUrl : await resolveSiteUrl(sites, target))

    const result = await driver.triggerSync(siteUrl).catch((e: Error) => {
      logger.error(`Failed to trigger sync: ${e.message}`)
      process.exit(1)
    })

    logger.success(`Sync triggered for ${siteUrl}`)
    console.log(`  ${result.message}`)
    console.log()
  },
})

export const syncCommand = defineCommand({
  meta: {
    name: 'sync',
    description: 'Sync GSC data to local Parquet store (local mode) or manage cloud sync',
  },
  args: {
    site: {
      type: 'string',
      alias: 's',
      description: 'Site URL',
    },
    start: {
      type: 'string',
      description: 'Start date (YYYY-MM-DD) for historical sync',
    },
    end: {
      type: 'string',
      description: 'End date (YYYY-MM-DD); defaults to 3 days ago',
    },
    days: {
      type: 'string',
      description: `Number of days back to sync (default: ${DEFAULT_PENDING_DAYS})`,
    },
    tables: {
      type: 'string',
      alias: 't',
      description: `Tables to sync (default: ${DEFAULT_TABLES.join(',')}); comma-separated`,
    },
    full: {
      type: 'boolean',
      description: 'Sync the last 450 days (full GSC history)',
    },
    quiet: {
      type: 'boolean',
      alias: 'q',
      default: false,
      description: 'Suppress progress output',
    },
  },
  subCommands: {
    status: statusCommand,
    trigger: triggerCommand,
  },
  async run({ args }) {
    const config = await loadConfig()
    if (config.mode === 'cloud') {
      logger.error('Local Parquet sync is only available in local mode. Use `gscdump sync status` or `gscdump sync trigger` for cloud sync.')
      process.exit(1)
    }

    const auth = await getAuth({ interactive: false, config })
    const driver = await getDriver({ interactive: false })
    void auth

    const sites = await driver.sites().catch((e: Error) => {
      logger.error(`Failed to fetch sites: ${e.message}`)
      process.exit(1)
    })
    if (sites.length === 0) {
      logger.error('No GSC sites available.')
      process.exit(1)
    }

    const siteUrl = await resolveSiteUrl(sites, args.site || config.defaultSite)

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

    const harness = createAnalyticsHarness(config)
    if (!args.quiet) {
      logger.info(`Syncing ${siteUrl} (${tables.join(', ')}) → ${harness.dataDir}`)
      logger.info(`Range: ${startDate} → ${endDate} (${dates.length} days)`)
    }

    const start = Date.now()
    const totals: Record<string, number> = {}
    for (const table of tables) {
      const { rows } = await syncTable(harness, siteUrl, table, dates, driver, args.quiet)
      totals[table] = rows
    }

    const seconds = ((Date.now() - start) / 1000).toFixed(1)
    if (!args.quiet) {
      logger.success(`Synced ${siteUrl} in ${seconds}s`)
      for (const [t, n] of Object.entries(totals))
        console.log(`  ${t}: ${n.toLocaleString()} rows`)
      console.log()
    }
  },
})

function isKnownTable(name: string): name is TableName {
  return (allTables() as readonly string[]).includes(name)
}

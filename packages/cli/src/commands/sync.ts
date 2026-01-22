import type { SyncTable } from '@gscdump/db'
import type { GoogleSearchConsoleClient } from 'gscdump'
import path from 'node:path'
import process from 'node:process'
import {
  createGscDb,
  getLastSyncedDate,
  getSiteByProperty,
  setupSchema,
  syncSites,
  syncTables,
} from '@gscdump/db'
import { defineCommand } from 'citty'
import dayjs from 'dayjs'
import betterSqlite3 from 'db0/connectors/better-sqlite3'
import { between, date, daysAgo, googleSearchConsole, gsc } from 'gscdump'
import { loadConfig } from '../config'
import { clearLine, gscErrorHandler, logger, progressBar } from '../utils'

function parsePeriodDays(period: string): number {
  if (period === 'max')
    return 480 // ~16 months GSC history
  if (period.endsWith('y'))
    return Number.parseInt(period) * 365
  if (period.endsWith('m') || period.endsWith('mo'))
    return Number.parseInt(period) * 30
  return Number.parseInt(period.replace('d', ''))
}

interface SyncReport {
  database: string
  period: { start: string, end: string }
  sites: Array<{
    site: string
    rows: { pages?: number, keywords?: number, keywordPaths?: number, countries?: number, devices?: number, total: number }
  }>
  totalRows: number
}

interface SyncOptions {
  quiet: boolean
  json: boolean
}

interface ExtendedSyncOptions extends SyncOptions {
  fresh?: boolean
  incremental?: boolean
  since?: string
}

async function runSync(
  client: GoogleSearchConsoleClient,
  dbPath: string,
  siteArg: string | null,
  period: string,
  granular: boolean,
  options: ExtendedSyncOptions,
): Promise<SyncReport> {
  const resolvedPath = path.resolve(dbPath)
  const report: SyncReport = {
    database: resolvedPath,
    period: { start: '', end: '' },
    sites: [],
    totalRows: 0,
  }

  if (!options.quiet && !options.json)
    logger.info(`Database: ${resolvedPath}`)

  const { db, db0 } = createGscDb(betterSqlite3({ name: resolvedPath }))
  await setupSchema(db0)

  if (!options.quiet && !options.json)
    logger.start('Syncing sites...')
  const syncedSites = await syncSites(db, client)
  if (!options.quiet && !options.json)
    logger.success(`Synced ${syncedSites.length} sites`)

  let sitesToSync: { siteId: number, siteUrl: string }[] = []

  if (siteArg) {
    const siteRecord = await getSiteByProperty(db, siteArg)
    if (!siteRecord) {
      if (options.json) {
        console.log(JSON.stringify({ error: `Site not found: ${siteArg}` }))
      }
      else {
        logger.error(`Site not found: ${siteArg}`)
        logger.info('Available sites:')
        syncedSites.slice(0, 5).forEach(s => console.log(`    - ${s.property}`))
      }
      process.exit(1)
    }
    sitesToSync = [{
      // @ts-expect-error db0 returns raw column names
      siteId: siteRecord.site_id || siteRecord.siteId,
      siteUrl: siteRecord.property,
    }]
  }
  else {
    sitesToSync = syncedSites.map(s => ({
      siteId: s.siteId as number,
      siteUrl: s.property,
    }))
  }

  const periodDays = parsePeriodDays(period)

  // By default, exclude fresh/unfinalized data (last 3 days)
  // With --fresh, include up to yesterday (today has no data yet)
  const daysOffset = options.fresh ? 1 : 3
  const adjustedEndDate = daysAgo(daysOffset)
  const baseStartDate = daysAgo(periodDays + daysOffset)

  // Helper to create builder for a site (may vary with incremental sync)
  const getBuilderForSite = async (siteId: number): Promise<{ builder: ReturnType<typeof gsc.where>, startDate: string, skipped: boolean }> => {
    let startDate = baseStartDate

    // --since takes precedence
    if (options.since) {
      startDate = options.since
    }
    // --incremental uses lastSynced date
    else if (options.incremental) {
      const lastSynced = await getLastSyncedDate(db, siteId)
      if (lastSynced) {
        // Start from day after last sync
        const incrementalStart = dayjs(lastSynced).add(1, 'day').format('YYYY-MM-DD')
        // Use later of incremental start or base start
        startDate = incrementalStart > baseStartDate ? incrementalStart : baseStartDate
      }
    }

    // Skip if start date is after end date (already up to date)
    if (startDate > adjustedEndDate) {
      return {
        builder: gsc.where(between(date, startDate, adjustedEndDate)),
        startDate,
        skipped: true,
      }
    }

    return {
      builder: gsc.where(between(date, startDate, adjustedEndDate)),
      startDate,
      skipped: false,
    }
  }

  // For report, use base dates (individual sites may vary)
  report.period = { start: options.since || baseStartDate, end: adjustedEndDate }

  if (!options.quiet && !options.json) {
    const modeNote = options.incremental ? ' (incremental)' : options.since ? ` (since ${options.since})` : options.fresh ? ' (fresh)' : ''
    logger.info(`Period: ${options.since || baseStartDate} to ${adjustedEndDate}${modeNote}`)
    console.log()
  }

  const tables: SyncTable[] = granular
    ? ['dates', 'pages', 'keywords', 'keywordPaths', 'countries', 'devices', 'searchAppearances']
    : ['dates', 'pages', 'keywords', 'countries', 'devices']

  for (const { siteId, siteUrl } of sitesToSync) {
    const siteName = siteUrl.replace(/^(sc-domain:|https?:\/\/)/, '')
    const { builder, startDate, skipped } = await getBuilderForSite(siteId)

    // Skip if already up to date (incremental mode)
    if (skipped) {
      if (!options.quiet && !options.json)
        logger.info(`${siteName} is up to date (last synced: ${startDate})`)
      continue
    }

    if (!options.quiet && !options.json && (options.incremental || options.since))
      logger.info(`${siteName}: syncing ${startDate} to ${adjustedEndDate}`)

    let currentTableIndex = 0
    const result = await syncTables(db, client, siteId, siteUrl, tables, {
      builder,
      onBatch: (table) => {
        if (!options.quiet && !options.json) {
          const tableIndex = tables.indexOf(table)
          if (tableIndex !== currentTableIndex) {
            currentTableIndex = tableIndex
            clearLine()
            process.stdout.write(progressBar(tableIndex + 1, tables.length, `${table} (${siteName})`))
          }
        }
      },
    })

    if (!options.quiet && !options.json)
      clearLine()

    const siteReport: SyncReport['sites'][0] = {
      site: siteUrl,
      rows: { ...result },
    }

    report.sites.push(siteReport)
    report.totalRows += result.total

    if (!options.quiet && !options.json)
      logger.success(`Synced ${siteName} (${result.total.toLocaleString()} rows)`)
  }

  if (!options.quiet && !options.json) {
    console.log()
    logger.success(`Database saved to ${resolvedPath}`)
  }

  return report
}

export const syncCommand = defineCommand({
  meta: {
    name: 'sync',
    description: 'Sync GSC data to SQLite database',
  },
  args: {
    db: {
      type: 'string',
      alias: 'd',
      default: './gscdump.db',
      description: 'SQLite database path',
    },
    site: {
      type: 'string',
      alias: 's',
      description: 'Site URL (e.g., sc-domain:example.com)',
    },
    period: {
      type: 'string',
      alias: 'p',
      default: '90d',
      description: 'Time period: 90d, 6m, 1y, max (all GSC history ~16mo)',
    },
    granular: {
      type: 'boolean',
      alias: 'g',
      default: false,
      description: 'Include keyword-per-page data (large dataset)',
    },
    quiet: {
      type: 'boolean',
      alias: 'q',
      default: false,
      description: 'Suppress output',
    },
    json: {
      type: 'boolean',
      default: false,
      description: 'Output sync report as JSON',
    },
    fresh: {
      type: 'boolean',
      default: false,
      description: 'Include fresh/unfinalized data (last 3 days)',
    },
    incremental: {
      type: 'boolean',
      alias: 'i',
      default: false,
      description: 'Only fetch data since last sync',
    },
    since: {
      type: 'string',
      description: 'Fetch data from specific date (YYYY-MM-DD)',
    },
  },
  async run({ args }) {
    const config = await loadConfig()

    // Apply config defaults
    const dbPath = args.db === './gscdump.db' && config.defaultDb ? config.defaultDb : args.db
    const siteArg = args.site || config.defaultSite || null
    const periodArg = args.period === '90d' && config.defaultPeriod ? config.defaultPeriod : args.period

    const { getAuth } = await import('../auth')
    const auth = await getAuth({ interactive: false, config })
    const client = googleSearchConsole(auth)

    const report = await runSync(client, dbPath, siteArg, periodArg, args.granular, {
      quiet: args.quiet,
      json: args.json,
      fresh: args.fresh,
      incremental: args.incremental,
      since: args.since,
    }).catch(gscErrorHandler)

    if (args.json) {
      console.log(JSON.stringify(report, null, 2))
    }
    else if (!args.quiet) {
      logger.success('Done!')
    }
  },
})

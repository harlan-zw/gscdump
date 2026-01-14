import type { OAuth2Client } from 'google-auth-library'
import type { ResolvedAnalyticsRange } from 'gscdump'
import path from 'node:path'
import process from 'node:process'
import {
  createGscDb,
  getSiteByProperty,
  setupSchema,
  syncCountries,
  syncDevices,
  syncKeywordPaths,
  syncKeywords,
  syncPages,
  syncSites,
  updateLastSynced,
} from '@gscdump/db'
import { defineCommand } from 'citty'
import betterSqlite3 from 'db0/connectors/better-sqlite3'
import { userPeriodRange } from 'gscdump'
import { loadConfig } from '../config'
import { clearLine, gscErrorHandler, logger, progressBar } from '../utils'

interface SyncReport {
  database: string
  period: { start: string, end: string }
  sites: Array<{
    site: string
    rows: { pages: number, keywords: number, keywordPaths?: number, countries: number, devices: number, total: number }
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
  auth: OAuth2Client,
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
  const syncedSites = await syncSites(db, auth)
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
      siteId: s.siteId,
      siteUrl: s.property,
    }))
  }

  const periodRange = userPeriodRange(period)

  // By default, exclude fresh/unfinalized data (last 3 days)
  // With --fresh, include up to yesterday (today has no data yet)
  const { default: dayjs } = await import('dayjs')
  const daysOffset = options.fresh ? 1 : 3
  const adjustedEndDate = dayjs(periodRange.period.endDate).subtract(daysOffset, 'day').format('YYYY-MM-DD')
  const baseStartDate = dayjs(periodRange.period.startDate).subtract(daysOffset, 'day').format('YYYY-MM-DD')
  const adjustedPrevEndDate = dayjs(periodRange.prevPeriod.endDate).subtract(daysOffset, 'day').format('YYYY-MM-DD')
  const adjustedPrevStartDate = dayjs(periodRange.prevPeriod.startDate).subtract(daysOffset, 'day').format('YYYY-MM-DD')

  // Helper to create range for a site (may vary with incremental sync)
  const { getLastSyncedDate } = await import('@gscdump/db')

  const getRangeForSite = async (siteId: number): Promise<{ range: ResolvedAnalyticsRange, startDate: string, skipped: boolean }> => {
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
        range: { period: { start: startDate, end: adjustedEndDate }, prevPeriod: { start: adjustedPrevStartDate, end: adjustedPrevEndDate } },
        startDate,
        skipped: true,
      }
    }

    return {
      range: {
        period: { start: startDate, end: adjustedEndDate },
        prevPeriod: { start: adjustedPrevStartDate, end: adjustedPrevEndDate },
      },
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

  const dataTypes = granular
    ? ['pages', 'keywords', 'keyword-paths', 'countries', 'devices'] as const
    : ['pages', 'keywords', 'countries', 'devices'] as const

  for (const { siteId, siteUrl } of sitesToSync) {
    const siteName = siteUrl.replace(/^(sc-domain:|https?:\/\/)/, '')
    const { range, startDate, skipped } = await getRangeForSite(siteId)

    // Skip if already up to date (incremental mode)
    if (skipped) {
      if (!options.quiet && !options.json)
        logger.info(`${siteName} is up to date (last synced: ${startDate})`)
      continue
    }

    const siteReport: SyncReport['sites'][0] = {
      site: siteUrl,
      rows: { pages: 0, keywords: 0, countries: 0, devices: 0, total: 0 },
    }

    if (!options.quiet && !options.json && (options.incremental || options.since))
      logger.info(`${siteName}: syncing ${startDate} to ${adjustedEndDate}`)

    for (let i = 0; i < dataTypes.length; i++) {
      const dataType = dataTypes[i]

      if (!options.quiet && !options.json) {
        clearLine()
        process.stdout.write(progressBar(i + 1, dataTypes.length, `${dataType} (${siteName})`))
      }

      let rows: any[] = []
      if (dataType === 'pages') {
        rows = await syncPages(db, auth, siteId, siteUrl, range)
        siteReport.rows.pages = rows.length
      }
      else if (dataType === 'keywords') {
        rows = await syncKeywords(db, auth, siteId, siteUrl, range)
        siteReport.rows.keywords = rows.length
      }
      else if (dataType === 'keyword-paths') {
        rows = await syncKeywordPaths(db, auth, siteId, siteUrl, range)
        siteReport.rows.keywordPaths = rows.length
      }
      else if (dataType === 'countries') {
        rows = await syncCountries(db, auth, siteId, siteUrl, range)
        siteReport.rows.countries = rows.length
      }
      else if (dataType === 'devices') {
        rows = await syncDevices(db, auth, siteId, siteUrl, range)
        siteReport.rows.devices = rows.length
      }

      siteReport.rows.total += rows.length
    }

    if (!options.quiet && !options.json)
      clearLine()

    await updateLastSynced(db, siteId)
    report.sites.push(siteReport)
    report.totalRows += siteReport.rows.total

    if (!options.quiet && !options.json)
      logger.success(`Synced ${siteName} (${siteReport.rows.total.toLocaleString()} rows)`)
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

    const report = await runSync(auth, dbPath, siteArg, periodArg, args.granular, {
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

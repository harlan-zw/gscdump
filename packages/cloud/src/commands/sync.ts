import type { CloudGscDriver, DriverSiteWithSync } from '../types'
import process from 'node:process'
import { cancel, isCancel, select } from '@clack/prompts'
import { defineCommand } from 'citty'
import { getDriver } from '../session'
import { logger, progressBar } from '../utils'

async function resolveSiteUrl(sites: DriverSiteWithSync[], target?: string): Promise<string> {
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

async function loadSites(driver: CloudGscDriver): Promise<DriverSiteWithSync[]> {
  const sites = await driver.sitesWithSync().catch((e: Error) => {
    logger.error(`Failed to fetch sites: ${e.message}`)
    process.exit(1)
  })
  if (sites.length === 0) {
    logger.error('No registered sites. Run gscdump-cloud register first.')
    process.exit(1)
  }
  return sites
}

const statusCommand = defineCommand({
  meta: {
    name: 'status',
    description: 'Check sync status for a site',
  },
  args: {
    site: { type: 'string', alias: 's', description: 'Site URL' },
    json: { type: 'boolean', default: false, description: 'Output as JSON' },
  },
  async run({ args }) {
    const driver = await getDriver()
    const sites = await loadSites(driver)
    const siteUrl = await resolveSiteUrl(sites, args.site)

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
    description: 'Trigger a fresh sync for a site',
  },
  args: {
    site: { type: 'string', alias: 's', description: 'Site URL' },
  },
  async run({ args }) {
    const driver = await getDriver()
    const sites = await loadSites(driver)
    const siteUrl = await resolveSiteUrl(sites, args.site)

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
    description: 'Manage cloud sync',
  },
  subCommands: {
    status: statusCommand,
    trigger: triggerCommand,
  },
})

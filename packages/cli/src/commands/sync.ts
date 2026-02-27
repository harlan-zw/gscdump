import type { CloudClient, CloudMeSite } from '../cloud'
import process from 'node:process'
import { cancel, isCancel, select } from '@clack/prompts'
import { defineCommand } from 'citty'
import { getCloudClient } from '../auth'
import { loadConfig } from '../config'
import { logger, progressBar } from '../utils'

async function resolveCloudSite(cloud: CloudClient, target?: string): Promise<{ siteId: string, siteUrl: string }> {
  const me = await cloud.me().catch((e: Error) => {
    logger.error(`Failed to fetch sites: ${e.message}`)
    process.exit(1)
  })

  if (me.sites.length === 0) {
    logger.error('No registered sites. Run gscdump register first.')
    process.exit(1)
  }

  let site: CloudMeSite | undefined = target
    ? me.sites.find(s => s.siteUrl === target || s.siteUrl.includes(target))
    : undefined

  if (!site) {
    if (me.sites.length === 1) {
      site = me.sites[0]
    }
    else {
      const selected = await select({
        message: 'Select a site',
        options: me.sites.map(s => ({
          value: s.siteId,
          label: s.siteUrl,
          hint: s.syncStatus || 'unknown',
        })),
      })

      if (isCancel(selected)) {
        cancel('Cancelled')
        process.exit(0)
      }

      site = me.sites.find(s => s.siteId === selected)!
    }
  }

  return { siteId: site.siteId, siteUrl: site.siteUrl }
}

function requireCloud(cloud: CloudClient | null): asserts cloud is CloudClient {
  if (!cloud) {
    logger.error('Sync requires cloud mode. Run gscdump init to set up cloud mode.')
    process.exit(1)
  }
}

const statusCommand = defineCommand({
  meta: {
    name: 'status',
    description: 'Check sync status for a site',
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
    const cloud = await getCloudClient()
    requireCloud(cloud)

    const config = await loadConfig()
    const { siteId } = await resolveCloudSite(cloud, args.site || config.defaultSite)

    const status = await cloud.syncStatus(siteId).catch((e: Error) => {
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

    // Status with color
    const statusColor = status.syncStatus === 'synced'
      ? '\x1B[32m'
      : status.isSyncing
        ? '\x1B[33m'
        : status.syncStatus === 'error'
          ? '\x1B[31m'
          : '\x1B[90m'
    console.log(`  Status:   ${statusColor}${status.syncStatus}\x1B[0m`)

    // Progress bar
    console.log(`  Progress: ${progressBar(status.progress, 100, `${status.progress}%`)}`)
    console.log(`  Days:     \x1B[36m${status.daysSynced}\x1B[0m / ${status.daysAvailable} synced`)

    // Date range
    if (status.oldestDateSynced) {
      console.log(`  Range:    ${status.oldestDateSynced} \x1B[90m→\x1B[0m ${status.newestDateSynced}`)
    }

    // Jobs
    console.log()
    console.log('  \x1B[1mJobs\x1B[0m')
    console.log(`  Queued:     ${status.jobs.queued}`)
    console.log(`  Processing: ${status.jobs.processing}`)
    console.log(`  Completed:  \x1B[32m${status.jobs.completed}\x1B[0m`)
    if (status.jobs.failed > 0) {
      console.log(`  Failed:     \x1B[31m${status.jobs.failed}\x1B[0m`)
    }

    // Tables
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

    // Failed jobs
    if (status.failedJobs.length > 0) {
      console.log()
      console.log('  \x1B[31mFailed Jobs\x1B[0m')
      for (const j of status.failedJobs.slice(0, 5)) {
        console.log(`  ${j.date} ${j.tableName}: ${j.error}`)
      }
      if (status.failedJobs.length > 5) {
        console.log(`  \x1B[90m... and ${status.failedJobs.length - 5} more\x1B[0m`)
      }
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
    site: {
      type: 'string',
      alias: 's',
      description: 'Site URL',
    },
  },
  async run({ args }) {
    const cloud = await getCloudClient()
    requireCloud(cloud)

    const config = await loadConfig()
    const { siteId, siteUrl } = await resolveCloudSite(cloud, args.site || config.defaultSite)

    const result = await cloud.triggerSync(siteId).catch((e: Error) => {
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
    description: 'Sync status and management (cloud mode only)',
  },
  subCommands: {
    status: statusCommand,
    trigger: triggerCommand,
  },
})

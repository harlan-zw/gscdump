import type { TableName } from 'gscdump/analytics/contracts'
import { defineCommand } from 'citty'
import { allTables } from 'gscdump/analytics/schema'
import { createAnalyticsHarness } from '../analytics'
import { loadConfig } from '../config'
import { logger } from '../utils'

const DEFAULT_DAYS = 35

export const compactCommand = defineCommand({
  meta: {
    name: 'compact',
    description: 'Roll daily partitions older than N days into monthly files',
  },
  args: {
    days: {
      type: 'string',
      default: String(DEFAULT_DAYS),
      description: `Age cutoff in days (default: ${DEFAULT_DAYS})`,
    },
    site: {
      type: 'string',
      alias: 's',
      description: 'Restrict to a single site (default: all sites with local data)',
    },
    quiet: {
      type: 'boolean',
      alias: 'q',
      default: false,
      description: 'Suppress progress output',
    },
  },
  async run({ args }) {
    const config = await loadConfig()
    const harness = createAnalyticsHarness(config)
    const siteId = args.site ? harness.siteIdFor(String(args.site)) : undefined
    const quiet = Boolean(args.quiet)
    const days = Number(args.days)

    for (const table of allTables()) {
      const entries = await harness.engine.listLive({
        userId: harness.userId,
        siteId,
        table: table as TableName,
      })
      const siteIds = new Set<string | undefined>(entries.map(e => e.siteId))
      for (const targetSite of siteIds) {
        if (!quiet)
          logger.info(`Compacting ${table} [${targetSite ?? '-'}] older than ${days}d`)
        await harness.engine.compactOlderThan({
          userId: harness.userId,
          siteId: targetSite,
          table: table as TableName,
        }, days)
      }
    }

    if (!quiet)
      logger.success(`compact: done`)
  },
})

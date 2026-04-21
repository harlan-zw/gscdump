import type { TableName } from '../local-store'
import { defineCommand } from 'citty'
import { createCommandContext } from '../context'
import { allTables } from '../local-store'
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
    const ctx = await createCommandContext({ needsStore: true })
    const store = ctx.store!
    const siteId = args.site ? store.siteIdFor(String(args.site)) : undefined
    const quiet = Boolean(args.quiet)
    const days = Number(args.days)

    for (const table of allTables()) {
      const entries = await store.engine.listLive({
        userId: store.userId,
        siteId,
        table: table as TableName,
      })
      const siteIds = new Set<string | undefined>(entries.map(e => e.siteId))
      for (const targetSite of siteIds) {
        if (!quiet)
          logger.info(`Compacting ${table} [${targetSite ?? '-'}] older than ${days}d`)
        await store.engine.compactOlderThan({
          userId: store.userId,
          siteId: targetSite,
          table: table as TableName,
        }, days)
      }
    }

    if (!quiet)
      logger.success(`compact: done`)
  },
})

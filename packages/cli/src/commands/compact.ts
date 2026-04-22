import type { TableName } from '../local-store'
import { defineCommand } from 'citty'
import { createCommandContext } from '../context'
import { allTables } from '../local-store'
import { logger } from '../utils'

export const compactCommand = defineCommand({
  meta: {
    name: 'compact',
    description: 'Run tiered compaction (raw→d7 at 7d, d7→d30 at 30d, d30→d90 at 90d)',
  },
  args: {
    'site': {
      type: 'string',
      alias: 's',
      description: 'Restrict to a single site (default: all sites with local data)',
    },
    'raw-days': {
      type: 'string',
      description: 'Override raw→d7 age threshold in days (default: 7)',
    },
    'd7-days': {
      type: 'string',
      description: 'Override d7→d30 age threshold in days (default: 30)',
    },
    'd30-days': {
      type: 'string',
      description: 'Override d30→d90 age threshold in days (default: 90)',
    },
    'quiet': {
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
    const thresholds: { raw?: number, d7?: number, d30?: number } = {}
    if (args['raw-days'])
      thresholds.raw = Number(args['raw-days'])
    if (args['d7-days'])
      thresholds.d7 = Number(args['d7-days'])
    if (args['d30-days'])
      thresholds.d30 = Number(args['d30-days'])

    for (const table of allTables()) {
      const entries = await store.engine.listLive({
        userId: store.userId,
        siteId,
        table: table as TableName,
      })
      const siteIds = new Set<string | undefined>(entries.map(e => e.siteId))
      for (const targetSite of siteIds) {
        if (!quiet)
          logger.info(`Compacting ${table} [${targetSite ?? '-'}] (raw→d7→d30→d90)`)
        await store.engine.compactTiered({
          userId: store.userId,
          siteId: targetSite,
          table: table as TableName,
        }, thresholds)
      }
    }

    if (!quiet)
      logger.success(`compact: done`)
  },
})

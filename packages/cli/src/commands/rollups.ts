import type { TableName } from '../local-store'
import { DEFAULT_ROLLUPS, rebuildRollups } from '@gscdump/engine/rollups'
import { defineCommand } from 'citty'
import { createCommandContext } from '../context'
import { allTables } from '../local-store'
import { logger } from '../utils'

const rebuildSubCommand = defineCommand({
  meta: {
    name: 'rebuild',
    description: 'Rebuild post-sync rollups (daily totals, weekly totals, top-N tables) for a site',
  },
  args: {
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
    const explicitSiteId = args.site ? store.siteIdFor(String(args.site)) : undefined
    const quiet = Boolean(args.quiet)

    // Discover sites with local data — rollups run per-site so we don't
    // bother rebuilding for sites the user hasn't synced.
    const allSiteIds = new Set<string>()
    if (explicitSiteId) {
      allSiteIds.add(explicitSiteId)
    }
    else {
      for (const table of allTables()) {
        const entries = await store.engine.listLive({
          userId: store.userId,
          table: table as TableName,
        })
        for (const e of entries) {
          if (e.siteId)
            allSiteIds.add(e.siteId)
        }
      }
    }

    if (allSiteIds.size === 0) {
      logger.warn('No sites with local data. Run `gscdump sync` first.')
      return
    }

    let totalBytes = 0
    for (const siteId of allSiteIds) {
      if (!quiet)
        logger.info(`Rebuilding rollups for [${siteId}] (${DEFAULT_ROLLUPS.length} rollups)`)
      const results = await rebuildRollups({
        engine: store.engine,
        dataSource: store.dataSource,
        ctx: { userId: store.userId, siteId },
        defs: DEFAULT_ROLLUPS,
      })
      for (const r of results) {
        totalBytes += r.bytes
        if (!quiet)
          console.log(`  ${r.id.padEnd(20)} ${(r.bytes / 1024).toFixed(1).padStart(8)} KB  ${r.objectKey}`)
      }
    }

    if (!quiet)
      logger.success(`Rebuilt rollups across ${allSiteIds.size} site(s) — total ${(totalBytes / 1024).toFixed(1)} KB`)
  },
})

export const rollupsCommand = defineCommand({
  meta: {
    name: 'rollups',
    description: 'Manage post-sync rollups',
  },
  subCommands: {
    rebuild: rebuildSubCommand,
  },
})

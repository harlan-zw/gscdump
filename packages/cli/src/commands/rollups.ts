import type { TableName } from '../local-store'
import { DEFAULT_ROLLUPS, rebuildRollups } from '@gscdump/analysis/rollups'
import { defineCommand } from 'citty'
import { createCommandContext } from '../context'
import { allTables } from '../local-store'
import { logger, setQuiet } from '../utils'

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
    json: {
      type: 'boolean',
      default: false,
      description: 'Output a JSON summary',
    },
    quiet: {
      type: 'boolean',
      alias: 'q',
      default: false,
      description: 'Suppress progress output',
    },
  },
  async run({ args }) {
    setQuiet(Boolean(args.quiet) || Boolean(args.json))
    const ctx = await createCommandContext({ needsStore: true })
    const store = ctx.store!
    const explicitSiteId = args.site ? store.siteIdFor(String(args.site)) : undefined

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
      if (args.json)
        console.log(JSON.stringify({ sites: [], totalBytes: 0 }, null, 2))
      else
        logger.warn('No sites with local data. Run `gscdump sync` first.')
      return
    }

    const summary: Array<{ siteId: string, rollups: Array<{ id: string, bytes: number, objectKey: string }> }> = []
    let totalBytes = 0
    for (const siteId of allSiteIds) {
      logger.info(`Rebuilding rollups for [${siteId}] (${DEFAULT_ROLLUPS.length} rollups)`)
      const results = await rebuildRollups({
        engine: store.engine,
        dataSource: store.dataSource,
        ctx: { userId: store.userId, siteId },
        defs: DEFAULT_ROLLUPS,
      })
      const site = { siteId, rollups: [] as Array<{ id: string, bytes: number, objectKey: string }> }
      for (const r of results) {
        totalBytes += r.bytes
        site.rollups.push({ id: r.id, bytes: r.bytes, objectKey: r.objectKey })
        if (!args.json)
          console.log(`  ${r.id.padEnd(20)} ${(r.bytes / 1024).toFixed(1).padStart(8)} KB  ${r.objectKey}`)
      }
      summary.push(site)
    }

    if (args.json) {
      console.log(JSON.stringify({ sites: summary, totalBytes }, null, 2))
      return
    }
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

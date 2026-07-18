import type { ManifestEntry, TableName } from '../local-store'
import { inferLegacyTier } from '@gscdump/engine'
import { defineCommand } from 'citty'
import { createCommandContext } from '../context'
import { allTables } from '../local-store'
import { applyOutputMode, logger, OUTPUT_ARGS } from '../utils'

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
    'dry-run': {
      type: 'boolean',
      default: false,
      description: 'Report tier counts per (table, site) without compacting',
    },
    ...OUTPUT_ARGS,
  },
  async run({ args }) {
    const { json } = applyOutputMode(args)
    const ctx = await createCommandContext({ needsStore: true })
    const store = ctx.store!
    const siteId = args.site ? store.siteIdFor(String(args.site)) : undefined
    const dryRun = Boolean(args['dry-run'])
    const thresholds: { raw?: number, d7?: number, d30?: number } = {}
    if (args['raw-days'])
      thresholds.raw = Number(args['raw-days'])
    if (args['d7-days'])
      thresholds.d7 = Number(args['d7-days'])
    if (args['d30-days'])
      thresholds.d30 = Number(args['d30-days'])
    // One broad read is enough to build the (table, site) work list. The
    // compactor performs its own tier-scoped reads when each job runs.
    const liveEntries = await store.engine.listLive({ userId: store.userId, siteId })

    if (dryRun) {
      const report: Array<{ table: string, siteId: string | undefined, raw: number, d7: number, d30: number, d90: number }> = []
      for (const table of allTables()) {
        const entries = liveEntries.filter(entry => entry.table === table)
        const bySite = groupBySite(entries)
        for (const [s, group] of bySite)
          report.push({ table, siteId: s, ...countByTier(group) })
      }
      if (json) {
        console.log(JSON.stringify({ thresholds, plan: report }, null, 2))
        return
      }
      console.log()
      console.log(`  table                site                 raw    d7   d30   d90`)
      for (const r of report)
        console.log(`  ${r.table.padEnd(20)} ${(r.siteId ?? '-').padEnd(20)} ${String(r.raw).padStart(4)}  ${String(r.d7).padStart(4)}  ${String(r.d30).padStart(4)}  ${String(r.d90).padStart(4)}`)
      console.log()
      logger.info(`compact --dry-run: ${report.length} (table, site) pair(s) — pass without --dry-run to apply`)
      return
    }

    const summary: Array<{ table: string, siteId: string | undefined }> = []
    for (const table of allTables()) {
      const entries = liveEntries.filter(entry => entry.table === table)
      const siteIds = new Set<string | undefined>(entries.map(e => e.siteId))
      for (const targetSite of siteIds) {
        logger.info(`Compacting ${table} [${targetSite ?? '-'}] (raw→d7→d30→d90)`)
        await store.engine.compactTiered({
          userId: store.userId,
          siteId: targetSite,
          table: table as TableName,
        }, thresholds)
        summary.push({ table, siteId: targetSite })
      }
    }

    if (json) {
      console.log(JSON.stringify({ thresholds, compacted: summary }, null, 2))
      return
    }
    logger.success(`compact: done`)
  },
})

function groupBySite(entries: ManifestEntry[]): Map<string | undefined, ManifestEntry[]> {
  const m = new Map<string | undefined, ManifestEntry[]>()
  for (const e of entries) {
    const arr = m.get(e.siteId) ?? []
    arr.push(e)
    m.set(e.siteId, arr)
  }
  return m
}

function countByTier(entries: ManifestEntry[]): { raw: number, d7: number, d30: number, d90: number } {
  let raw = 0
  let d7 = 0
  let d30 = 0
  let d90 = 0
  for (const e of entries) {
    const tier = e.tier ?? inferLegacyTier(e) ?? 'raw'
    if (tier === 'raw')
      raw++
    else if (tier === 'd7')
      d7++
    else if (tier === 'd30')
      d30++
    else if (tier === 'd90')
      d90++
  }
  return { raw, d7, d30, d90 }
}

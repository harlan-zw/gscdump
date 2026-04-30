import type { TableName } from '../local-store'
import { defineCommand } from 'citty'
import { createCommandContext } from '../context'
import { allTables } from '../local-store'
import { logger, setQuiet } from '../utils'

const DEFAULT_GRACE_HOURS = 24

export const gcCommand = defineCommand({
  meta: {
    name: 'gc',
    description: 'Delete orphaned object-store files not referenced by any manifest entry',
  },
  args: {
    'grace-hours': {
      type: 'string',
      default: String(DEFAULT_GRACE_HOURS),
      description: `Spare orphans younger than this (default: ${DEFAULT_GRACE_HOURS}h)`,
    },
    'site': {
      type: 'string',
      alias: 's',
      description: 'Restrict to a single site (default: all sites)',
    },
    'dry-run': {
      type: 'boolean',
      default: false,
      description: 'List retired manifest entries past the grace window without deleting',
    },
    'json': {
      type: 'boolean',
      default: false,
      description: 'Output a JSON summary',
    },
    'quiet': {
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
    const siteId = args.site ? store.siteIdFor(String(args.site)) : undefined
    const graceMs = Number(args['grace-hours']) * 3_600_000

    if (args['dry-run']) {
      const cutoff = Date.now() - graceMs
      const candidates: Array<{ table: string, siteId: string | undefined, partition: string, retiredAt: number, objectKey: string }> = []
      for (const table of allTables()) {
        const all = await store.engine.listAll({
          userId: store.userId,
          siteId,
          table: table as TableName,
        })
        for (const e of all) {
          if (e.retiredAt && e.retiredAt < cutoff) {
            candidates.push({
              table,
              siteId: e.siteId,
              partition: e.partition,
              retiredAt: e.retiredAt,
              objectKey: e.objectKey,
            })
          }
        }
      }
      if (args.json) {
        console.log(JSON.stringify({ graceHours: Number(args['grace-hours']), candidates }, null, 2))
        return
      }
      console.log()
      for (const c of candidates)
        console.log(`  ${c.objectKey}  \x1B[90m(retired ${new Date(c.retiredAt).toISOString()})\x1B[0m`)
      console.log()
      logger.info(`gc --dry-run: ${candidates.length} retired manifest entry(ies) past ${args['grace-hours']}h grace; pass without --dry-run to delete`)
      return
    }

    const result = await store.engine.gcOrphans(
      { userId: store.userId, siteId },
      graceMs,
    )

    if (args.json) {
      console.log(JSON.stringify({ graceHours: Number(args['grace-hours']), deleted: result.deleted }, null, 2))
      return
    }
    logger.success(`gc: deleted ${result.deleted} orphan file(s)`)
  },
})

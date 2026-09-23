import { defineCommand } from 'citty'
import { createCommandContext } from '../context'
import { applyOutputMode, logger, OUTPUT_ARGS } from '../utils'

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
      description: 'Restrict to one Site, for example example.com (default: every Site)',
    },
    'dry-run': {
      type: 'boolean',
      default: false,
      description: 'List retired manifest entries past the grace window without deleting',
    },
    ...OUTPUT_ARGS,
  },
  async run({ args }) {
    const { json } = applyOutputMode(args)
    const ctx = await createCommandContext({ needsStore: true })
    const store = ctx.store!
    const siteId = args.site ? store.siteIdFor(await ctx.resolveSite(String(args.site), { scope: 'store' })) : undefined
    const graceMs = Number(args['grace-hours']) * 3_600_000

    if (args['dry-run']) {
      const cutoff = Date.now() - graceMs
      const candidates: Array<{ table: string, siteId: string | undefined, partition: string, retiredAt: number, objectKey: string }> = []
      const all = await store.engine.listAll({ userId: store.userId, siteId })
      for (const e of all) {
        if (e.retiredAt && e.retiredAt < cutoff) {
          candidates.push({
            table: e.table,
            siteId: e.siteId,
            partition: e.partition,
            retiredAt: e.retiredAt,
            objectKey: e.objectKey,
          })
        }
      }
      if (json) {
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

    if (json) {
      console.log(JSON.stringify({ graceHours: Number(args['grace-hours']), deleted: result.deleted }, null, 2))
      return
    }
    logger.success(`gc: deleted ${result.deleted} orphan file(s)`)
  },
})

import { defineCommand } from 'citty'
import { createCommandContext } from '../context'
import { logger } from '../utils'

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
    const graceMs = Number(args['grace-hours']) * 3_600_000

    const result = await store.engine.gcOrphans(
      { userId: store.userId, siteId },
      graceMs,
    )

    if (!quiet)
      logger.success(`gc: deleted ${result.deleted} orphan file(s)`)
  },
})

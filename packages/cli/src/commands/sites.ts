import { defineCommand } from 'citty'
import { createCommandContext } from '../context'
import { logger } from '../utils'

export const sitesCommand = defineCommand({
  meta: {
    name: 'sites',
    description: 'List available GSC sites',
  },
  args: {
    json: {
      type: 'boolean',
      default: false,
      description: 'Output as JSON for scripting',
    },
  },
  async run({ args }) {
    const ctx = await createCommandContext({ needsAuth: true })
    const sites = await ctx.loadSites()

    if (args.json) {
      console.log(JSON.stringify(sites, null, 2))
      return
    }

    if (sites.length === 0) {
      logger.warn('No verified sites found')
      return
    }

    logger.success(`Found ${sites.length} sites:`)
    console.log()
    for (const site of sites) {
      const perm = site.permissionLevel === 'siteOwner' ? '\x1B[32m' : '\x1B[90m'
      console.log(`  ${site.siteUrl} ${perm}(${site.permissionLevel})\x1B[0m`)
    }
  },
})

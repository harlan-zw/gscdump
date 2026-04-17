import process from 'node:process'
import { defineCommand } from 'citty'
import { googleSearchConsole } from 'gscdump'
import { getAuth } from '../auth'
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
    const auth = await getAuth({ interactive: false })
    const client = googleSearchConsole(auth)

    const gscSites = await client.sites().catch((e: Error) => {
      logger.error(`Failed to fetch sites: ${e.message}`)
      process.exit(1)
    })

    const sites = gscSites
      .filter(s => s.siteUrl && s.permissionLevel !== 'siteUnverifiedUser')
      .map(s => ({
        siteUrl: s.siteUrl!,
        permissionLevel: s.permissionLevel || 'unknown',
      }))

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

import { defineCommand } from 'citty'
import { fetchGscSites } from 'gscdump'
import { getAuth } from '../auth'
import { gscErrorHandler, logger } from '../utils'

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

    const gscSites = await fetchGscSites(auth).catch(gscErrorHandler)

    const sites = gscSites
      .filter(site => site.siteUrl && site.permissionLevel !== 'siteUnverifiedUser')
      .map(site => ({
        url: site.siteUrl!,
        permission: site.permissionLevel || 'unknown',
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
      const perm = site.permission === 'siteOwner' ? '\x1B[32m' : '\x1B[90m'
      console.log(`  ${site.url} ${perm}(${site.permission})\x1B[0m`)
    }
  },
})

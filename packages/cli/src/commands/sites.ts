import { defineCommand } from 'citty'
import { fetchSites, googleSearchConsole } from 'gscdump'
import { getAuth, getCloudClient } from '../auth'
import { gscErrorHandler, logger, progressBar } from '../utils'

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
    // Cloud mode: show registered sites with sync status
    const cloud = await getCloudClient()
    if (cloud) {
      const me = await cloud.me().catch((e: Error) => {
        logger.error(`Failed to fetch sites: ${e.message}`)
        process.exit(1)
      })

      if (args.json) {
        console.log(JSON.stringify(me.sites, null, 2))
        return
      }

      if (me.sites.length === 0) {
        logger.warn('No registered sites. Run gscdump register to add a site.')
        return
      }

      logger.success(`${me.sites.length} registered sites:`)
      console.log()
      for (const site of me.sites) {
        const statusColor = site.syncStatus === 'synced'
          ? '\x1B[32m'
          : site.syncStatus === 'syncing'
            ? '\x1B[33m'
            : site.syncStatus === 'error'
              ? '\x1B[31m'
              : '\x1B[90m'

        console.log(`  ${site.siteUrl} ${statusColor}(${site.syncStatus || 'pending'})\x1B[0m`)

        if (site.syncProgress.percent > 0 && site.syncProgress.percent < 100) {
          console.log(`    ${progressBar(site.syncProgress.percent, 100, `${site.syncProgress.percent}%`, 20)}`)
        }

        if (site.oldestDateSynced && site.newestDateSynced) {
          console.log(`    \x1B[90m${site.oldestDateSynced} → ${site.newestDateSynced}\x1B[0m`)
        }
      }
      return
    }

    // Local mode: direct GSC API
    const auth = await getAuth({ interactive: false })
    const client = googleSearchConsole(auth)

    const gscSites = await fetchSites(client).catch(gscErrorHandler)

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

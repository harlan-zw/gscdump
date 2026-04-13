import process from 'node:process'
import { defineCommand } from 'citty'
import { isCloudDriver } from 'gscdump/driver'
import { getDriver } from '../driver'
import { logger, progressBar } from '../utils'

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
    const driver = await getDriver({ interactive: false })

    // Cloud mode: show registered sites with sync status
    if (isCloudDriver(driver)) {
      const sites = await driver.sitesWithSync().catch((e: Error) => {
        logger.error(`Failed to fetch sites: ${e.message}`)
        process.exit(1)
      })

      if (args.json) {
        console.log(JSON.stringify(sites, null, 2))
        return
      }

      if (sites.length === 0) {
        logger.warn('No registered sites. Run gscdump register to add a site.')
        return
      }

      logger.success(`${sites.length} registered sites:`)
      console.log()
      for (const site of sites) {
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
    const sites = await driver.sites().catch((e: Error) => {
      logger.error(`Failed to fetch sites: ${e.message}`)
      process.exit(1)
    })

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

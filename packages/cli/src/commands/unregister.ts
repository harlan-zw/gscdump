import process from 'node:process'
import { cancel, confirm, isCancel, select } from '@clack/prompts'
import { defineCommand } from 'citty'
import { isCloudDriver } from 'gscdump/driver'
import { loadConfig } from '../config'
import { getDriver } from '../driver'
import { logger } from '../utils'

export const unregisterCommand = defineCommand({
  meta: {
    name: 'unregister',
    description: 'Unregister a site from syncing (cloud mode only)',
  },
  args: {
    site: {
      type: 'positional',
      description: 'Site URL to unregister',
      required: false,
    },
  },
  async run({ args }) {
    const driver = await getDriver({ interactive: false })
    if (!isCloudDriver(driver)) {
      logger.error('Unregister requires cloud mode. Run gscdump init to set up.')
      process.exit(1)
    }

    const config = await loadConfig()
    const target = (args.site as string | undefined) || config.defaultSite

    const sites = await driver.sitesWithSync().catch((e: Error) => {
      logger.error(`Failed to fetch sites: ${e.message}`)
      process.exit(1)
    })

    if (sites.length === 0) {
      logger.warn('No registered sites.')
      return
    }

    let site = target
      ? sites.find(s => s.siteUrl === target || s.siteUrl.includes(target))
      : undefined

    if (!site) {
      const selected = await select({
        message: 'Select a site to unregister',
        options: sites.map(s => ({
          value: s.siteUrl,
          label: s.siteUrl,
          hint: s.syncStatus || 'unknown',
        })),
      })

      if (isCancel(selected)) {
        cancel('Cancelled')
        process.exit(0)
      }

      site = sites.find(s => s.siteUrl === selected)!
    }

    const confirmed = await confirm({
      message: `Unregister ${site.siteUrl}? This will stop syncing and delete pending jobs.`,
    })

    if (isCancel(confirmed) || !confirmed) {
      cancel('Cancelled')
      process.exit(0)
    }

    const result = await driver.deleteSite(site.siteUrl).catch((e: Error) => {
      logger.error(`Failed to unregister: ${e.message}`)
      process.exit(1)
    })

    logger.success(`Unregistered ${result.siteUrl}`)
  },
})

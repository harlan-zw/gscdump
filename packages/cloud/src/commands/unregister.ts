import process from 'node:process'
import { cancel, confirm, isCancel, select } from '@clack/prompts'
import { defineCommand } from 'citty'
import { getDriver } from '../session'
import { exitOnError, logger } from '../utils'

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
    const driver = await getDriver()
    const target = args.site as string | undefined

    const sites = await exitOnError(driver.sitesWithSync(), 'Failed to fetch sites')

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

    const result = await exitOnError(driver.deleteSite(site.siteUrl), 'Failed to unregister')

    logger.success(`Unregistered ${result.siteUrl}`)
  },
})

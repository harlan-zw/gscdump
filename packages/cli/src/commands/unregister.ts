import process from 'node:process'
import { cancel, confirm, isCancel, select } from '@clack/prompts'
import { defineCommand } from 'citty'
import { getCloudClient } from '../auth'
import { loadConfig } from '../config'
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
    const cloud = await getCloudClient()
    if (!cloud) {
      logger.error('Unregister requires cloud mode. Run gscdump init to set up.')
      process.exit(1)
    }

    const config = await loadConfig()
    const target = (args.site as string | undefined) || config.defaultSite

    const me = await cloud.me().catch((e: Error) => {
      logger.error(`Failed to fetch sites: ${e.message}`)
      process.exit(1)
    })

    if (me.sites.length === 0) {
      logger.warn('No registered sites.')
      return
    }

    let site = target
      ? me.sites.find(s => s.siteUrl === target || s.siteUrl.includes(target))
      : undefined

    if (!site) {
      const selected = await select({
        message: 'Select a site to unregister',
        options: me.sites.map(s => ({
          value: s.siteId,
          label: s.siteUrl,
          hint: s.syncStatus || 'unknown',
        })),
      })

      if (isCancel(selected)) {
        cancel('Cancelled')
        process.exit(0)
      }

      site = me.sites.find(s => s.siteId === selected)!
    }

    const confirmed = await confirm({
      message: `Unregister ${site.siteUrl}? This will stop syncing and delete pending jobs.`,
    })

    if (isCancel(confirmed) || !confirmed) {
      cancel('Cancelled')
      process.exit(0)
    }

    const result = await cloud.deleteSite(site.siteId).catch((e: Error) => {
      logger.error(`Failed to unregister: ${e.message}`)
      process.exit(1)
    })

    logger.success(`Unregistered ${result.siteUrl}`)
  },
})

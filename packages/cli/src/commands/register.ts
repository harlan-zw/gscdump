import process from 'node:process'
import { cancel, isCancel, select } from '@clack/prompts'
import { defineCommand } from 'citty'
import { isCloudDriver } from 'gscdump/driver'
import { getDriver } from '../driver'
import { logger } from '../utils'

export const registerCommand = defineCommand({
  meta: {
    name: 'register',
    description: 'Register site(s) for syncing (cloud mode only)',
  },
  args: {
    site: {
      type: 'positional',
      description: 'Site URL(s) to register (space-separated for bulk)',
      required: false,
    },
  },
  async run({ args }) {
    const driver = await getDriver({ interactive: false })
    if (!isCloudDriver(driver)) {
      logger.error('Register requires cloud mode. Run gscdump init to set up cloud mode.')
      process.exit(1)
    }

    // Check for bulk: extra positional args come through process.argv
    const rawArgs = process.argv.slice(3).filter(a => !a.startsWith('-'))
    const siteUrls = rawArgs.length > 0 ? rawArgs : args.site ? [args.site as string] : []

    // Bulk register
    if (siteUrls.length > 1) {
      logger.info(`Registering ${siteUrls.length} sites...`)

      const result = await driver.bulkRegister(siteUrls).catch((e: Error) => {
        logger.error(`Bulk registration failed: ${e.message}`)
        process.exit(1)
      })

      console.log()
      for (const r of result.results) {
        const icon = r.status === 'registered'
          ? '\x1B[32m✓\x1B[0m'
          : r.status === 'already_exists'
            ? '\x1B[33m~\x1B[0m'
            : '\x1B[31m✗\x1B[0m'
        const detail = r.status === 'registered'
          ? `ID: ${r.siteId}`
          : r.status === 'already_exists'
            ? 'already registered'
            : r.error || r.status
        console.log(`  ${icon} ${r.siteUrl} — ${detail}`)
      }

      console.log()
      const s = result.summary
      logger.success(`${s.registered} registered, ${s.alreadyExists} existing, ${s.notFound} not found, ${s.errors} errors`)
      return
    }

    // Single site registration
    let siteUrl = siteUrls[0]

    if (!siteUrl) {
      const available = await driver.availableSites().catch((e: Error) => {
        logger.error(`Failed to fetch available sites: ${e.message}`)
        process.exit(1)
      })

      const unregistered = available.filter(s => !s.registered)

      if (unregistered.length === 0) {
        if (available.length > 0) {
          logger.info('All available sites are already registered')
        }
        else {
          logger.warn('No GSC sites found for this account')
        }
        return
      }

      const selected = await select({
        message: 'Select a site to register for syncing',
        options: unregistered.map(s => ({
          value: s.siteUrl,
          label: s.siteUrl,
          hint: s.permissionLevel,
        })),
      })

      if (isCancel(selected)) {
        cancel('Cancelled')
        process.exit(0)
      }

      siteUrl = selected as string
    }

    logger.info(`Registering ${siteUrl}...`)

    const result = await driver.registerSite(siteUrl).catch((e: Error) => {
      logger.error(`Registration failed: ${e.message}`)
      process.exit(1)
    })

    if (result.existing) {
      logger.info(`Site already registered (${result.status})`)
    }
    else {
      logger.success(`Site registered! Sync queued.`)
    }

    console.log()
    console.log(`  Site ID: \x1B[36m${result.siteId}\x1B[0m`)
    console.log(`  Status:  ${result.status}`)
    console.log()
    logger.info('Run gscdump sync status to check sync progress')
  },
})

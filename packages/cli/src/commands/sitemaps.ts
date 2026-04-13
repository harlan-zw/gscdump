import process from 'node:process'
import { cancel, isCancel, select } from '@clack/prompts'
import { defineCommand } from 'citty'
import { fetchSitemap, googleSearchConsole } from 'gscdump'
import { isCloudDriver } from 'gscdump/driver'
import { getAuth } from '../auth'
import { loadConfig } from '../config'
import { getDriver } from '../driver'
import { gscErrorHandler, logger } from '../utils'

async function resolveSiteUrl(driver: Awaited<ReturnType<typeof getDriver>>, target?: string): Promise<string> {
  if (isCloudDriver(driver)) {
    const sites = await driver.sitesWithSync().catch((e: Error) => {
      logger.error(`Failed to fetch sites: ${e.message}`)
      process.exit(1)
    })

    if (sites.length === 0) {
      logger.warn('No registered sites. Run gscdump register first.')
      process.exit(1)
    }

    const match = target
      ? sites.find(s => s.siteUrl === target || s.siteUrl.includes(target))
      : undefined

    if (match)
      return match.siteUrl
    if (sites.length === 1)
      return sites[0].siteUrl

    const selected = await select({
      message: 'Select a site',
      options: sites.map(s => ({ value: s.siteUrl, label: s.siteUrl })),
    })
    if (isCancel(selected)) {
      cancel('Cancelled')
      process.exit(0)
    }
    return selected as string
  }

  if (!target) {
    logger.error('Site URL required (-s)')
    process.exit(1)
  }
  return target
}

const listCommand = defineCommand({
  meta: {
    name: 'list',
    description: 'List sitemaps for a site',
  },
  args: {
    site: {
      type: 'string',
      alias: 's',
      description: 'Site URL (e.g., sc-domain:example.com or https://example.com/)',
    },
    json: {
      type: 'boolean',
      default: false,
      description: 'Output as JSON',
    },
  },
  async run({ args }) {
    const config = await loadConfig()
    const driver = await getDriver({ interactive: false })
    const siteUrl = await resolveSiteUrl(driver, args.site || config.defaultSite)

    // Cloud mode: richer sitemap data
    if (isCloudDriver(driver)) {
      const data = await driver.sitemapHealth(siteUrl).catch((e: Error) => {
        logger.error(`Failed to fetch sitemaps: ${e.message}`)
        process.exit(1)
      })

      if (args.json) {
        console.log(JSON.stringify(data, null, 2))
        return
      }

      if (data.sitemaps.length === 0) {
        logger.warn('No sitemaps found')
        return
      }

      logger.success(`${data.sitemaps.length} sitemaps:`)
      console.log()
      for (const sm of data.sitemaps) {
        const pending = sm.isPending ? ' \x1B[33m(pending)\x1B[0m' : ''
        const errors = sm.errors ? ` \x1B[31m${sm.errors} errors\x1B[0m` : ''
        const warnings = sm.warnings ? ` \x1B[33m${sm.warnings} warnings\x1B[0m` : ''
        const urls = sm.urlCount ? ` \x1B[36m${sm.urlCount.toLocaleString()} URLs\x1B[0m` : ''
        console.log(`  ${sm.path}${urls}${pending}${errors}${warnings}`)
      }

      // Show history trend
      if (data.history.length > 0) {
        console.log()
        console.log('  \x1B[1mRecent History\x1B[0m')
        for (const h of data.history.slice(0, 7)) {
          const errStr = h.errors > 0 ? ` \x1B[31m${h.errors} err\x1B[0m` : ''
          console.log(`  ${h.date}: ${h.urlCount.toLocaleString()} URLs${errStr}`)
        }
      }
      return
    }

    // Local mode: direct GSC API
    const sitemaps = await driver.sitemaps(siteUrl).catch((e: Error) => {
      logger.error(`Failed to fetch sitemaps: ${e.message}`)
      process.exit(1)
    })

    if (args.json) {
      console.log(JSON.stringify(sitemaps, null, 2))
      return
    }

    if (sitemaps.length === 0) {
      logger.warn('No sitemaps found')
      return
    }

    logger.success(`Found ${sitemaps.length} sitemaps:`)
    console.log()
    for (const sm of sitemaps) {
      const pending = sm.isPending ? ' \x1B[33m(pending)\x1B[0m' : ''
      const errors = sm.errors ? ` \x1B[31m${sm.errors} errors\x1B[0m` : ''
      const warnings = sm.warnings ? ` \x1B[33m${sm.warnings} warnings\x1B[0m` : ''
      console.log(`  ${sm.path}${pending}${errors}${warnings}`)
    }
  },
})

const getCommand = defineCommand({
  meta: {
    name: 'get',
    description: 'Get details for a specific sitemap',
  },
  args: {
    site: {
      type: 'string',
      alias: 's',
      required: true,
      description: 'Site URL',
    },
    url: {
      type: 'positional',
      required: true,
      description: 'Sitemap URL',
    },
    json: {
      type: 'boolean',
      default: false,
      description: 'Output as JSON',
    },
  },
  async run({ args }) {
    // Get command uses raw GSC client for detailed sitemap info
    const auth = await getAuth({ interactive: false })
    const client = googleSearchConsole(auth)
    const sitemap = await fetchSitemap(client, args.site, args.url).catch(gscErrorHandler)

    if (args.json) {
      console.log(JSON.stringify(sitemap, null, 2))
      return
    }

    console.log()
    console.log(`  \x1B[1mPath:\x1B[0m ${sitemap.path}`)
    console.log(`  \x1B[1mType:\x1B[0m ${sitemap.type || 'sitemap'}`)
    console.log(`  \x1B[1mLast Submitted:\x1B[0m ${sitemap.lastSubmitted || 'N/A'}`)
    console.log(`  \x1B[1mLast Downloaded:\x1B[0m ${sitemap.lastDownloaded || 'N/A'}`)
    console.log(`  \x1B[1mPending:\x1B[0m ${sitemap.isPending ? 'Yes' : 'No'}`)
    console.log(`  \x1B[1mErrors:\x1B[0m ${sitemap.errors || 0}`)
    console.log(`  \x1B[1mWarnings:\x1B[0m ${sitemap.warnings || 0}`)

    if (sitemap.contents?.length) {
      console.log()
      console.log('  \x1B[1mContents:\x1B[0m')
      for (const c of sitemap.contents) {
        console.log(`    ${c.type}: ${c.submitted} submitted, ${c.indexed} indexed`)
      }
    }
  },
})

const submitCommand = defineCommand({
  meta: {
    name: 'submit',
    description: 'Submit a sitemap to GSC',
  },
  args: {
    site: {
      type: 'string',
      alias: 's',
      required: true,
      description: 'Site URL',
    },
    url: {
      type: 'positional',
      required: true,
      description: 'Sitemap URL to submit',
    },
  },
  async run({ args }) {
    const driver = await getDriver({ interactive: false })
    await driver.submitSitemap(args.site, args.url).catch((e: Error) => {
      logger.error(`Submit failed: ${e.message}`)
      process.exit(1)
    })
    logger.success(`Submitted sitemap: ${args.url}`)
  },
})

const deleteCommand = defineCommand({
  meta: {
    name: 'delete',
    description: 'Delete a sitemap from GSC',
  },
  args: {
    site: {
      type: 'string',
      alias: 's',
      required: true,
      description: 'Site URL',
    },
    url: {
      type: 'positional',
      required: true,
      description: 'Sitemap URL to delete',
    },
  },
  async run({ args }) {
    const driver = await getDriver({ interactive: false })
    await driver.deleteSitemap(args.site, args.url).catch((e: Error) => {
      logger.error(`Delete failed: ${e.message}`)
      process.exit(1)
    })
    logger.success(`Deleted sitemap: ${args.url}`)
  },
})

const refreshCommand = defineCommand({
  meta: {
    name: 'refresh',
    description: 'Refresh sitemap data from GSC (cloud mode)',
  },
  args: {
    site: {
      type: 'string',
      alias: 's',
      description: 'Site URL',
    },
  },
  async run({ args }) {
    const driver = await getDriver({ interactive: false })
    if (!isCloudDriver(driver)) {
      logger.error('Sitemap refresh requires cloud mode. Run gscdump init to set up.')
      process.exit(1)
    }

    const config = await loadConfig()
    const siteUrl = await resolveSiteUrl(driver, args.site || config.defaultSite)

    const result = await driver.sitemapAction(siteUrl, { action: 'refresh' }).catch((e: Error) => {
      logger.error(`Refresh failed: ${e.message}`)
      process.exit(1)
    })

    logger.success(`Refreshed sitemaps (${result.sitemapCount} found)`)
  },
})

export const sitemapsCommand = defineCommand({
  meta: {
    name: 'sitemaps',
    description: 'Manage sitemaps',
  },
  subCommands: {
    list: listCommand,
    get: getCommand,
    submit: submitCommand,
    delete: deleteCommand,
    refresh: refreshCommand,
  },
})

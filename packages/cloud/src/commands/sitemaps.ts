import { defineCommand } from 'citty'
import { getDriver } from '../session'
import { exitOnError, loadSites, logger, resolveSiteUrl } from '../utils'

const listCommand = defineCommand({
  meta: {
    name: 'list',
    description: 'List sitemaps with cloud health data and history',
  },
  args: {
    site: { type: 'string', alias: 's', description: 'Site URL' },
    json: { type: 'boolean', default: false, description: 'Output as JSON' },
  },
  async run({ args }) {
    const driver = await getDriver()
    const sites = await loadSites(driver)
    const siteUrl = await resolveSiteUrl(sites, args.site)

    const data = await exitOnError(driver.sitemapHealth(siteUrl), 'Failed to fetch sitemaps')

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

    if (data.history.length > 0) {
      console.log()
      console.log('  \x1B[1mRecent History\x1B[0m')
      for (const h of data.history.slice(0, 7)) {
        const errStr = h.errors > 0 ? ` \x1B[31m${h.errors} err\x1B[0m` : ''
        console.log(`  ${h.date}: ${h.urlCount.toLocaleString()} URLs${errStr}`)
      }
    }
  },
})

const refreshCommand = defineCommand({
  meta: {
    name: 'refresh',
    description: 'Refresh sitemap data from GSC',
  },
  args: {
    site: { type: 'string', alias: 's', description: 'Site URL' },
  },
  async run({ args }) {
    const driver = await getDriver()
    const sites = await loadSites(driver)
    const siteUrl = await resolveSiteUrl(sites, args.site)

    const result = await exitOnError(driver.sitemapAction(siteUrl, { action: 'refresh' }), 'Refresh failed')

    logger.success(`Refreshed sitemaps (${result.sitemapCount} found)`)
  },
})

export const sitemapsCommand = defineCommand({
  meta: {
    name: 'sitemaps',
    description: 'Cloud sitemap health and management',
  },
  subCommands: {
    list: listCommand,
    refresh: refreshCommand,
  },
})

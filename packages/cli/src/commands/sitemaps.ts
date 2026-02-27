import process from 'node:process'
import { cancel, isCancel, select } from '@clack/prompts'
import { defineCommand } from 'citty'
import { deleteSitemap, fetchSitemap, fetchSitemaps, googleSearchConsole, submitSitemap } from 'gscdump'
import { getAuth, getCloudClient } from '../auth'
import { loadConfig } from '../config'
import { gscErrorHandler, logger } from '../utils'

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
    // Cloud mode: richer sitemap data from platform
    const cloud = await getCloudClient()
    if (cloud) {
      const config = await loadConfig()
      const target = args.site || config.defaultSite

      const me = await cloud.me().catch((e: Error) => {
        logger.error(`Failed to fetch sites: ${e.message}`)
        process.exit(1)
      })

      if (me.sites.length === 0) {
        logger.warn('No registered sites. Run gscdump register first.')
        return
      }

      let site = target
        ? me.sites.find(s => s.siteUrl === target || s.siteUrl.includes(target))
        : undefined

      if (!site) {
        if (me.sites.length === 1) {
          site = me.sites[0]
        }
        else {
          const selected = await select({
            message: 'Select a site',
            options: me.sites.map(s => ({ value: s.siteId, label: s.siteUrl })),
          })
          if (isCancel(selected)) {
            cancel('Cancelled')
            process.exit(0)
          }
          site = me.sites.find(s => s.siteId === selected)!
        }
      }

      const data = await cloud.sitemaps(site.siteId).catch((e: Error) => {
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
    if (!args.site) {
      logger.error('Site URL required (-s)')
      process.exit(1)
    }

    const auth = await getAuth({ interactive: false })
    const client = googleSearchConsole(auth)
    const sitemaps = await fetchSitemaps(client, args.site).catch(gscErrorHandler)

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
    const cloud = await getCloudClient()
    if (cloud) {
      const config = await loadConfig()
      const me = await cloud.me().catch((e: Error) => {
        logger.error(`Failed to fetch sites: ${e.message}`)
        process.exit(1)
      })

      const target = args.site || config.defaultSite
      const site = me.sites.find(s => s.siteUrl === target || s.siteUrl.includes(target))
      if (!site) {
        logger.error(`Site not found: ${target}`)
        process.exit(1)
      }

      await cloud.sitemapAction(site.siteId, { action: 'submit', sitemapUrl: args.url }).catch((e: Error) => {
        logger.error(`Submit failed: ${e.message}`)
        process.exit(1)
      })
      logger.success(`Submitted sitemap: ${args.url}`)
      return
    }

    const auth = await getAuth({ interactive: false })
    const client = googleSearchConsole(auth)
    await submitSitemap(client, args.site, args.url).catch(gscErrorHandler)
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
    const cloud = await getCloudClient()
    if (cloud) {
      const config = await loadConfig()
      const me = await cloud.me().catch((e: Error) => {
        logger.error(`Failed to fetch sites: ${e.message}`)
        process.exit(1)
      })

      const target = args.site || config.defaultSite
      const site = me.sites.find(s => s.siteUrl === target || s.siteUrl.includes(target))
      if (!site) {
        logger.error(`Site not found: ${target}`)
        process.exit(1)
      }

      await cloud.sitemapAction(site.siteId, { action: 'delete', sitemapUrl: args.url }).catch((e: Error) => {
        logger.error(`Delete failed: ${e.message}`)
        process.exit(1)
      })
      logger.success(`Deleted sitemap: ${args.url}`)
      return
    }

    const auth = await getAuth({ interactive: false })
    const client = googleSearchConsole(auth)
    await deleteSitemap(client, args.site, args.url).catch(gscErrorHandler)
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
    const cloud = await getCloudClient()
    if (!cloud) {
      logger.error('Sitemap refresh requires cloud mode. Run gscdump init to set up.')
      process.exit(1)
    }

    const config = await loadConfig()
    const me = await cloud.me().catch((e: Error) => {
      logger.error(`Failed to fetch sites: ${e.message}`)
      process.exit(1)
    })

    const target = args.site || config.defaultSite
    let site = target
      ? me.sites.find(s => s.siteUrl === target || s.siteUrl.includes(target))
      : me.sites.length === 1 ? me.sites[0] : undefined

    if (!site) {
      const selected = await select({
        message: 'Select a site',
        options: me.sites.map(s => ({ value: s.siteId, label: s.siteUrl })),
      })
      if (isCancel(selected)) {
        cancel('Cancelled')
        process.exit(0)
      }
      site = me.sites.find(s => s.siteId === selected)!
    }

    const result = await cloud.sitemapAction(site.siteId, { action: 'refresh' }).catch((e: Error) => {
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

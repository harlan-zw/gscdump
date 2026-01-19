import { defineCommand } from 'citty'
import { deleteSitemap, fetchSitemap, fetchSitemaps, googleSearchConsole, submitSitemap } from 'gscdump'
import { getAuth } from '../auth'
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
      required: true,
      description: 'Site URL (e.g., sc-domain:example.com or https://example.com/)',
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
    const auth = await getAuth({ interactive: false })
    const client = googleSearchConsole(auth)
    await deleteSitemap(client, args.site, args.url).catch(gscErrorHandler)
    logger.success(`Deleted sitemap: ${args.url}`)
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
  },
})

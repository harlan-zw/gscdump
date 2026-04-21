import process from 'node:process'
import { defineCommand } from 'citty'
import { fetchSitemap } from 'gscdump'
import { loadConfig } from '../config'
import { createCommandContext } from '../context'
import { gscErrorHandler, logger } from '../utils'

function requireSite(target?: string): string {
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
    const siteUrl = requireSite(args.site || config.defaultSite)
    const ctx = await createCommandContext({ needsAuth: true })
    const client = ctx.client!

    const raw = await client.sitemaps.list(siteUrl).catch((e: Error) => {
      logger.error(`Failed to fetch sitemaps: ${e.message}`)
      process.exit(1)
    })

    const sitemaps = raw.map(sm => ({
      path: sm.path!,
      type: sm.type || undefined,
      isPending: sm.isPending || false,
      errors: Number(sm.errors) || 0,
      warnings: Number(sm.warnings) || 0,
      lastDownloaded: sm.lastDownloaded || null,
    }))

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
    const ctx = await createCommandContext({ needsAuth: true })
    const client = ctx.client!
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
    const ctx = await createCommandContext({ needsAuth: true })
    const client = ctx.client!
    await client.sitemaps.submit(args.site, args.url).catch((e: Error) => {
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
    const ctx = await createCommandContext({ needsAuth: true })
    const client = ctx.client!
    await client.sitemaps.delete(args.site, args.url).catch((e: Error) => {
      logger.error(`Delete failed: ${e.message}`)
      process.exit(1)
    })
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

import process from 'node:process'
import { defineCommand } from 'citty'
import { fetchSitemap } from 'gscdump'
import { discoverSitemapResult } from 'gscdump/sitemap'
import { createCommandContext } from '../context'
import { gscErrorHandler } from '../error-handler'
import { loadSitemapUrls } from '../sitemap'
import { applyOutputMode, logger, noSubcommandSelected, OUTPUT_ARGS } from '../utils'

const listCommand = defineCommand({
  meta: {
    name: 'list',
    description: 'List sitemaps for a site',
  },
  args: {
    ...OUTPUT_ARGS,
    site: { type: 'string', alias: 's', description: 'Site URL (e.g., sc-domain:example.com or https://example.com/)' },
    pending: { type: 'boolean', default: false, description: 'Show only sitemaps with isPending=true' },
    errored: { type: 'boolean', default: false, description: 'Show only sitemaps with errors > 0' },
  },
  async run({ args }) {
    const { json } = applyOutputMode(args)
    const ctx = await createCommandContext({ needsAuth: true })
    const siteUrl = await ctx.resolveSite(args.site ? String(args.site) : undefined)
    const client = ctx.client!

    const raw = await client.sitemaps.list(siteUrl).catch(gscErrorHandler)

    let sitemaps = raw.map(sm => ({
      path: sm.path!,
      type: sm.type || undefined,
      isPending: sm.isPending || false,
      errors: Number(sm.errors) || 0,
      warnings: Number(sm.warnings) || 0,
      lastDownloaded: sm.lastDownloaded || null,
      lastSubmitted: sm.lastSubmitted || null,
    }))

    if (args.pending)
      sitemaps = sitemaps.filter(sm => sm.isPending)
    if (args.errored)
      sitemaps = sitemaps.filter(sm => sm.errors > 0)

    if (json) {
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
      const submitted = sm.lastSubmitted ? ` \x1B[90msubmitted ${sm.lastSubmitted}\x1B[0m` : ''
      console.log(`  ${sm.path}${pending}${errors}${warnings}${submitted}`)
    }
  },
})

const getCommand = defineCommand({
  meta: {
    name: 'get',
    description: 'Get details for a specific sitemap',
  },
  args: {
    ...OUTPUT_ARGS,
    site: { type: 'string', alias: 's', description: 'Site URL (defaults to config.defaultSite or prompt)' },
    url: { type: 'positional', required: true, description: 'Sitemap URL' },
  },
  async run({ args }) {
    const { json } = applyOutputMode(args)
    const ctx = await createCommandContext({ needsAuth: true })
    const siteUrl = await ctx.resolveSite(args.site ? String(args.site) : undefined)
    const client = ctx.client!
    const sitemap = await fetchSitemap(client, siteUrl, args.url).catch(gscErrorHandler)

    if (json) {
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
    ...OUTPUT_ARGS,
    site: { type: 'string', alias: 's', description: 'Site URL (defaults to config.defaultSite or prompt)' },
    url: { type: 'positional', required: true, description: 'Sitemap URL to submit' },
  },
  async run({ args }) {
    const { json } = applyOutputMode(args)
    const ctx = await createCommandContext({ needsAuth: true })
    const siteUrl = await ctx.resolveSite(args.site ? String(args.site) : undefined)
    const client = ctx.client!
    await client.sitemaps.submit(siteUrl, args.url).catch(gscErrorHandler)
    if (json) {
      console.log(JSON.stringify({ siteUrl, feedpath: args.url, status: 'submitted' }, null, 2))
      return
    }
    logger.success(`Submitted sitemap: ${args.url}`)
  },
})

const deleteCommand = defineCommand({
  meta: {
    name: 'delete',
    description: 'Delete a sitemap from GSC',
  },
  args: {
    ...OUTPUT_ARGS,
    site: { type: 'string', alias: 's', description: 'Site URL (defaults to config.defaultSite or prompt)' },
    url: { type: 'positional', required: true, description: 'Sitemap URL to delete' },
  },
  async run({ args }) {
    const { json } = applyOutputMode(args)
    const ctx = await createCommandContext({ needsAuth: true })
    const siteUrl = await ctx.resolveSite(args.site ? String(args.site) : undefined)
    const client = ctx.client!
    await client.sitemaps.delete(siteUrl, args.url).catch(gscErrorHandler)
    if (json) {
      console.log(JSON.stringify({ siteUrl, feedpath: args.url, status: 'deleted' }, null, 2))
      return
    }
    logger.success(`Deleted sitemap: ${args.url}`)
  },
})

const discoverCommand = defineCommand({
  meta: {
    name: 'discover',
    description: 'Probe a domain\'s robots.txt + common paths for an advertised sitemap (no auth needed)',
  },
  args: {
    ...OUTPUT_ARGS,
    domain: { type: 'positional', required: true, description: 'Domain (e.g., example.com)' },
  },
  async run({ args }) {
    const { json } = applyOutputMode(args)
    const domain = String(args.domain).replace(/^https?:\/\//, '').replace(/\/.*$/, '')
    const discovery = await discoverSitemapResult(domain)
    const url = discovery._tag === 'found' ? discovery.url : null
    if (json) {
      console.log(JSON.stringify({ domain, sitemap: url, status: discovery._tag }, null, 2))
      return
    }
    if (discovery._tag === 'incomplete') {
      logger.error(`Sitemap discovery was incomplete: ${discovery.failures[0]?.detail ?? 'unknown failure'}`)
      process.exit(1)
    }
    if (!url) {
      logger.warn(`No sitemap discovered for ${domain}`)
      process.exit(1)
    }
    logger.success(`Discovered sitemap: ${url}`)
  },
})

const urlsCommand = defineCommand({
  meta: {
    name: 'urls',
    description: 'Fetch a sitemap (or sitemap index) and dump its <loc> URLs (no auth needed)',
  },
  args: {
    ...OUTPUT_ARGS,
    'url': { type: 'positional', required: true, description: 'Sitemap URL (index files are followed)' },
    'limit': { type: 'string', alias: 'l', description: 'Stop after N URLs across all nested sitemaps' },
    'max-depth': { type: 'string', description: 'Max sitemap-index nesting depth (default: 3)' },
  },
  async run({ args }) {
    const { json } = applyOutputMode(args)
    const limit = args.limit ? Number.parseInt(String(args.limit), 10) : undefined
    const maxDepth = args['max-depth'] ? Number.parseInt(String(args['max-depth']), 10) : undefined
    const result = await loadSitemapUrls(String(args.url), { maxUrls: limit, maxDepth })
    if (result._tag === 'error') {
      logger.error(`Sitemap fetch failed: ${result.message}`)
      process.exit(1)
    }
    const { urls, complete, documentsRead } = result.value
    if (json) {
      console.log(JSON.stringify({ sitemap: args.url, count: urls.length, complete, documentsRead, urls }, null, 2))
      return
    }
    if (!complete)
      logger.warn('Sitemap walk was truncated or a child document failed')
    for (const u of urls)
      console.log(u)
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
    discover: discoverCommand,
    urls: urlsCommand,
  },
  // No subcommand: list sitemaps (requires --site).
  async run({ args }) {
    if (!noSubcommandSelected('sitemaps', ['list', 'get', 'submit', 'delete', 'discover', 'urls']))
      return
    await listCommand.run?.({ args, cmd: listCommand, rawArgs: [] } as any)
  },
})

import process from 'node:process'
import { isCancel, password } from '@clack/prompts'
import { bingDataQueryV1Schema, bingDataTotalsQueryV1Schema, bingSitemapSubmitRequestV1Schema } from '@gscdump/contracts/v1'
import { defineCommand } from 'citty'
import { bingWebmaster } from 'gscdump/bing'
import open from 'open'
import { resolveAuthentication, saveAuthentication } from '../auth-state'
import { BING_REDIRECT_URI, clearBingCredentials, getBingClient, loginBingOAuth, saveBingCredentials } from '../bing-auth'
import { BING_DATASETS, dumpBingSite, parseBingDumpOptions, resolveBingSites, unwrapBing } from '../bing-data'
import { dumpHostedBingSite, hostedBingClient, inspectHostedBingUrl, listHostedBingSites, resolveHostedBingSites } from '../bing-hosted'
import { bingCommandMeta } from '../command-meta'
import { columnsFor } from '../render/analysis'
import { renderTable } from '../render/layout'
import { terminalOutputOptions } from '../render/terminal'
import { useCliRuntime } from '../runtime'
import { commandLineError, stopError } from '../stop'
import { applyOutputMode, logger, OUTPUT_ARGS, parseIntegerOption, plural, toCSV } from '../utils'

const siteArg = { type: 'string', alias: 's', description: 'Site ID or URL from `gscdump bing sites`' } as const

function resolveBingSiteArg(args: Record<string, unknown>, positionalTarget?: string): string {
  if (positionalTarget && args.site)
    throw commandLineError('Pass either a positional Site or --site, not both.')
  const extra = ((args._ as string[] | undefined) ?? []).slice(positionalTarget ? 1 : 0)
  if (extra.length > 0)
    throw commandLineError(`Unexpected positional argument: ${extra[0]}.`)
  const target = positionalTarget ?? (args.site ? String(args.site) : undefined)
  if (!target)
    throw commandLineError('Pass a Site ID or URL from `gscdump bing sites` as a positional argument or with --site.')
  return target
}

function defaultBingDateRange(startArg?: unknown, endArg?: unknown): { startDate: string, endDate: string } {
  const endDate = endArg ? String(endArg) : new Date().toISOString().slice(0, 10)
  const endMs = Date.parse(`${endDate}T00:00:00Z`)
  const startDate = startArg
    ? String(startArg)
    : Number.isFinite(endMs)
      ? new Date(endMs - 27 * 86_400_000).toISOString().slice(0, 10)
      : endDate
  return { startDate, endDate }
}

function resolveBingOutputFormat(args: Record<string, unknown>): 'table' | 'json' | 'csv' {
  if (args.json)
    return 'json'
  const format = String(args.format ?? 'table')
  if (format !== 'table' && format !== 'json' && format !== 'csv')
    throw commandLineError('Invalid --format. Use table, json, or csv.')
  return format
}

export const bingCommand = defineCommand({
  meta: bingCommandMeta,
  subCommands: {
    login: defineCommand({
      meta: { name: 'login', description: 'Save a Bing API key or authorize with browser OAuth' },
      args: {
        'site': siteArg,
        'api-key': { type: 'string', description: 'Bing Webmaster API key. Defaults to BING_API_KEY or a password prompt' },
        'oauth': { type: 'boolean', description: 'Use a registered Bing OAuth client' },
        'client-id': { type: 'string', description: 'Bing OAuth client ID. Defaults to BING_CLIENT_ID' },
        'client-secret': { type: 'string', description: 'Bing OAuth client secret. Defaults to BING_CLIENT_SECRET' },
        'redirect-uri': { type: 'string', description: `Registered loopback callback. Defaults to BING_REDIRECT_URI or ${BING_REDIRECT_URI}` },
        'browser': { type: 'boolean', default: true, description: 'Open the browser. Use --no-browser to print the login URL' },
        ...OUTPUT_ARGS,
      },
      async run({ args }) {
        const { json } = applyOutputMode(args)
        const env = useCliRuntime().environment
        const authentication = await resolveAuthentication()
        if (authentication._tag === 'Hosted') {
          if (args.oauth || args['api-key'] || args['client-id'] || args['client-secret'] || args['redirect-uri'])
            throw new Error('Local Bing credentials need Local mode. Pass --mode local. Hosted mode uses the Bing connection saved on gscdump.com.')
          if (!args.site)
            throw new Error('Choose --site SITE_ID from `gscdump bing sites` to connect Bing.')
          const [site] = await resolveHostedBingSites(authentication, { site: args.site, requireConnected: false })
          if (site!.connection._tag === 'connected') {
            console.log(JSON.stringify({ searchEngine: 'bing', connection: site!.connection }, null, 2))
            return
          }
          const url = new URL('/auth/bing', authentication.apiRoot)
          url.searchParams.set('siteId', site!.siteId)
          process.stderr.write(`Open this URL to connect Bing:\n${url}\n`)
          if (args.browser)
            await open(url.toString()).catch(() => { logger.warn('The browser could not open. Use the printed login URL.') })
          if (json)
            console.log(JSON.stringify({ searchEngine: 'bing', connection: site!.connection, authorizationUrl: url.toString() }))
          else
            logger.info('Complete Bing authorization in your browser. Then run `gscdump bing status --site SITE_ID`.')
          return
        }
        if (args.oauth) {
          if (args['api-key'])
            throw new Error('Choose --oauth or --api-key.')
          await loginBingOAuth({
            clientId: args['client-id'] ?? env.BING_CLIENT_ID ?? '',
            clientSecret: args['client-secret'] ?? env.BING_CLIENT_SECRET ?? '',
            redirectUri: args['redirect-uri'] ?? env.BING_REDIRECT_URI ?? BING_REDIRECT_URI,
            async openUrl(url) {
              process.stderr.write(`Open this URL to authorize Bing:\n${url}\n`)
              if (args.browser)
                await open(url).catch(() => { logger.warn('The browser could not open. Use the printed login URL.') })
            },
          })
        }
        else {
          if (args['client-id'] || args['client-secret'] || args['redirect-uri'])
            throw new Error('If you use OAuth client options, add --oauth.')
          let apiKey = (args['api-key'] ?? env.BING_API_KEY)?.trim()
          if (!apiKey && process.stdin.isTTY && !json) {
            const value = await password({ message: 'Bing Webmaster API key' })
            if (isCancel(value) || typeof value !== 'string')
              throw new Error('Bing login cancelled.')
            apiKey = value.trim()
          }
          if (!apiKey)
            throw new Error('Set BING_API_KEY or use --oauth with BING_CLIENT_ID and BING_CLIENT_SECRET.')
          unwrapBing(await bingWebmaster({ apiKey }).getUserSites({ signal: AbortSignal.timeout(30_000) }))
          await saveBingCredentials({ _tag: 'ApiKey', apiKey })
        }
        await saveAuthentication({ _tag: 'Local' })
        if (json)
          console.log(JSON.stringify({ searchEngine: 'bing', authenticated: true }))
        else
          logger.success('Bing credentials saved. Run `gscdump bing sites`.')
      },
    }),
    logout: defineCommand({
      meta: { name: 'logout', description: 'Remove saved Bing credentials from the current profile' },
      args: OUTPUT_ARGS,
      async run({ args }) {
        const { json } = applyOutputMode(args)
        const authentication = await resolveAuthentication()
        if (authentication._tag === 'Hosted')
          throw new Error('Hosted authentication is shared with Google. Use `gscdump auth logout` to remove it.')
        await clearBingCredentials()
        const env = useCliRuntime().environment
        const environmentCredentials = Boolean(env.BING_API_KEY?.trim() || env.BING_ACCESS_TOKEN?.trim())
        if (json)
          console.log(JSON.stringify({ searchEngine: 'bing', savedCredentialsRemoved: true, environmentCredentials }))
        else
          logger.success(`Saved Bing credentials removed.${environmentCredentials ? ' Unset BING_API_KEY and BING_ACCESS_TOKEN to stop environment authentication.' : ''}`)
      },
    }),
    status: defineCommand({
      meta: { name: 'status', description: 'Check Bing authentication against the live API' },
      args: { site: siteArg, ...OUTPUT_ARGS },
      async run({ args }) {
        const { json } = applyOutputMode(args)
        const authentication = await resolveAuthentication()
        if (authentication._tag === 'Hosted') {
          const sites = args.site
            ? await resolveHostedBingSites(authentication, { site: args.site, requireConnected: false })
            : await listHostedBingSites(authentication)
          console.log(JSON.stringify({ searchEngine: 'bing', mode: 'hosted', sites }, null, 2))
          return
        }
        const client = await getBingClient()
        const sites = unwrapBing(await client.getUserSites({ signal: AbortSignal.timeout(30_000) }))
        if (json)
          console.log(JSON.stringify({ searchEngine: 'bing', authenticated: true, verifiedSites: sites.filter(site => site.isVerified).length }))
        else
          logger.success(`Bing authenticated. ${plural(sites.filter(site => site.isVerified).length, 'verified site', 'verified sites')}.`)
      },
    }),
    sites: defineCommand({
      meta: { name: 'sites', description: 'List Bing sites and verification details' },
      args: OUTPUT_ARGS,
      async run({ args }) {
        applyOutputMode(args)
        const authentication = await resolveAuthentication()
        if (authentication._tag === 'Hosted') {
          console.log(JSON.stringify({ searchEngine: 'bing', sites: await listHostedBingSites(authentication) }, null, 2))
          return
        }
        const client = await getBingClient()
        const sites = unwrapBing(await client.getUserSites({ signal: AbortSignal.timeout(30_000) }))
        console.log(JSON.stringify({ searchEngine: 'bing', sites }, null, 2))
      },
    }),
    dump: defineCommand({
      meta: { name: 'dump', description: 'Download Bing traffic, pages, keywords, and crawl data' },
      args: {
        'site': siteArg,
        'all-sites': { type: 'boolean', description: 'Dump every verified Bing site' },
        'out': { type: 'string', alias: 'o', default: './bing-export', description: 'Output directory, with one directory per site' },
        'format': { type: 'string', alias: 'F', default: 'json', description: 'File format: json, ndjson, csv' },
        'datasets': { type: 'string', description: `Comma-separated datasets: ${BING_DATASETS.join(', ')}. Default: all. Crawl issues have no dates, so --start, --end, and Hosted mode leave them out` },
        'start': { type: 'string', description: 'Keep returned dates on or after YYYY-MM-DD' },
        'end': { type: 'string', description: 'Keep returned dates on or before YYYY-MM-DD' },
        ...OUTPUT_ARGS,
      },
      async run({ args }) {
        const { json } = applyOutputMode(args)
        const options = parseBingDumpOptions(args)
        const authentication = await resolveAuthentication()
        if (authentication._tag === 'Hosted') {
          if (options.datasetsExplicit && options.datasets.includes('crawl-issues'))
            throw new Error('Bing crawl issues require local authentication. Use --mode local.')
          if (options.start && options.end && Date.parse(options.end) - Date.parse(options.start) > 366 * 86_400_000)
            throw new Error('Hosted Bing exports support at most 366 days. Use a shorter --start and --end range.')
          const sites = await resolveHostedBingSites(authentication, { site: args.site, allSites: args['all-sites'] })
          const summaries = []
          for (const site of sites) {
            const summary = await dumpHostedBingSite(authentication, site, args.out, options)
            summaries.push(summary)
            if (!json)
              logger.success(`Bing ${site.siteUrl}: ${plural(summary.files.length, 'file', 'files')} exported to ${args.out}.`)
          }
          if (json)
            console.log(JSON.stringify(args['all-sites'] ? { searchEngine: 'bing', sites: summaries } : summaries[0], null, 2))
          return
        }
        const client = await getBingClient()
        const sites = await resolveBingSites(client, { site: args.site, allSites: args['all-sites'] })
        const summaries = []
        for (const site of sites) {
          const summary = await dumpBingSite(client, site, args.out, options)
          summaries.push(summary)
          if (!json)
            logger.success(`Bing ${site}: ${plural(summary.files.length, 'file', 'files')} exported to ${args.out}.`)
        }
        if (json)
          console.log(JSON.stringify(args['all-sites'] ? { searchEngine: 'bing', sites: summaries } : summaries[0], null, 2))
      },
    }),
    inspect: defineCommand({
      meta: { name: 'inspect', description: 'Read Bing Indexing Evidence for one URL' },
      args: {
        url: { type: 'positional', required: true, description: 'Page URL to inspect' },
        site: { ...siteArg, required: true },
        ...OUTPUT_ARGS,
      },
      async run({ args }) {
        applyOutputMode(args)
        const url = URL.parse(args.url)
        if (!url || !['http:', 'https:'].includes(url.protocol))
          throw new Error('Use a full HTTP or HTTPS page URL.')
        const authentication = await resolveAuthentication()
        if (authentication._tag === 'Hosted') {
          const [site] = await resolveHostedBingSites(authentication, { site: args.site })
          console.log(JSON.stringify(await inspectHostedBingUrl(authentication, site!.siteId, args.url), null, 2))
          return
        }
        const client = await getBingClient()
        const [site] = await resolveBingSites(client, { site: args.site })
        const evidence = unwrapBing(await client.getIndexingEvidence(site!, args.url, { signal: AbortSignal.timeout(30_000) }))
        console.log(JSON.stringify(evidence, null, 2))
      },
    }),
    verify: defineCommand({
      meta: { name: 'verify', description: 'Check Bing site verification and activate a hosted connection' },
      args: { site: { ...siteArg, required: true }, ...OUTPUT_ARGS },
      async run({ args }) {
        applyOutputMode(args)
        const authentication = await resolveAuthentication()
        if (authentication._tag !== 'Hosted')
          throw stopError({ code: 'HOSTED_MODE_REQUIRED', message: 'Hosted Bing connection verification needs Hosted mode. Pass --mode hosted.', nextCommand: 'gscdump auth login --mode hosted' })
        const [site] = await resolveHostedBingSites(authentication, { site: args.site, requireConnected: false })
        const result = await hostedBingClient(authentication).verifySiteBingConnection({ params: { siteId: site!.siteId } })
        console.log(JSON.stringify(result.data, null, 2))
      },
    }),
    query: defineCommand({
      meta: { name: 'query', description: 'Read hosted Bing traffic, pages, keywords, or crawl rows to stdout' },
      args: {
        target: { type: 'positional', required: false, description: 'Site ID or URL from `gscdump bing sites` (or pass --site)' },
        site: siteArg,
        dataset: { type: 'string', default: 'traffic', description: 'Dataset: traffic, pages, keywords, or crawl (default: traffic)' },
        start: { type: 'string', description: 'Start date YYYY-MM-DD (default: 28 days ending on --end or today)' },
        end: { type: 'string', description: 'End date YYYY-MM-DD (default: today UTC)' },
        limit: { type: 'string', alias: 'l', description: 'Max rows (1 to 500, default: 100)' },
        offset: { type: 'string', description: 'Pagination offset (default: 0)' },
        format: { type: 'string', alias: 'f', default: 'table', description: 'Output format: table, json, or csv' },
        ...OUTPUT_ARGS,
      },
      async run({ args }) {
        const format = resolveBingOutputFormat(args as Record<string, unknown>)
        applyOutputMode({ ...args, json: format === 'json' })
        const siteTarget = resolveBingSiteArg(args as Record<string, unknown>, args.target ? String(args.target) : undefined)
        const { startDate, endDate } = defaultBingDateRange(args.start, args.end)
        const limit = parseIntegerOption(args.limit, '--limit')
        const offset = parseIntegerOption(args.offset, '--offset', 0)
        const parsedQuery = bingDataQueryV1Schema.safeParse({
          dataset: String(args.dataset ?? 'traffic'),
          startDate,
          endDate,
          ...(limit !== undefined ? { limit } : {}),
          ...(offset !== undefined ? { offset } : {}),
        })
        if (!parsedQuery.success)
          throw commandLineError(parsedQuery.error.issues[0]?.message ?? 'Invalid Bing query options.')

        const authentication = await resolveAuthentication()
        if (authentication._tag !== 'Hosted')
          throw stopError({ code: 'HOSTED_MODE_REQUIRED', message: '`gscdump bing query` reads the hosted Bing record, so it needs Hosted mode. Pass --mode hosted, or use `gscdump bing dump` in Local mode.', nextCommand: 'gscdump auth login --mode hosted' })

        const [site] = await resolveHostedBingSites(authentication, { site: siteTarget })
        const { data } = await hostedBingClient(authentication).getSiteBingData({
          params: { siteId: site!.siteId },
          query: parsedQuery.data,
        })

        if (format === 'json') {
          console.log(JSON.stringify(data, null, 2))
          return
        }
        const rows = data.rows as unknown as Record<string, unknown>[]
        if (format === 'csv') {
          console.log(toCSV(rows, Object.keys(rows[0] ?? {})))
          return
        }
        console.log(`${data.siteUrl} / bing ${data.dataset} (${startDate} to ${endDate}, sync: ${data.sync._tag})`)
        if (rows.length === 0) {
          console.log('No rows returned.')
          return
        }
        for (const line of renderTable(rows, columnsFor(rows), terminalOutputOptions()))
          console.log(line)
        logger.info(`${rows.length} of ${data.pagination.total} rows (offset ${data.pagination.offset}).`)
      },
    }),
    totals: defineCommand({
      meta: { name: 'totals', description: 'Read summed hosted Bing page or keyword totals across a date range' },
      args: {
        target: { type: 'positional', required: false, description: 'Site ID or URL from `gscdump bing sites` (or pass --site)' },
        site: siteArg,
        dataset: { type: 'string', default: 'keywords', description: 'Dataset: pages or keywords (default: keywords)' },
        start: { type: 'string', description: 'Start date YYYY-MM-DD (default: 28 days ending on --end or today)' },
        end: { type: 'string', description: 'End date YYYY-MM-DD (default: today UTC)' },
        limit: { type: 'string', alias: 'l', description: 'Max rows (1 to 500, default: 100)' },
        offset: { type: 'string', description: 'Pagination offset (default: 0)' },
        format: { type: 'string', alias: 'f', default: 'table', description: 'Output format: table, json, or csv' },
        ...OUTPUT_ARGS,
      },
      async run({ args }) {
        const format = resolveBingOutputFormat(args as Record<string, unknown>)
        applyOutputMode({ ...args, json: format === 'json' })
        const siteTarget = resolveBingSiteArg(args as Record<string, unknown>, args.target ? String(args.target) : undefined)
        const { startDate, endDate } = defaultBingDateRange(args.start, args.end)
        const limit = parseIntegerOption(args.limit, '--limit')
        const offset = parseIntegerOption(args.offset, '--offset', 0)
        const parsedQuery = bingDataTotalsQueryV1Schema.safeParse({
          dataset: String(args.dataset ?? 'keywords'),
          startDate,
          endDate,
          ...(limit !== undefined ? { limit } : {}),
          ...(offset !== undefined ? { offset } : {}),
        })
        if (!parsedQuery.success)
          throw commandLineError(parsedQuery.error.issues[0]?.message ?? 'Invalid Bing totals options.')

        const authentication = await resolveAuthentication()
        if (authentication._tag !== 'Hosted')
          throw stopError({ code: 'HOSTED_MODE_REQUIRED', message: '`gscdump bing totals` reads the hosted Bing record, so it needs Hosted mode. Pass --mode hosted, or use `gscdump bing dump` in Local mode.', nextCommand: 'gscdump auth login --mode hosted' })

        const [site] = await resolveHostedBingSites(authentication, { site: siteTarget })
        const { data } = await hostedBingClient(authentication).getSiteBingDataTotals({
          params: { siteId: site!.siteId },
          query: parsedQuery.data,
        })

        if (format === 'json') {
          console.log(JSON.stringify(data, null, 2))
          return
        }
        const rows = data.rows as unknown as Record<string, unknown>[]
        if (format === 'csv') {
          console.log(toCSV(rows, Object.keys(rows[0] ?? {})))
          return
        }
        console.log(`${data.siteUrl} / bing ${data.dataset} totals (${startDate} to ${endDate}, sync: ${data.sync._tag})`)
        console.log(`  Ranked totals: ${data.totals.clicks.toLocaleString('en-US')} clicks, ${data.totals.impressions.toLocaleString('en-US')} impressions`)
        if (rows.length === 0) {
          console.log('No rows returned.')
          return
        }
        for (const line of renderTable(rows, columnsFor(rows), terminalOutputOptions()))
          console.log(line)
        logger.info(`${rows.length} of ${data.pagination.total} distinct ${data.dataset} (offset ${data.pagination.offset}).`)
      },
    }),
    sitemaps: defineCommand({
      meta: { name: 'sitemaps', description: 'Manage hosted Bing sitemaps' },
      subCommands: {
        submit: defineCommand({
          meta: { name: 'submit', description: 'Submit a sitemap URL to Bing Webmaster Tools (hosted)' },
          args: {
            target: { type: 'positional', required: false, description: 'Site ID or URL from `gscdump bing sites` (or pass --site)' },
            site: siteArg,
            sitemap: { type: 'string', description: 'Sitemap URL to submit (omit to let gscdump pick the Site\'s sitemap)' },
            ...OUTPUT_ARGS,
          },
          async run({ args }) {
            const { json } = applyOutputMode(args)
            const siteTarget = resolveBingSiteArg(args as Record<string, unknown>, args.target ? String(args.target) : undefined)
            const parsedBody = bingSitemapSubmitRequestV1Schema.safeParse({
              ...(args.sitemap ? { url: String(args.sitemap) } : {}),
            })
            if (!parsedBody.success)
              throw commandLineError(parsedBody.error.issues[0]?.message ?? 'Use a valid http or https sitemap URL.')

            const authentication = await resolveAuthentication()
            if (authentication._tag !== 'Hosted')
              throw stopError({ code: 'HOSTED_MODE_REQUIRED', message: '`gscdump bing sitemaps submit` needs Hosted mode. Pass --mode hosted.', nextCommand: 'gscdump auth login --mode hosted' })

            const [site] = await resolveHostedBingSites(authentication, { site: siteTarget })
            const { data } = await hostedBingClient(authentication).submitSiteBingSitemap({
              params: { siteId: site!.siteId },
              body: parsedBody.data,
            })

            if (data._tag === 'failed')
              process.exitCode = 1
            if (json) {
              console.log(JSON.stringify(data, null, 2))
              return
            }
            if (data._tag === 'submitted')
              logger.success(`Submitted sitemap to Bing: ${data.sitemapUrl} (${data.sitemap._tag}).`)
            else
              logger.error(`Bing sitemap submission failed: ${data.reason}${data.retryable ? ' (retryable)' : ''}.`)
          },
        }),
      },
    }),
  },
})

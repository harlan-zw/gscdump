import process from 'node:process'
import { isCancel, password } from '@clack/prompts'
import { defineCommand } from 'citty'
import { bingWebmaster } from 'gscdump/bing'
import open from 'open'
import { resolveAuthentication, saveAuthentication } from '../auth-state'
import { BING_REDIRECT_URI, clearBingCredentials, getBingClient, loginBingOAuth, saveBingCredentials } from '../bing-auth'
import { BING_DATASETS, dumpBingSite, parseBingDumpOptions, resolveBingSites, unwrapBing } from '../bing-data'
import { dumpHostedBingSite, hostedBingClient, inspectHostedBingUrl, listHostedBingSites, resolveHostedBingSites } from '../bing-hosted'
import { bingCommandMeta } from '../command-meta'
import { useCliRuntime } from '../runtime'
import { applyOutputMode, logger, OUTPUT_ARGS } from '../utils'

const siteArg = { type: 'string', alias: 's', description: 'Site ID or URL from `gscdump bing sites`' } as const

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
        if (authentication._tag === 'Cloud') {
          if (args.oauth || args['api-key'] || args['client-id'] || args['client-secret'] || args['redirect-uri'])
            throw new Error('Local Bing credentials require --mode local. Hosted login uses `gscdump auth login --mode cloud`.')
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
        if (authentication._tag === 'Cloud')
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
        if (authentication._tag === 'Cloud') {
          const sites = args.site
            ? await resolveHostedBingSites(authentication, { site: args.site, requireConnected: false })
            : await listHostedBingSites(authentication)
          console.log(JSON.stringify({ searchEngine: 'bing', mode: 'cloud', sites }, null, 2))
          return
        }
        const client = await getBingClient()
        const sites = unwrapBing(await client.getUserSites({ signal: AbortSignal.timeout(30_000) }))
        if (json)
          console.log(JSON.stringify({ searchEngine: 'bing', authenticated: true, verifiedSites: sites.filter(site => site.isVerified).length }))
        else
          logger.success(`Bing authenticated. ${sites.filter(site => site.isVerified).length} verified sites.`)
      },
    }),
    sites: defineCommand({
      meta: { name: 'sites', description: 'List Bing sites and verification details' },
      args: OUTPUT_ARGS,
      async run({ args }) {
        applyOutputMode(args)
        const authentication = await resolveAuthentication()
        if (authentication._tag === 'Cloud') {
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
        'datasets': { type: 'string', description: `Comma-separated datasets: ${BING_DATASETS.join(', ')}. Default: all. Crawl issues have no dates, so --start, --end, and cloud mode leave them out` },
        'start': { type: 'string', description: 'Keep returned dates on or after YYYY-MM-DD' },
        'end': { type: 'string', description: 'Keep returned dates on or before YYYY-MM-DD' },
        ...OUTPUT_ARGS,
      },
      async run({ args }) {
        const { json } = applyOutputMode(args)
        const options = parseBingDumpOptions(args)
        const authentication = await resolveAuthentication()
        if (authentication._tag === 'Cloud') {
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
              logger.success(`Bing ${site.siteUrl}: ${summary.files.length} files exported to ${args.out}.`)
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
            logger.success(`Bing ${site}: ${summary.files.length} files exported to ${args.out}.`)
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
        if (authentication._tag === 'Cloud') {
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
        if (authentication._tag !== 'Cloud')
          throw new Error('Hosted Bing connection verification requires --mode cloud.')
        const [site] = await resolveHostedBingSites(authentication, { site: args.site, requireConnected: false })
        const result = await hostedBingClient(authentication).verifySiteBingConnection({ params: { siteId: site!.siteId } })
        console.log(JSON.stringify(result.data, null, 2))
      },
    }),
  },
})

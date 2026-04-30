import type { VerificationMethod } from 'gscdump'
import process from 'node:process'
import { confirm, isCancel } from '@clack/prompts'
import { defineCommand } from 'citty'
import { addSite, deleteSite, fetchSitesWithSitemaps, getVerificationToken, siteUrlToVerificationSite, verificationMethodsFor, verifySite } from 'gscdump'
import { createCommandContext } from '../context'
import { gscErrorHandler } from '../error-handler'
import { logger, setQuiet } from '../utils'

const ALL_METHODS: VerificationMethod[] = ['META', 'FILE', 'DNS_TXT', 'DNS_CNAME', 'ANALYTICS', 'TAG_MANAGER']

function pickDefaultMethod(siteUrl: string): VerificationMethod {
  return siteUrl.startsWith('sc-domain:') ? 'DNS_TXT' : 'META'
}

function validateMethod(siteUrl: string, method: string): VerificationMethod {
  const upper = method.toUpperCase() as VerificationMethod
  if (!ALL_METHODS.includes(upper)) {
    logger.error(`Invalid --method: ${method}. Valid: ${ALL_METHODS.join(', ')}`)
    process.exit(1)
  }
  const site = siteUrlToVerificationSite(siteUrl)
  const allowed = verificationMethodsFor(site)
  if (!allowed.includes(upper)) {
    logger.error(`Method ${upper} not valid for ${site.type === 'INET_DOMAIN' ? 'domain' : 'URL-prefix'} property "${siteUrl}". Valid: ${allowed.join(', ')}`)
    process.exit(1)
  }
  return upper
}

function printPlacementInstructions(method: VerificationMethod, siteUrl: string, token: string): void {
  console.log()
  console.log(`  \x1B[1mPlacement instructions (${method})\x1B[0m`)
  console.log()
  switch (method) {
    case 'META':
      console.log(`  Add this tag inside the <head> of \x1B[36m${siteUrl}\x1B[0m:`)
      console.log()
      console.log(`    \x1B[2m<meta name="google-site-verification" content="${token}" />\x1B[0m`)
      break
    case 'FILE':
      console.log(`  Upload a file named \x1B[1m${token}\x1B[0m to the site root, accessible at:`)
      console.log()
      console.log(`    \x1B[36m${siteUrl.replace(/\/?$/, '/')}${token}\x1B[0m`)
      break
    case 'DNS_TXT':
      console.log(`  Add a TXT record on \x1B[1m${siteUrl.replace(/^sc-domain:/, '')}\x1B[0m with value:`)
      console.log()
      console.log(`    \x1B[2m${token}\x1B[0m`)
      break
    case 'DNS_CNAME': {
      const [host, target] = token.split(/\s+/, 2)
      console.log(`  Add a CNAME record:`)
      console.log()
      console.log(`    \x1B[2mHost:   ${host}\x1B[0m`)
      console.log(`    \x1B[2mTarget: ${target ?? '(see token)'}\x1B[0m`)
      break
    }
    case 'ANALYTICS':
      console.log(`  Make sure your Google Analytics tracking tag is installed on the site, then run \`gscdump sites verify\`.`)
      break
    case 'TAG_MANAGER':
      console.log(`  Make sure your Google Tag Manager container snippet is installed on the site, then run \`gscdump sites verify\`.`)
      break
  }
  console.log()
  console.log(`  \x1B[90mThen run:\x1B[0m gscdump sites verify ${siteUrl} --method ${method}`)
  console.log()
}

const addCommand = defineCommand({
  meta: {
    name: 'add',
    description: 'Register a property in Search Console (unverified state — verify ownership separately)',
  },
  args: {
    url: { type: 'positional', required: true, description: 'Property URL (https://example.com/ or sc-domain:example.com)' },
    json: { type: 'boolean', default: false, description: 'Output as JSON' },
    quiet: { type: 'boolean', alias: 'q', default: false, description: 'Suppress info/success output' },
  },
  async run({ args }) {
    setQuiet(Boolean(args.quiet) || Boolean(args.json))
    const ctx = await createCommandContext({ needsAuth: true })
    await addSite(ctx.client!, args.url).catch(gscErrorHandler)

    if (args.json) {
      console.log(JSON.stringify({ siteUrl: args.url, status: 'added', verified: false }, null, 2))
      return
    }
    logger.success(`Added: ${args.url}`)
    logger.info(`Property is in unverified state. Verify ownership next:`)
    const method = pickDefaultMethod(args.url)
    console.log(`    \x1B[2mgscdump sites verify-token ${args.url} --method ${method}\x1B[0m`)
  },
})

const deleteCommand = defineCommand({
  meta: {
    name: 'delete',
    description: 'Remove a property from Search Console',
  },
  args: {
    url: { type: 'positional', required: true, description: 'Property URL to remove' },
    yes: { type: 'boolean', alias: 'y', default: false, description: 'Skip confirmation prompt' },
    json: { type: 'boolean', default: false, description: 'Output as JSON' },
    quiet: { type: 'boolean', alias: 'q', default: false, description: 'Suppress info/success output' },
  },
  async run({ args }) {
    setQuiet(Boolean(args.quiet) || Boolean(args.json))

    if (!args.yes && !args.json) {
      const ok = await confirm({
        message: `Remove ${args.url} from Search Console? Local synced data is unaffected.`,
        initialValue: false,
      })
      if (isCancel(ok) || !ok) {
        logger.info('Cancelled')
        process.exit(0)
      }
    }

    const ctx = await createCommandContext({ needsAuth: true })
    await deleteSite(ctx.client!, args.url).catch(gscErrorHandler)

    if (args.json) {
      console.log(JSON.stringify({ siteUrl: args.url, status: 'deleted' }, null, 2))
      return
    }
    logger.success(`Removed: ${args.url}`)
  },
})

const verifyTokenCommand = defineCommand({
  meta: {
    name: 'verify-token',
    description: 'Get a verification token to place on the site or in DNS',
  },
  args: {
    url: { type: 'positional', required: true, description: 'Property URL' },
    method: { type: 'string', alias: 'm', description: 'META, FILE, DNS_TXT, DNS_CNAME, ANALYTICS, TAG_MANAGER (default: META for URL-prefix, DNS_TXT for sc-domain:)' },
    json: { type: 'boolean', default: false, description: 'Output as JSON' },
    quiet: { type: 'boolean', alias: 'q', default: false, description: 'Suppress info/success output' },
  },
  async run({ args }) {
    setQuiet(Boolean(args.quiet) || Boolean(args.json))
    const method = validateMethod(args.url, args.method ?? pickDefaultMethod(args.url))
    const ctx = await createCommandContext({ needsAuth: true })
    const result = await getVerificationToken(ctx.client!, args.url, method).catch(gscErrorHandler)

    if (args.json) {
      console.log(JSON.stringify({ siteUrl: args.url, method, token: result.token, site: result.site }, null, 2))
      return
    }
    printPlacementInstructions(method, args.url, result.token)
  },
})

const verifyCommand = defineCommand({
  meta: {
    name: 'verify',
    description: 'Trigger verification — Google fetches/validates the token you placed',
  },
  args: {
    url: { type: 'positional', required: true, description: 'Property URL' },
    method: { type: 'string', alias: 'm', description: 'Verification method to validate (must match the one used for verify-token)' },
    json: { type: 'boolean', default: false, description: 'Output as JSON' },
    quiet: { type: 'boolean', alias: 'q', default: false, description: 'Suppress info/success output' },
  },
  async run({ args }) {
    setQuiet(Boolean(args.quiet) || Boolean(args.json))
    const method = validateMethod(args.url, args.method ?? pickDefaultMethod(args.url))
    const ctx = await createCommandContext({ needsAuth: true })
    const resource = await verifySite(ctx.client!, args.url, method).catch(gscErrorHandler)

    if (args.json) {
      console.log(JSON.stringify({ siteUrl: args.url, method, resource }, null, 2))
      return
    }
    logger.success(`Verified: ${args.url}`)
    if (resource.owners?.length) {
      console.log()
      console.log(`  Owners:`)
      for (const o of resource.owners)
        console.log(`    \x1B[90m└─\x1B[0m ${o}`)
    }
  },
})

export const sitesCommand = defineCommand({
  meta: {
    name: 'sites',
    description: 'List GSC sites; manage properties (add/delete) and verify ownership',
  },
  args: {
    'json': {
      type: 'boolean',
      default: false,
      description: 'Output as JSON for scripting',
    },
    'with-sitemaps': {
      type: 'boolean',
      default: false,
      description: 'Include sitemaps for each owned site',
    },
    'owner-only': {
      type: 'boolean',
      default: false,
      description: 'Filter to permissionLevel=siteOwner',
    },
    'quiet': {
      type: 'boolean',
      alias: 'q',
      default: false,
      description: 'Suppress info/success output',
    },
  },
  subCommands: {
    'add': addCommand,
    'delete': deleteCommand,
    'verify-token': verifyTokenCommand,
    'verify': verifyCommand,
  },
  async run({ args }) {
    setQuiet(Boolean(args.quiet) || Boolean(args.json))
    const ctx = await createCommandContext({ needsAuth: true })

    const ownerOnly = Boolean(args['owner-only'])

    if (args['with-sitemaps']) {
      const all = await fetchSitesWithSitemaps(ctx.client!).catch(gscErrorHandler)
      const sites = ownerOnly ? all.filter(s => s.permissionLevel === 'siteOwner') : all
      if (args.json) {
        // Decorate each site with sitemap counts so scripts don't have to
        // walk the array again.
        const enriched = sites.map(s => ({
          ...s,
          sitemapCounts: {
            total: s.sitemaps.length,
            pending: s.sitemaps.filter(sm => sm.isPending).length,
            errored: s.sitemaps.filter(sm => Number(sm.errors) > 0).length,
          },
        }))
        console.log(JSON.stringify(enriched, null, 2))
        return
      }
      if (sites.length === 0) {
        logger.warn(ownerOnly ? 'No owned sites found' : 'No verified sites found')
        return
      }
      logger.success(`Found ${sites.length} ${ownerOnly ? 'owned' : 'verified'} sites:`)
      console.log()
      for (const site of sites) {
        const perm = site.permissionLevel === 'siteOwner' ? '\x1B[32m' : '\x1B[90m'
        console.log(`  ${site.siteUrl} ${perm}(${site.permissionLevel})\x1B[0m`)
        for (const sm of site.sitemaps) {
          const pending = sm.isPending ? ' \x1B[33m(pending)\x1B[0m' : ''
          console.log(`    \x1B[90m└─\x1B[0m ${sm.path}${pending}`)
        }
      }
      return
    }

    const all = await ctx.loadSites()
    const sites = ownerOnly ? all.filter(s => s.permissionLevel === 'siteOwner') : all

    if (args.json) {
      console.log(JSON.stringify(sites, null, 2))
      return
    }

    if (sites.length === 0) {
      logger.warn(ownerOnly ? 'No owned sites found' : 'No verified sites found')
      return
    }

    logger.success(`Found ${sites.length} ${ownerOnly ? 'owned ' : ''}sites:`)
    console.log()
    for (const site of sites) {
      const perm = site.permissionLevel === 'siteOwner' ? '\x1B[32m' : '\x1B[90m'
      console.log(`  ${site.siteUrl} ${perm}(${site.permissionLevel})\x1B[0m`)
    }
  },
})

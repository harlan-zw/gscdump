import type { VerificationMethod } from 'gscdump/sites'
import process from 'node:process'
import { confirm, isCancel } from '@clack/prompts'
import { defineCommand } from 'citty'
import { addSite, deleteSite, fetchSitesWithSitemaps, getVerificationToken, getVerifiedSite, listVerifiedSites, siteUrlToVerificationSite, unverifySite, verificationMethodsFor, verifySite } from 'gscdump/sites'
import { sitesCommandMeta } from '../command-meta'
import { createCommandContext } from '../context'
import { applyOutputMode, logger, OUTPUT_ARGS } from '../utils'

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
      console.log(`  Make sure the Google Analytics tracking tag is installed on the site.`)
      console.log(`  Expected tracking ID:`)
      console.log()
      console.log(`    \x1B[2m${token}\x1B[0m`)
      break
    case 'TAG_MANAGER':
      console.log(`  Make sure the Google Tag Manager container snippet is installed on the site.`)
      console.log(`  Expected container ID:`)
      console.log()
      console.log(`    \x1B[2m${token}\x1B[0m`)
      break
  }
  console.log()
  console.log(`  \x1B[90mThen run:\x1B[0m gscdump sites verify ${siteUrl} --method ${method}`)
  console.log()
}

const addCommand = defineCommand({
  meta: {
    name: 'add',
    description: 'Register a property in Search Console (pass --verify to chain token + verify in one call)',
  },
  args: {
    url: { type: 'positional', required: true, description: 'Property URL (https://example.com/ or sc-domain:example.com)' },
    verify: { type: 'boolean', default: false, description: 'After adding, fetch a verification token and trigger Google\'s validation' },
    method: { type: 'string', alias: 'm', description: 'Verification method (used with --verify; default: META for URL-prefix, DNS_TXT for sc-domain:)' },
    ...OUTPUT_ARGS,
  },
  async run({ args }) {
    applyOutputMode(args)
    const ctx = await createCommandContext({ needsAuth: true })
    await addSite(ctx.client!, args.url)

    if (!args.verify) {
      if (args.json) {
        console.log(JSON.stringify({ siteUrl: args.url, status: 'added', verified: false }, null, 2))
        return
      }
      logger.success(`Added: ${args.url}`)
      logger.info(`Property is in unverified state. Verify ownership next:`)
      const method = pickDefaultMethod(args.url)
      console.log(`    \x1B[2mgscdump sites verify-token ${args.url} --method ${method}\x1B[0m`)
      return
    }

    // --verify: chain getToken → user-facing placement instructions → triggers verifySite.
    const method = validateMethod(args.url, args.method ?? pickDefaultMethod(args.url))
    const tokenResult = await getVerificationToken(ctx.client!, args.url, method)

    if (args.json) {
      // JSON mode: emit the token, do not run verify (caller can't place it before we trigger).
      console.log(JSON.stringify({
        siteUrl: args.url,
        status: 'added',
        method,
        token: tokenResult.token,
        site: tokenResult.site,
        verified: false,
        next: 'Place the token, then run `gscdump sites verify <url> --method <m>`',
      }, null, 2))
      return
    }

    logger.success(`Added: ${args.url}`)
    printPlacementInstructions(method, args.url, tokenResult.token)

    const ok = await confirm({
      message: 'Token placed? Trigger Google verification now?',
      initialValue: true,
    })
    if (isCancel(ok) || !ok) {
      logger.info('Skipped verification. Run `gscdump sites verify` once the token is live.')
      return
    }

    const resource = await verifySite(ctx.client!, args.url, method)
    logger.success(`Verified: ${args.url}`)
    if (resource.owners?.length) {
      console.log()
      console.log(`  Owners:`)
      for (const o of resource.owners)
        console.log(`    \x1B[90m└─\x1B[0m ${o}`)
    }
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
    ...OUTPUT_ARGS,
  },
  async run({ args }) {
    applyOutputMode(args)

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
    await deleteSite(ctx.client!, args.url)

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
    ...OUTPUT_ARGS,
  },
  async run({ args }) {
    applyOutputMode(args)
    const method = validateMethod(args.url, args.method ?? pickDefaultMethod(args.url))
    const ctx = await createCommandContext({ needsAuth: true })
    const result = await getVerificationToken(ctx.client!, args.url, method)

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
    ...OUTPUT_ARGS,
  },
  async run({ args }) {
    applyOutputMode(args)
    const method = validateMethod(args.url, args.method ?? pickDefaultMethod(args.url))
    const ctx = await createCommandContext({ needsAuth: true })
    const resource = await verifySite(ctx.client!, args.url, method)

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

const verifyGetCommand = defineCommand({
  meta: {
    name: 'verify-get',
    description: 'Get a single verified WebResource by id',
  },
  args: {
    id: { type: 'positional', required: true, description: 'WebResource id (from `sites verify-list`)' },
    ...OUTPUT_ARGS,
  },
  async run({ args }) {
    applyOutputMode(args)
    const ctx = await createCommandContext({ needsAuth: true })
    const resource = await getVerifiedSite(ctx.client!, args.id)

    if (args.json) {
      console.log(JSON.stringify(resource, null, 2))
      return
    }
    const ident = resource.site?.identifier ?? resource.id ?? '?'
    const type = resource.site?.type === 'INET_DOMAIN' ? 'domain' : 'site'
    console.log()
    console.log(`  \x1B[1m${ident}\x1B[0m \x1B[90m(${type})\x1B[0m`)
    console.log(`  \x1B[90mid:\x1B[0m ${resource.id ?? '?'}`)
    if (resource.owners?.length) {
      console.log(`  Owners:`)
      for (const o of resource.owners)
        console.log(`    \x1B[90m└─\x1B[0m ${o}`)
    }
    console.log()
  },
})

const unverifyCommand = defineCommand({
  meta: {
    name: 'unverify',
    description: 'Drop your verified ownership of a WebResource (remove the placed token first!)',
  },
  args: {
    id: { type: 'positional', required: true, description: 'WebResource id (from `sites verify-list`)' },
    yes: { type: 'boolean', alias: 'y', default: false, description: 'Skip confirmation prompt' },
    ...OUTPUT_ARGS,
  },
  async run({ args }) {
    applyOutputMode(args)

    if (!args.yes && !args.json) {
      const ok = await confirm({
        message: `Unverify WebResource ${args.id}? Remove any placed verification token first or Google may re-verify.`,
        initialValue: false,
      })
      if (isCancel(ok) || !ok) {
        logger.info('Cancelled')
        process.exit(0)
      }
    }

    const ctx = await createCommandContext({ needsAuth: true })
    await unverifySite(ctx.client!, args.id)

    if (args.json) {
      console.log(JSON.stringify({ id: args.id, status: 'unverified' }, null, 2))
      return
    }
    logger.success(`Unverified: ${args.id}`)
  },
})

const verifyListCommand = defineCommand({
  meta: {
    name: 'verify-list',
    description: 'List verified WebResources from the Site Verification API (distinct from Search Console properties)',
  },
  args: {
    ...OUTPUT_ARGS,
  },
  async run({ args }) {
    applyOutputMode(args)
    const ctx = await createCommandContext({ needsAuth: true })
    const resources = await listVerifiedSites(ctx.client!)

    if (args.json) {
      console.log(JSON.stringify(resources, null, 2))
      return
    }
    if (resources.length === 0) {
      logger.warn('No verified WebResources found')
      return
    }
    logger.success(`${resources.length} verified WebResources:`)
    console.log()
    for (const r of resources) {
      const id = r.id ?? '?'
      const site = r.site
      const ident = site?.identifier ?? id
      const type = site?.type === 'INET_DOMAIN' ? 'domain' : 'site'
      console.log(`  \x1B[1m${ident}\x1B[0m \x1B[90m(${type})\x1B[0m`)
      if (r.owners?.length) {
        for (const o of r.owners)
          console.log(`    \x1B[90m└─\x1B[0m ${o}`)
      }
    }
  },
})

const getCommand = defineCommand({
  meta: {
    name: 'get',
    description: 'Show a single property\'s permissionLevel from the sites list',
  },
  args: {
    url: { type: 'positional', required: true, description: 'Property URL' },
    ...OUTPUT_ARGS,
  },
  async run({ args }) {
    applyOutputMode(args)
    const ctx = await createCommandContext({ needsAuth: true })
    const all = await ctx.loadSites()
    const site = all.find(s => s.siteUrl === args.url)
    if (!site) {
      if (args.json) {
        console.log(JSON.stringify(null))
        process.exit(1)
      }
      logger.error(`Not found: ${args.url}`)
      process.exit(1)
    }
    if (args.json) {
      console.log(JSON.stringify(site, null, 2))
      return
    }
    const perm = site.permissionLevel === 'siteOwner' ? '\x1B[32m' : '\x1B[90m'
    console.log()
    console.log(`  \x1B[1m${site.siteUrl}\x1B[0m`)
    console.log(`  Permission: ${perm}${site.permissionLevel}\x1B[0m`)
    console.log()
  },
})

const LIST_ARGS = {
  ...OUTPUT_ARGS,
  'with-sitemaps': { type: 'boolean' as const, default: false, description: 'Include sitemaps for each owned site' },
  'owner-only': { type: 'boolean' as const, default: false, description: 'Filter to permissionLevel=siteOwner' },
}

async function runListSites(args: Record<string, unknown>): Promise<void> {
  applyOutputMode(args)
  const ctx = await createCommandContext({ needsAuth: true })

  const ownerOnly = Boolean(args['owner-only'])

  if (args['with-sitemaps']) {
    const all = await fetchSitesWithSitemaps(ctx.client!)
    const sites = ownerOnly ? all.filter(s => s.permissionLevel === 'siteOwner') : all
    if (args.json) {
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
}

const listCommand = defineCommand({
  meta: { name: 'list', description: 'List GSC sites (alias of bare `sites`)' },
  args: LIST_ARGS,
  async run({ args }) {
    await runListSites(args as Record<string, unknown>)
  },
})

export const sitesCommand = defineCommand({
  meta: sitesCommandMeta,
  args: LIST_ARGS,
  subCommands: {
    'list': listCommand,
    'add': addCommand,
    'delete': deleteCommand,
    'get': getCommand,
    'verify-token': verifyTokenCommand,
    'verify': verifyCommand,
    'verify-list': verifyListCommand,
    'verify-get': verifyGetCommand,
    'unverify': unverifyCommand,
  },
  async run({ args }) {
    await runListSites(args as Record<string, unknown>)
  },
})

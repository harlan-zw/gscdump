import type { GscdumpV1Client } from '@gscdump/sdk/v1'
import process from 'node:process'
import { createGscdumpV1Client } from '@gscdump/sdk/v1'
import { getCloudAccount, parseAuthentication, resolveAuthentication } from './auth-state'
import { loadConfig } from './config'
import { resolveCliEnvironment } from './environment'
import { logger } from './utils'

export const HOSTED_ARGS = {
  'site': { type: 'string' as const, alias: 's', description: 'Site URL (e.g., example.com, sc-domain:example.com, or https://example.com/)' },
  'api-root': { type: 'string' as const, description: 'Hosted API root; defaults to saved cloud authentication or https://gscdump.com/api' },
  'api-key': { type: 'string' as const, description: 'Hosted API key; defaults to GSCDUMP_API_KEY' },
}

export interface HostedSite {
  siteId: string
  siteUrl: string
}

export type HostedSiteMatch
  = | { kind: 'found', site: HostedSite }
    | { kind: 'missing', target: string | undefined, sites: HostedSite[] }
    | { kind: 'ambiguous', target: string, matches: HostedSite[] }

/** `sc-domain:example.com`, `https://example.com/` and `example.com` share one key. */
function siteKey(value: string): string | undefined {
  const text = value.trim()
  if (text.startsWith('sc-domain:'))
    return text.slice('sc-domain:'.length).toLowerCase().replace(/\.$/, '') || undefined
  const url = URL.parse(/^[a-z][a-z\d+.-]*:\/\//i.test(text) ? text : `https://${text}`)
  if (!url || !url.hostname)
    return undefined
  return `${url.hostname.toLowerCase()}${url.pathname.replace(/\/+$/, '')}`
}

/** Match a `--site` value against the hosted account's Sites. */
export function matchHostedSite(sites: readonly HostedSite[], target: string | undefined): HostedSiteMatch {
  if (!target) {
    return sites.length === 1
      ? { kind: 'found', site: sites[0]! }
      : { kind: 'missing', target, sites: [...sites] }
  }
  const exact = sites.find(site => site.siteId === target || site.siteUrl === target)
  if (exact)
    return { kind: 'found', site: exact }
  const key = siteKey(target)
  const matches = key === undefined ? [] : sites.filter(site => siteKey(site.siteUrl) === key)
  if (matches.length === 1)
    return { kind: 'found', site: matches[0]! }
  if (matches.length > 1)
    return { kind: 'ambiguous', target, matches }
  return { kind: 'missing', target, sites: [...sites] }
}

function describeMatchFailure(match: Exclude<HostedSiteMatch, { kind: 'found' }>): string {
  if (match.kind === 'ambiguous')
    return `Multiple hosted Sites match "${match.target}": ${match.matches.map(site => site.siteUrl).join(', ')}. Pass the exact Site URL with --site.`
  if (match.sites.length === 0)
    return 'Your hosted account has no Sites. Add a Site at https://gscdump.com.'
  const available = `Hosted Sites: ${match.sites.map(site => site.siteUrl).join(', ')}.`
  return match.target
    ? `No hosted Site matches "${match.target}". ${available}`
    : `Pass --site. ${available}`
}

function fail(message: string): never {
  logger.error(message)
  process.exit(1)
}

/**
 * Resolve hosted authentication and a `--site` value to a v1 client and a hosted Site.
 * A local-only user gets one line that names the hosted requirement and `localAlternative`.
 */
export async function resolveHostedSite(
  args: Record<string, unknown>,
  command: { name: string, localAlternative: string },
): Promise<{ client: GscdumpV1Client, site: HostedSite }> {
  const environment = resolveCliEnvironment().values
  const authentication = args['api-key']
    ? parseAuthentication({ _tag: 'Cloud', apiKey: args['api-key'], apiRoot: String(args['api-root'] || environment.GSCDUMP_API_ROOT || 'https://gscdump.com/api') })
    : await resolveAuthentication()
  if (authentication._tag !== 'Cloud')
    fail(`\`gscdump ${command.name}\` needs hosted authentication. Run \`gscdump auth login --mode cloud\` or pass --api-key. With local authentication, ${command.localAlternative}.`)
  if (args['api-root'] && String(args['api-root']).replace(/\/+$/, '') !== authentication.apiRoot)
    fail('The API root changed. Pass --api-key for the new API root.')
  const target = args.site ? String(args.site) : (await loadConfig()).defaultSite
  const account = await getCloudAccount(authentication)
  const match = matchHostedSite(account.sites, target)
  if (match.kind !== 'found')
    fail(describeMatchFailure(match))
  return {
    client: createGscdumpV1Client({ apiRoot: authentication.apiRoot, credential: authentication.apiKey }),
    site: match.site,
  }
}

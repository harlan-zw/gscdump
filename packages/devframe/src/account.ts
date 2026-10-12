import type { GscdumpCredential } from './credential'
import type { SiteSummary } from './shared/protocol'
import { z } from 'zod'
import { cliHeadersOf } from './credential'
import { hostOf } from './source'

const accountSchema = z.object({
  sites: z.array(z.object({
    siteId: z.string(),
    siteUrl: z.string(),
    oldestDateSynced: z.string().nullable().optional(),
    newestDateSynced: z.string().nullable().optional(),
  }).passthrough()),
}).passthrough()

export type AccountRead
  = | { _tag: 'Ok', sites: SiteSummary[] }
    | { _tag: 'Rejected' }
    | { _tag: 'Unavailable', message: string }

/** Read the credential holder's Sites from `/api/cli/me`, the route the CLI uses. */
export async function readAccount(credential: GscdumpCredential, request: typeof fetch): Promise<AccountRead> {
  const response = await request(`${credential.apiRoot}/cli/me`, {
    headers: cliHeadersOf(credential),
    redirect: 'error',
    signal: AbortSignal.timeout(30_000),
  }).catch((error: unknown) => error instanceof Error ? error : new Error(String(error)))
  if (response instanceof Error)
    return { _tag: 'Unavailable', message: `gscdump.com did not answer: ${response.message}` }
  if (response.status === 401 || response.status === 403)
    return { _tag: 'Rejected' }
  if (!response.ok)
    return { _tag: 'Unavailable', message: `gscdump.com answered ${response.status}.` }
  const parsed = accountSchema.safeParse(await response.json().catch(() => null))
  if (!parsed.success)
    return { _tag: 'Unavailable', message: 'gscdump.com returned account data this version cannot read.' }
  return {
    _tag: 'Ok',
    sites: parsed.data.sites.map(site => ({
      siteId: site.siteId,
      siteUrl: site.siteUrl,
      host: hostOf(site.siteUrl) ?? site.siteUrl,
      oldestDate: site.oldestDateSynced ?? null,
      newestDate: site.newestDateSynced ?? null,
    })),
  }
}

export type SiteMatch
  = | { _tag: 'Found', site: SiteSummary }
    | { _tag: 'Missing', target: string | null }
    | { _tag: 'Ambiguous', target: string, matches: SiteSummary[] }

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

/**
 * Match a configured Site (a Site ID, a Site URL, or a host) against the
 * holder's Sites. With no target, a holder with one Site gets that Site.
 */
export function matchSite(sites: readonly SiteSummary[], target: string | null): SiteMatch {
  if (!target)
    return sites.length === 1 ? { _tag: 'Found', site: sites[0]! } : { _tag: 'Missing', target: null }
  const exact = sites.find(site => site.siteId === target || site.siteUrl === target)
  if (exact)
    return { _tag: 'Found', site: exact }
  const key = siteKey(target)
  const matches = key === undefined ? [] : sites.filter(site => siteKey(site.siteUrl) === key)
  if (matches.length === 1)
    return { _tag: 'Found', site: matches[0]! }
  if (matches.length > 1)
    return { _tag: 'Ambiguous', target, matches }
  return { _tag: 'Missing', target }
}

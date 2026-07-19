// GSC property matching primitives. Cross-property domain/sc-domain matching
// + verified-permission filtering + best-property picker.
//
// Used at the boundary between local site URLs and the GSC property list,
// e.g. onboarding ("does this hostname have a GSC property?"), partner
// reconnect ("which property does the user want to track?"), and partner
// auto-linking.

import { parseGscSiteUrl } from './site-url'

export interface GscPropertyCandidate {
  siteUrl?: string | null
  permissionLevel?: string | null
}

const VERIFIED_PERMISSIONS = new Set(['siteOwner', 'siteFullUser', 'siteRestrictedUser'])

export function isVerifiedGscProperty(property?: GscPropertyCandidate | null): boolean {
  return !!property?.permissionLevel && VERIFIED_PERMISSIONS.has(property.permissionLevel)
}

export function isVerifiedGscPermission(level: string | null | undefined): boolean {
  return !!level && VERIFIED_PERMISSIONS.has(level)
}

const stripWww = (d: string): string => d.replace(/^www\./, '')

/**
 * Does `propertyUrl` cover `targetDomain`? Matches sc-domain (exact or
 * subdomain) and URL-prefix (host equality) without scheme/www noise.
 */
export function gscPropertyMatchesTarget(targetDomain: string, propertyUrl: string | null | undefined): boolean {
  if (!propertyUrl)
    return false

  const cleanTarget = stripWww(targetDomain)
  const parsed = parseGscSiteUrl(propertyUrl)
  if (parsed.isDomain)
    return cleanTarget === parsed.hostname || cleanTarget.endsWith(`.${parsed.hostname}`)

  const match = propertyUrl.match(/^https?:\/\/([^/]+)/)
  return !!match && stripWww(match[1]!.toLowerCase()) === cleanTarget
}

/**
 * Convenience: match `siteUrl` against `gscSiteUrl` directly (extracts the
 * hostname from `siteUrl` first).
 */
export function matchGscSite(siteUrl: string | null | undefined, gscSiteUrl: string | null | undefined): boolean {
  if (!siteUrl || !gscSiteUrl)
    return false
  const getHostname = (url: string): string => {
    if (url.startsWith('sc-domain:'))
      return url.replace('sc-domain:', '')
    try {
      return new URL(url).hostname
    }
    catch {
      return url
    }
  }
  return gscPropertyMatchesTarget(getHostname(siteUrl), gscSiteUrl)
}

/**
 * Pick the best GSC property for a hostname from a candidate list. "Best":
 *   1. Verified Domain property (widest + readable)
 *   2. Verified URL-prefix property (narrower + readable)
 *   3. Unverified Domain property (returned as a fallback so callers can
 *      surface the verification gap to the user)
 *   4. Unverified URL-prefix property (same caveat)
 *
 * Without this ranking, naively picking the first match would register an
 * unverified property and leave the site stuck with zero data.
 */
export function pickBestGscProperty<T extends GscPropertyCandidate>(
  origin: string,
  availableSites: readonly T[],
): T | undefined {
  const matches = availableSites.filter(p => matchGscSite(origin, p.siteUrl))
  if (!matches.length)
    return undefined

  const isDomain = (p: T): boolean => !!p.siteUrl?.startsWith('sc-domain:')
  const isHttps = (p: T): boolean => !!p.siteUrl?.startsWith('https://')
  const pickTier = (pool: readonly T[]): T | undefined => pool.find(isDomain) ?? pool.find(isHttps) ?? pool[0]
  const verified = matches.filter(p => isVerifiedGscPermission(p.permissionLevel))
  const pool = verified.length ? verified : matches

  // A subdomain's own property outranks a parent sc-domain property that only
  // matched through domain coverage. Within a host, prefer domain then HTTPS
  // then HTTP so an API response ordered lexicographically cannot select a
  // near-empty legacy HTTP prefix over the live HTTPS property.
  const originHost = stripWww(parseGscSiteUrl(origin).hostname.toLowerCase())
  const exact = pool.filter((property) => {
    if (!property.siteUrl)
      return false
    return stripWww(parseGscSiteUrl(property.siteUrl).hostname.toLowerCase()) === originHost
  })
  return pickTier(exact.length ? exact : pool)
}

/**
 * Richer best-property selection that also returns the matched domain and
 * URL candidates separately, so callers can show "we matched on X domain
 * property and Y URL-prefix property" diagnostics.
 */
export function findBestGscProperty<T extends GscPropertyCandidate>(targetDomain: string, properties: readonly T[]): { matchedSite: T | null, domainProperty: T | null, urlProperty: T | null } {
  const cleanTarget = stripWww(targetDomain)

  const domainProperty = properties.find((property) => {
    if (!property.siteUrl)
      return false
    const parsed = parseGscSiteUrl(property.siteUrl)
    if (!parsed.isDomain)
      return false
    return cleanTarget === parsed.hostname || cleanTarget.endsWith(`.${parsed.hostname}`)
  })

  const urlProperty = properties.find((property) => {
    if (!property.siteUrl)
      return false
    const match = property.siteUrl.match(/^https?:\/\/([^/]+)/)
    return match && stripWww(match[1]!.toLowerCase()) === cleanTarget
  })

  const matchedSite = isVerifiedGscProperty(domainProperty)
    ? domainProperty
    : isVerifiedGscProperty(urlProperty)
      ? urlProperty
      : (domainProperty || urlProperty)

  return {
    matchedSite: matchedSite ?? null,
    domainProperty: domainProperty ?? null,
    urlProperty: urlProperty ?? null,
  }
}

export function findExactGscProperty<T extends GscPropertyCandidate>(propertyUrl: string, properties: readonly T[]): T | null {
  return properties.find(property => property.siteUrl === propertyUrl) ?? null
}

export function formatGscPropertyCandidates(candidates: ReadonlyArray<GscPropertyCandidate | null | undefined>): string {
  return candidates
    .filter((c): c is GscPropertyCandidate => !!c)
    .map(property => `${property.siteUrl} (${property.permissionLevel})`)
    .join(', ')
}

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

/** One Site the resolver may pick. `inStore` marks a Site with local data. */
export interface SiteCandidate {
  siteUrl: string
  inStore?: boolean
}

/**
 * Outcome of matching user input to a Site. `covered-by-parent` means a
 * domain property covers the input, but the input names a narrower scope
 * (a subdomain or a path). Callers must never swap one for the other
 * silently: the parent Site holds more data than the input asked for.
 */
export type SiteResolution
  = | { kind: 'resolved', siteUrl: string, via: 'exact' | 'host' }
    | { kind: 'ambiguous', input: string, candidates: string[] }
    | { kind: 'covered-by-parent', input: string, parent: string }
    | { kind: 'not-found', input: string, known: string[] }

interface SiteKey {
  /** Lowercase host, `www.` kept. */
  host: string
  /** Lowercase host without `www.`. */
  bareHost: string
  /** Lowercase path without a trailing slash; empty for the root. */
  path: string
  domain: boolean
  https: boolean
}

const INPUT_SCHEME_RE = /^[a-z][\w+.-]*:\/\//i
const SC_DOMAIN_PREFIX_RE = /^sc-domain:/i
const TRAILING_SLASHES_RE = /\/+$/

function parseSiteKey(value: string): SiteKey | null {
  const trimmed = value.trim()
  if (!trimmed)
    return null
  if (SC_DOMAIN_PREFIX_RE.test(trimmed)) {
    const host = trimmed.replace(SC_DOMAIN_PREFIX_RE, '').replace(TRAILING_SLASHES_RE, '').toLowerCase()
    return host ? { host, bareHost: stripWww(host), path: '', domain: true, https: false } : null
  }
  const https = /^https:\/\//i.test(trimmed)
  const rest = trimmed.replace(INPUT_SCHEME_RE, '').split(/[?#]/)[0]!
  const slash = rest.indexOf('/')
  const host = (slash === -1 ? rest : rest.slice(0, slash)).toLowerCase()
  if (!host)
    return null
  const path = slash === -1 ? '' : rest.slice(slash).replace(TRAILING_SLASHES_RE, '').toLowerCase()
  return { host, bareHost: stripWww(host), path, domain: false, https }
}

function sameSiteUrl(a: string, b: string): boolean {
  const normalize = (value: string): string => value.trim().replace(TRAILING_SLASHES_RE, '').toLowerCase()
  return normalize(a) === normalize(b)
}

/**
 * Resolve what a person typed for `--site` to one Site from `candidates`.
 *
 * - An exact Site URL match wins, ignoring case and a trailing slash.
 * - Otherwise the input matches on its Site root: scheme, `www.`, case and
 *   a trailing slash are ignored. Hosts compare whole, never as substrings.
 * - Among several root matches, a Site with Store data wins, then a domain
 *   property, then the one whose `www.` matches the input, then HTTPS.
 * - A domain property that only covers the input (a subdomain or a path)
 *   returns `covered-by-parent`.
 */
export function resolveSiteInput(input: string, candidates: readonly SiteCandidate[]): SiteResolution {
  const unique = new Map<string, SiteCandidate>()
  for (const candidate of candidates) {
    const prior = unique.get(candidate.siteUrl)
    unique.set(candidate.siteUrl, { siteUrl: candidate.siteUrl, inStore: !!(prior?.inStore || candidate.inStore) })
  }
  const pool = [...unique.values()]
  const known = pool.map(candidate => candidate.siteUrl)

  const exact = pool.filter(candidate => sameSiteUrl(candidate.siteUrl, input))
  if (exact.length === 1)
    return { kind: 'resolved', siteUrl: exact[0]!.siteUrl, via: 'exact' }
  if (exact.length > 1) {
    const verbatim = exact.find(candidate => candidate.siteUrl === input.trim())
    return verbatim
      ? { kind: 'resolved', siteUrl: verbatim.siteUrl, via: 'exact' }
      : { kind: 'ambiguous', input, candidates: exact.map(candidate => candidate.siteUrl) }
  }

  const key = parseSiteKey(input)
  if (!key)
    return { kind: 'not-found', input, known }
  const keyed = pool.flatMap((candidate) => {
    const candidateKey = parseSiteKey(candidate.siteUrl)
    return candidateKey ? [{ candidate, key: candidateKey }] : []
  })

  const matches = keyed.filter(entry => entry.key.bareHost === key.bareHost && entry.key.path === key.path)
  if (matches.length > 0) {
    const ranked = narrow(matches, [
      entry => !!entry.candidate.inStore,
      entry => entry.key.domain,
      entry => entry.key.host === key.host,
      entry => entry.key.https,
    ])
    return ranked.length === 1
      ? { kind: 'resolved', siteUrl: ranked[0]!.candidate.siteUrl, via: 'host' }
      : { kind: 'ambiguous', input, candidates: ranked.map(entry => entry.candidate.siteUrl) }
  }

  // A root Site for the same host covers a path input; a domain property
  // covers every subdomain. Pick the closest parent.
  const parents = keyed.filter(entry =>
    (entry.key.bareHost === key.bareHost && entry.key.path !== '' && key.path.startsWith(`${entry.key.path}/`))
    || (entry.key.bareHost === key.bareHost && entry.key.path === '')
    || (entry.key.domain && key.bareHost.endsWith(`.${entry.key.bareHost}`)),
  )
  if (parents.length > 0) {
    const specificity = (entry: { key: SiteKey }): number => entry.key.bareHost.length + entry.key.path.length
    const closest = Math.max(...parents.map(specificity))
    const [parent] = narrow(parents.filter(entry => specificity(entry) === closest), [
      entry => !!entry.candidate.inStore,
      entry => entry.key.domain,
      entry => entry.key.host === key.host,
      entry => entry.key.https,
    ])
    return { kind: 'covered-by-parent', input, parent: parent!.candidate.siteUrl }
  }

  return { kind: 'not-found', input, known }
}

/** Keep the entries that pass the first rule any entry passes, rule by rule. */
function narrow<T>(entries: readonly T[], rules: ReadonlyArray<(entry: T) => boolean>): T[] {
  let pool = [...entries]
  for (const rule of rules) {
    const kept = pool.filter(rule)
    if (kept.length > 0)
      pool = kept
    if (pool.length === 1)
      break
  }
  return pool
}

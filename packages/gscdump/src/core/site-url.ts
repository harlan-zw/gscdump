// Pure helper for normalising GSC property identifiers. Safe in both server
// and client bundles — no Node or H3 dependencies. GSC properties come in two
// shapes:
//   - sc-domain:example.com   (Domain property)
//   - https://example.com/    (URL-prefix property)
// Some hosts also store URL-prefix properties without a scheme (e.g. bare
// `example.com`), so URL parsing is wrapped in try/catch — a malformed entry
// must not 500 the whole sites list.

export interface ParsedGscSiteUrl {
  /** Original, canonical GSC property URL. */
  label: string
  /** Bare hostname, stripped of protocol / sc-domain prefix / path. */
  hostname: string
  /** Human-friendly label: scheme stripped, trailing slash trimmed, path retained. */
  displayLabel: string
  propertyType: 'domain' | 'url-prefix'
  isDomain: boolean
}

const SCHEME_RE = /^(sc-domain:|https?:\/\/)/

export function parseGscSiteUrl(siteUrl: string): ParsedGscSiteUrl {
  const isDomain = siteUrl.startsWith('sc-domain:')
  let hostname = siteUrl
  if (isDomain) {
    hostname = siteUrl.slice('sc-domain:'.length)
  }
  else {
    try {
      hostname = new URL(siteUrl).hostname
    }
    catch {
      hostname = siteUrl
    }
  }
  const displayLabel = siteUrl.replace(SCHEME_RE, '').replace(/\/$/, '')
  return {
    label: siteUrl,
    hostname,
    displayLabel,
    propertyType: isDomain ? 'domain' : 'url-prefix',
    isDomain,
  }
}

/**
 * Normalize a user-input URL/hostname into a canonical registration target.
 * Returns lowercase hostname stripped of protocol, or null if unparseable.
 */
export function normalizeRegistrationTarget(inputUrl: string): string | null {
  const trimmed = inputUrl.trim()
  if (!trimmed)
    return null

  const inputParsed = parseGscSiteUrl(trimmed)
  if (inputParsed.isDomain)
    return inputParsed.hostname.toLowerCase()

  const urlMatch = trimmed.match(/^(?:https?:\/\/)?([^/]+)/)
  return urlMatch?.[1]?.toLowerCase() ?? null
}

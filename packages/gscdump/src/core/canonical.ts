// Canonical comparison: declared (`userCanonical`) vs Google-chosen
// (`googleCanonical`).
//
// The historical predicate was byte-exact string inequality with both-non-null
// guards, duplicated across five SQL sites. Nothing normalised the strings, so a
// trailing slash, an `http`/`https` difference, a `www.` prefix or host casing
// all counted as "Google overrode your canonical". Measured on production that
// was 12% of reported mismatches fleet-wide and 100% on at least one site — and
// because the count drives a stage verdict, formatting noise could change a
// site's headline diagnosis.
//
// It also flattened a genuinely serious case: a canonical pointing at ANOTHER
// HOST (syndication, hijack, botched migration) carried exactly the same
// severity and label as a trailing slash.
//
// So the comparison returns a KIND, not a boolean.

export type CanonicalDifferenceKind
  /** Absent on either side, or the same resource once spelling is normalised. */
  = | 'none'
  /** Same resource, different spelling: trailing slash, scheme, `www.`, host case. */
    | 'formatting'
  /** Same host, genuinely different resource. The ordinary "Google overrode you". */
    | 'path'
  /** Different host. Rare and usually serious — never fold this into `path`. */
    | 'cross_domain'

interface CanonicalParts {
  host: string
  /** Path + query. Case-preserved: paths are case-sensitive on most servers. */
  resource: string
}

/**
 * Split into the pieces the comparison cares about, normalising ONLY the parts
 * that never change which resource is addressed:
 *   - scheme dropped entirely (http/https address the same document)
 *   - host lowercased, `www.` and any port removed
 *   - one trailing slash removed from the path
 * The query string is deliberately KEPT — it can select different content.
 * The fragment is dropped: Google resolves `#anchor` to the parent document.
 *
 * Returns `undefined` for input that has no recognisable host, so callers can
 * fall back to raw comparison rather than throw. Google returns these values
 * verbatim and we never want a malformed one to break ingest.
 */
function parseCanonical(value: string): CanonicalParts | undefined {
  const match = /^[A-Z][A-Z0-9+.-]*:\/\/([^/?#]+)([^#]*)/i.exec(value)
  if (!match)
    return undefined
  const host = match[1]!.toLowerCase().replace(/^www\./, '').replace(/:\d+$/, '')
  if (!host)
    return undefined
  const raw = match[2] ?? ''
  const [path = '', query = ''] = raw.split(/\?(.*)/s)
  const trimmed = path.replace(/\/$/, '')
  return { host, resource: (trimmed || '/') + (query ? `?${query}` : '') }
}

/**
 * Classify how a page's declared canonical differs from the one Google chose.
 *
 * Both values come straight from the URL Inspection API. A missing value on
 * either side is `none` — it preserves the both-non-null guard of the predicate
 * this replaces, and "Google has no opinion yet" is not a mismatch.
 */
export function classifyCanonicalDifference(
  userCanonical: string | null | undefined,
  googleCanonical: string | null | undefined,
): CanonicalDifferenceKind {
  if (!userCanonical || !googleCanonical)
    return 'none'
  if (userCanonical === googleCanonical)
    return 'none'

  const user = parseCanonical(userCanonical)
  const google = parseCanonical(googleCanonical)
  // Unparseable on either side: they already differ as raw strings, and we
  // cannot say the hosts differ, so report the conservative non-noise kind.
  if (!user || !google)
    return 'path'

  if (user.host !== google.host)
    return 'cross_domain'
  return user.resource === google.resource ? 'formatting' : 'path'
}

/**
 * Does this pair represent a canonical problem worth counting?
 *
 * `formatting` differences are excluded: they are the same resource spelled two
 * ways, and counting them is what inflated the headline number. Surface them
 * separately if they matter, but never in the mismatch count.
 */
export function isCanonicalMismatch(
  userCanonical: string | null | undefined,
  googleCanonical: string | null | undefined,
): boolean {
  const kind = classifyCanonicalDifference(userCanonical, googleCanonical)
  return kind === 'path' || kind === 'cross_domain'
}

// Tenant identity helpers. Encodes GSC site URLs (which contain characters
// that collide with object-key path separators) into a deterministic,
// filesystem-safe form.

const SC_DOMAIN_RE = /^sc-domain:/
const PROTOCOL_RE = /^https?:\/\//
const NON_ID_RE = /[^\w.-]/g
const TRAILING_UNDERSCORES_RE = /_+$/

export function encodeSiteId(siteUrl: string): string {
  return siteUrl
    .replace(SC_DOMAIN_RE, 'd_')
    .replace(PROTOCOL_RE, 'h_')
    .replace(NON_ID_RE, '_')
    .replace(TRAILING_UNDERSCORES_RE, '')
}

/**
 * Best-effort inverse of `encodeSiteId` for the common prefixes. Lossy
 * (`encodeSiteId` collapses non-word chars to `_` and strips trailing
 * underscores), but round-trips domain properties + https origins cleanly —
 * the only two shapes GSC hands out in practice.
 *
 * Returns the input unchanged when neither prefix is recognised, so callers
 * can pass through canonical site URLs without branching.
 */
export function decodeSiteId(encoded: string): string {
  if (encoded.startsWith('d_'))
    return `sc-domain:${encoded.slice(2)}`
  if (encoded.startsWith('h_'))
    return `https://${encoded.slice(2)}/`
  return encoded
}

/**
 * Normalize a siteUrl to the form Google APIs expect: domain properties get
 * the `sc-domain:` prefix added if missing, URL properties pass through.
 * Idempotent — safe to call on already-prefixed values.
 */
export function normalizeSiteUrl(siteUrl: string): string {
  if (siteUrl.startsWith('sc-domain:'))
    return siteUrl
  if (siteUrl.startsWith('http://') || siteUrl.startsWith('https://'))
    return siteUrl
  return `sc-domain:${siteUrl}`
}

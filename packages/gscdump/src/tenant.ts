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

// URL helpers for cross-property matching.
//
// `gscdump/normalize` collapses URLs to pathname (storage indexing key).
// This module produces an equivalence key for matching the *same* page across
// protocol / www / casing / trailing-slash variations — used when joining
// sitemap URLs against GSC URLs and similar.

/**
 * Equivalence key for matching two URLs that point at the same resource
 * across protocol (http/https), www. prefix, trailing slash, and casing.
 * Returns `null` for unparseable input.
 *
 * Example: `https://www.Example.com/Foo/` → `example.com/foo`
 */
export function urlMatchKey(url: string): string | null {
  const u = URL.parse(url)
  if (!u)
    return null
  return [
    u.hostname.replace(/^www\./, ''),
    u.pathname.replace(/\/$/, '') || '/',
  ].join('').toLowerCase()
}

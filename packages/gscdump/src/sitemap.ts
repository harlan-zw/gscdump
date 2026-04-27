// Sitemap discovery via robots.txt + common paths.
//
// Distinct from sitemap *parsing* (which lives in CLI). This is a fetch-only
// best-effort lookup for "does this site advertise a sitemap?".

const FETCH_TIMEOUT_MS = 10_000
const COMMON_PATHS = ['/sitemap.xml', '/sitemap_index.xml']
const SITEMAP_DIRECTIVE_RE = /^Sitemap:\s*(\S+)/im

export interface DiscoverSitemapOptions {
  /** User-Agent sent on the discovery requests. */
  userAgent?: string
  /** AbortSignal threaded through fetches; defaults to a 10s timeout per call. */
  signal?: AbortSignal
}

/**
 * Try to discover a sitemap for `domain` by checking robots.txt for a
 * `Sitemap:` directive, then a small set of common paths. Returns the first
 * URL that responds with a 2xx, or `null`.
 */
export async function discoverSitemap(
  domain: string,
  options: DiscoverSitemapOptions = {},
): Promise<string | null> {
  const userAgent = options.userAgent ?? 'gscdump sitemap fetcher'
  const baseUrl = `https://${domain}`

  const signalFor = (): AbortSignal => options.signal ?? AbortSignal.timeout(FETCH_TIMEOUT_MS)

  const robotsRes = await fetch(`${baseUrl}/robots.txt`, {
    headers: { 'User-Agent': userAgent },
    signal: signalFor(),
  }).catch(() => null)

  if (robotsRes?.ok) {
    const text = await robotsRes.text()
    const match = text.match(SITEMAP_DIRECTIVE_RE)
    if (match?.[1]) {
      const checkRes = await fetch(match[1], {
        method: 'HEAD',
        signal: signalFor(),
      }).catch(() => null)
      if (checkRes?.ok)
        return match[1]
    }
  }

  for (const path of COMMON_PATHS) {
    const url = `${baseUrl}${path}`
    const res = await fetch(url, {
      method: 'HEAD',
      headers: { 'User-Agent': userAgent },
      signal: signalFor(),
    }).catch(() => null)
    if (res?.ok)
      return url
  }

  return null
}

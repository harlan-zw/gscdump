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

const LOC_RE = /<loc>([^<]+)<\/loc>/gi
const SITEMAPINDEX_RE = /<sitemapindex\b/i

export interface FetchSitemapUrlsOptions extends DiscoverSitemapOptions {
  /** Maximum nested sitemap-index depth to follow. Default 3. */
  maxDepth?: number
  /** Stop after this many URLs (across all nested sitemaps). Default unlimited. */
  limit?: number
}

/**
 * Fetch a sitemap (or sitemap index) and return the list of `<loc>` URLs.
 * Sitemap-index files are followed up to `maxDepth` levels. Duplicates are
 * de-duplicated. The XML parser is regex-based — it handles the common
 * `<loc>https://...</loc>` shape but doesn't validate the schema.
 */
export async function fetchSitemapUrls(
  sitemapUrl: string,
  options: FetchSitemapUrlsOptions = {},
): Promise<string[]> {
  const userAgent = options.userAgent ?? 'gscdump sitemap fetcher'
  const maxDepth = options.maxDepth ?? 3
  const limit = options.limit
  const signalFor = (): AbortSignal => options.signal ?? AbortSignal.timeout(FETCH_TIMEOUT_MS)
  const seen = new Set<string>()
  const out: string[] = []

  const visit = async (url: string, depth: number): Promise<void> => {
    if (limit != null && out.length >= limit)
      return
    if (depth > maxDepth)
      return
    const res = await fetch(url, {
      headers: { 'User-Agent': userAgent },
      signal: signalFor(),
    })
    if (!res.ok)
      throw new Error(`Fetch ${url} failed: ${res.status}`)
    const text = await res.text()
    const isIndex = SITEMAPINDEX_RE.test(text)
    if (isIndex) {
      for (const match of text.matchAll(LOC_RE)) {
        if (limit != null && out.length >= limit)
          return
        const child = match[1].trim()
        if (!child)
          continue
        await visit(child, depth + 1)
      }
      return
    }
    for (const match of text.matchAll(LOC_RE)) {
      const u = match[1].trim()
      if (!u)
        continue
      if (seen.has(u))
        continue
      seen.add(u)
      out.push(u)
      if (limit != null && out.length >= limit)
        return
    }
  }

  await visit(sitemapUrl, 0)
  return out
}

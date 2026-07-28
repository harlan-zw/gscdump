import type { DiscoverSitemapOptions, FetchSitemapUrlsOptions } from './sitemap'

/**
 * Keep the v1 root exports without making every `gscdump` import initialize
 * Nuxt Sitemap. The parser remains isolated behind the `./sitemap` entry.
 */
export async function discoverSitemap(
  site: string,
  options: DiscoverSitemapOptions = {},
): Promise<string | null> {
  const sitemap = await import('./sitemap')
  return sitemap.discoverSitemap(site, options)
}

export async function fetchSitemapUrls(
  sitemapUrl: string,
  options: FetchSitemapUrlsOptions = {},
): Promise<string[]> {
  const sitemap = await import('./sitemap')
  return sitemap.fetchSitemapUrls(sitemapUrl, options)
}

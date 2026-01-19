import type { GoogleSearchConsoleClient } from '../core/client'
import type { ApiSite, ApiSitemap, RequiredNonNullable, Site } from '../core/types'

/**
 * Fetches all sites the authenticated user has access to in Google Search Console.
 */
export async function fetchSites(client: GoogleSearchConsoleClient): Promise<ApiSite[]> {
  return client.sites.list().then(res => res?.siteEntry || [])
}

/**
 * Fetches sitemaps for a site.
 */
export async function fetchSitemaps(client: GoogleSearchConsoleClient, siteUrl: string): Promise<ApiSitemap[]> {
  return client.sitemaps.list(siteUrl).then(res => res.sitemap || [])
}

/**
 * Gets details for a specific sitemap.
 */
export async function fetchSitemap(client: GoogleSearchConsoleClient, siteUrl: string, feedpath: string): Promise<ApiSitemap> {
  return client.sitemaps.get(siteUrl, feedpath)
}

/**
 * Submits a sitemap to Google Search Console.
 */
export async function submitSitemap(client: GoogleSearchConsoleClient, siteUrl: string, feedpath: string): Promise<void> {
  return client.sitemaps.submit(siteUrl, feedpath)
}

/**
 * Deletes a sitemap from Google Search Console.
 */
export async function deleteSitemap(client: GoogleSearchConsoleClient, siteUrl: string, feedpath: string): Promise<void> {
  return client.sitemaps.delete(siteUrl, feedpath)
}

/**
 * Fetches all verified sites with their sitemaps from Google Search Console.
 */
export async function fetchSitesWithSitemaps(client: GoogleSearchConsoleClient): Promise<(Site & { sitemaps: RequiredNonNullable<ApiSitemap>[] })[]> {
  const sites = (await client.sites.list().then(res => res.siteEntry || []))
    .filter((s): s is Site => !!s.siteUrl && s.permissionLevel !== 'siteUnverifiedUser')

  return Promise.all(sites.map(async (site) => {
    const sitemaps = site.permissionLevel === 'siteOwner'
      ? await client.sitemaps.list(site.siteUrl).then(res => (res.sitemap || []) as RequiredNonNullable<ApiSitemap>[])
      : []
    return { ...site, sitemaps }
  }))
}

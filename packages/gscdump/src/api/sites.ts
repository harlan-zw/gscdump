import type { GoogleSearchConsoleClient } from '../core/client'
import type { ApiSite, ApiSitemap, Site } from '../core/types'

/**
 * Fetches all sites the authenticated user has access to in Google Search Console.
 */
export async function fetchSites(client: GoogleSearchConsoleClient): Promise<ApiSite[]> {
  return client.sites()
}

/**
 * Fetches all verified sites with their sitemaps from Google Search Console.
 */
export async function fetchSitesWithSitemaps(client: GoogleSearchConsoleClient): Promise<(Site & { sitemaps: ApiSitemap[] })[]> {
  const allSites = await client.sites()
  const sites = allSites.filter((s): s is Site => !!s.siteUrl && s.permissionLevel !== 'siteUnverifiedUser')

  // sitemaps.list is callable by any verified user (owner/full/restricted);
  // restricted users still get the list, just not write ops. Fall back to []
  // on permission errors so one inaccessible property doesn't fail the batch.
  return Promise.all(sites.map(async (site) => {
    const sitemaps = await client.sitemaps.list(site.siteUrl).catch(() => [] as ApiSitemap[])
    return { ...site, sitemaps }
  }))
}

/**
 * Fetches all sitemaps for a site.
 */
export async function fetchSitemaps(client: GoogleSearchConsoleClient, siteUrl: string): Promise<ApiSitemap[]> {
  return client.sitemaps.list(siteUrl)
}

/**
 * Fetches a specific sitemap.
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
 * Add a property to the user's Search Console account.
 *
 * Note: this only registers the property in an unverified state. Ownership
 * must be proven via the Site Verification API (see `verifySite`) before any
 * data is accessible.
 */
export async function addSite(client: GoogleSearchConsoleClient, siteUrl: string): Promise<void> {
  return client.sites.add(siteUrl)
}

/**
 * Remove a property from the user's Search Console account.
 */
export async function deleteSite(client: GoogleSearchConsoleClient, siteUrl: string): Promise<void> {
  return client.sites.delete(siteUrl)
}

import type { GoogleSearchConsoleClient } from '../core/client'
import type { ApiSite, ApiSitemap, Site } from '../core/types'
import { runSequentialBatch } from './batch'

export interface FetchSitesWithSitemapsOptions {
  /** Maximum concurrent sitemap-list requests. Defaults to 4. */
  concurrency?: number
}

/**
 * Fetches all sites the authenticated user has access to in Google Search Console.
 */
export async function fetchSites(client: GoogleSearchConsoleClient): Promise<ApiSite[]> {
  return client.sites()
}

/**
 * Fetches all verified sites with their sitemaps from Google Search Console.
 */
export async function fetchSitesWithSitemaps(
  client: GoogleSearchConsoleClient,
  options: FetchSitesWithSitemapsOptions = {},
): Promise<(Site & { sitemaps: ApiSitemap[] })[]> {
  const allSites = await client.sites()
  const sites = allSites.filter((s): s is Site => !!s.siteUrl && s.permissionLevel !== 'siteUnverifiedUser')
  const requestedConcurrency = options.concurrency ?? 4
  const concurrency = Number.isFinite(requestedConcurrency)
    ? Math.max(1, Math.floor(requestedConcurrency))
    : 4

  // sitemaps.list is callable by any verified user (owner/full/restricted);
  // restricted users still get the list, just not write ops. Fall back to []
  // on permission errors so one inaccessible property doesn't fail the batch.
  // Keep the fan-out bounded: accounts can contain hundreds of properties,
  // and an eager Promise.all burst needlessly contends for sockets and quota.
  return runSequentialBatch(sites, async (site) => {
    const sitemaps = await client.sitemaps.list(site.siteUrl).catch(() => [] as ApiSitemap[])
    return { ...site, sitemaps }
  }, { concurrency })
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

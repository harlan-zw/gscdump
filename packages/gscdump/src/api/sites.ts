import type { GoogleSearchConsoleClient } from '../core/client'
import type { ApiSite, ApiSitemap, RequiredNonNullable, Site } from '../core/types'

/**
 * Fetches all sites the authenticated user has access to in Google Search Console.
 */
export async function fetchSites(client: GoogleSearchConsoleClient): Promise<ApiSite[]> {
  return client.sites()
}

/**
 * Fetches all verified sites with their sitemaps from Google Search Console.
 */
export async function fetchSitesWithSitemaps(client: GoogleSearchConsoleClient): Promise<(Site & { sitemaps: RequiredNonNullable<ApiSitemap>[] })[]> {
  const allSites = await client.sites()
  const sites = allSites.filter((s): s is Site => !!s.siteUrl && s.permissionLevel !== 'siteUnverifiedUser')

  return Promise.all(sites.map(async (site) => {
    const sitemaps = site.permissionLevel === 'siteOwner'
      ? await client.sitemaps.list(site.siteUrl) as RequiredNonNullable<ApiSitemap>[]
      : []
    return { ...site, sitemaps }
  }))
}

import type { indexing_v3 } from '@googleapis/indexing/v3'
import type { searchconsole_v1 } from '@googleapis/searchconsole/v1'
import type { GscAuth } from './client'
import type { RequiredNonNullable, Site } from './types'
import { gscClient } from './client'

export type IndexingNotificationType = 'URL_UPDATED' | 'URL_DELETED'

export interface IndexingResult {
  url: string
  type: IndexingNotificationType
  notifyTime?: string
  error?: string
}

export interface IndexingMetadata {
  url: string
  latestUpdate?: indexing_v3.Schema$UrlNotificationMetadata
  latestRemove?: indexing_v3.Schema$UrlNotificationMetadata
  error?: string
}

/**
 * Request Google to index or remove a URL via the Indexing API.
 * Note: The Indexing API officially supports only job posting and livestream content,
 * but can be used for any URL with varying success.
 */
export async function requestIndexing(
  auth: GscAuth,
  url: string,
  type: IndexingNotificationType = 'URL_UPDATED',
): Promise<IndexingResult> {
  return gscClient.indexing.publish(auth, url, type)
    .then(r => ({
      url,
      type,
      notifyTime: r.urlNotificationMetadata?.latestUpdate?.notifyTime || undefined,
    }))
    .catch((e: Error) => ({
      url,
      type,
      error: e.message,
    }))
}

/**
 * Get the indexing notification metadata for a URL.
 * Returns when Google was last notified about updates/removals.
 */
export async function getIndexingMetadata(
  auth: GscAuth,
  url: string,
): Promise<IndexingMetadata> {
  return gscClient.indexing.getMetadata(auth, url)
    .then(r => ({
      url,
      latestUpdate: r.latestUpdate || undefined,
      latestRemove: r.latestRemove || undefined,
    }))
    .catch((e: Error) => ({
      url,
      error: e.message,
    }))
}

/**
 * Batch request indexing for multiple URLs with rate limiting.
 * Returns results for each URL.
 */
export async function batchRequestIndexing(
  auth: GscAuth,
  urls: string[],
  options: {
    type?: IndexingNotificationType
    delayMs?: number
    onProgress?: (result: IndexingResult, index: number, total: number) => void
  } = {},
): Promise<IndexingResult[]> {
  const { type = 'URL_UPDATED', delayMs = 100, onProgress } = options
  const results: IndexingResult[] = []

  for (let i = 0; i < urls.length; i++) {
    const result = await requestIndexing(auth, urls[i], type)
    results.push(result)
    onProgress?.(result, i, urls.length)
    if (i < urls.length - 1 && delayMs > 0)
      await new Promise(r => setTimeout(r, delayMs))
  }

  return results
}

export interface UrlInspectionResult {
  url: string
  inspection?: searchconsole_v1.Schema$UrlInspectionResult
  isIndexed: boolean
  error?: string
}

/**
 * Inspects a URL in Google Search Console to check its indexing status.
 */
export async function inspectGscUrl(
  auth: GscAuth,
  siteUrl: string,
  inspectionUrl: string,
): Promise<{ inspection: searchconsole_v1.Schema$UrlInspectionResult | undefined, isIndexed: boolean }> {
  const response = await gscClient.urlInspection.inspect(auth, siteUrl, inspectionUrl)
  const inspection = response.inspectionResult
  const isIndexed = inspection?.indexStatusResult?.verdict === 'PASS'
  return { inspection, isIndexed }
}

/**
 * Batch inspect multiple URLs with rate limiting.
 * Returns inspection results for each URL.
 */
export async function batchInspectUrls(
  auth: GscAuth,
  siteUrl: string,
  urls: string[],
  options: {
    delayMs?: number
    onProgress?: (result: UrlInspectionResult, index: number, total: number) => void
  } = {},
): Promise<UrlInspectionResult[]> {
  const { delayMs = 200, onProgress } = options
  const results: UrlInspectionResult[] = []

  for (let i = 0; i < urls.length; i++) {
    const url = urls[i]
    const result = await gscClient.urlInspection.inspect(auth, siteUrl, url)
      .then(r => ({
        url,
        inspection: r.inspectionResult,
        isIndexed: r.inspectionResult?.indexStatusResult?.verdict === 'PASS',
      }))
      .catch((e: Error) => ({
        url,
        isIndexed: false,
        error: e.message,
      }))

    results.push(result)
    onProgress?.(result, i, urls.length)
    if (i < urls.length - 1 && delayMs > 0)
      await new Promise(r => setTimeout(r, delayMs))
  }

  return results
}

/**
 * Fetches all sites the authenticated user has access to in Google Search Console.
 */
export async function fetchGscSites(auth: GscAuth): Promise<searchconsole_v1.Schema$WmxSite[]> {
  return gscClient.sites.list(auth).then(res => res?.siteEntry || [])
}

/**
 * Fetches sitemaps for a site.
 */
export async function fetchSitemaps(auth: GscAuth, siteUrl: string): Promise<searchconsole_v1.Schema$WmxSitemap[]> {
  return gscClient.sitemaps.list(auth, siteUrl).then(res => res.sitemap || [])
}

/**
 * Gets details for a specific sitemap.
 */
export async function getSitemap(auth: GscAuth, siteUrl: string, feedpath: string): Promise<searchconsole_v1.Schema$WmxSitemap> {
  return gscClient.sitemaps.get(auth, siteUrl, feedpath)
}

/**
 * Submits a sitemap to Google Search Console.
 */
export async function submitSitemap(auth: GscAuth, siteUrl: string, feedpath: string): Promise<void> {
  return gscClient.sitemaps.submit(auth, siteUrl, feedpath)
}

/**
 * Deletes a sitemap from Google Search Console.
 */
export async function deleteSitemap(auth: GscAuth, siteUrl: string, feedpath: string): Promise<void> {
  return gscClient.sitemaps.delete(auth, siteUrl, feedpath)
}

/**
 * Fetches all verified sites with their sitemaps from Google Search Console.
 */
export async function fetchGscSitesWithSitemaps(auth: GscAuth): Promise<(Site & { sitemaps: RequiredNonNullable<searchconsole_v1.Schema$WmxSitemap>[] })[]> {
  const sites = (await gscClient.sites.list(auth).then(res => res.siteEntry || []))
    .filter((s): s is Site => !!s.siteUrl && s.permissionLevel !== 'siteUnverifiedUser')

  return Promise.all(sites.map(async (site) => {
    const sitemaps = site.permissionLevel === 'siteOwner'
      ? await gscClient.sitemaps.list(auth, site.siteUrl).then(res => (res.sitemap || []) as RequiredNonNullable<searchconsole_v1.Schema$WmxSitemap>[])
      : []
    return { ...site, sitemaps }
  }))
}

// Re-export
export type { GscAuth } from './client'

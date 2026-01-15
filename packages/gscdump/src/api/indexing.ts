import type { indexing_v3 } from '@googleapis/indexing/v3'
import type { GoogleSearchConsoleClient } from '../core/client'

export type IndexingNotificationType = 'URL_UPDATED' | 'URL_DELETED'

export interface IndexingResult {
  url: string
  type: IndexingNotificationType
  notifyTime?: string
}

export interface IndexingMetadata {
  url: string
  latestUpdate?: indexing_v3.Schema$UrlNotificationMetadata
  latestRemove?: indexing_v3.Schema$UrlNotificationMetadata
}

/**
 * Request Google to index or remove a URL via the Indexing API.
 * Note: The Indexing API officially supports only job posting and livestream content,
 * but can be used for any URL with varying success.
 */
export async function requestIndexing(
  client: GoogleSearchConsoleClient,
  url: string,
  options: { type?: IndexingNotificationType } = {},
): Promise<IndexingResult> {
  const { type = 'URL_UPDATED' } = options
  return client.indexing.publish(url, type)
    .then(r => ({
      url,
      type,
      notifyTime: r.urlNotificationMetadata?.latestUpdate?.notifyTime || undefined,
    }))
}

/**
 * Get the indexing notification metadata for a URL.
 * Returns when Google was last notified about updates/removals.
 */
export async function getIndexingMetadata(
  client: GoogleSearchConsoleClient,
  url: string,
): Promise<IndexingMetadata> {
  return client.indexing.getMetadata(url)
    .then(r => ({
      url,
      latestUpdate: r.latestUpdate || undefined,
      latestRemove: r.latestRemove || undefined,
    }))
}

/**
 * Batch request indexing for multiple URLs with rate limiting.
 * Returns results for each URL.
 */
export async function batchRequestIndexing(
  client: GoogleSearchConsoleClient,
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
    const result = await requestIndexing(client, urls[i], { type })
    results.push(result)
    onProgress?.(result, i, urls.length)
    if (i < urls.length - 1 && delayMs > 0)
      await new Promise(r => setTimeout(r, delayMs))
  }

  return results
}

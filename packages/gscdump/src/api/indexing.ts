import type { GoogleSearchConsoleClient } from '../core/client'
import type { UrlNotification } from '../core/types'
import { runSequentialBatch } from './batch'

export type IndexingNotificationType = 'URL_UPDATED' | 'URL_DELETED'

export interface IndexingResult {
  url: string
  type: IndexingNotificationType
  notifyTime?: string
}

export interface IndexingMetadata {
  url: string
  latestUpdate?: UrlNotification
  latestRemove?: UrlNotification
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
    concurrency?: number
    onProgress?: (result: IndexingResult, index: number, total: number) => void
  } = {},
): Promise<IndexingResult[]> {
  const { type = 'URL_UPDATED', delayMs = 100, concurrency, onProgress } = options
  return runSequentialBatch(
    urls,
    url => requestIndexing(client, url, { type }),
    { delayMs, concurrency, onProgress },
  )
}

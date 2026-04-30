import type { GoogleSearchConsoleClient } from '../core/client'
import type { UrlInspectionResult as GscUrlInspectionResult } from '../core/types'
import { runSequentialBatch } from './batch'

export interface InspectUrlResult {
  url: string
  inspection?: GscUrlInspectionResult
  isIndexed: boolean
}

/**
 * Inspects a URL in Google Search Console to check its indexing status.
 */
export async function inspectUrl(
  client: GoogleSearchConsoleClient,
  siteUrl: string,
  inspectionUrl: string,
): Promise<{ inspection: GscUrlInspectionResult | undefined, isIndexed: boolean }> {
  const response = await client.inspect(siteUrl, inspectionUrl)
  const inspection = response.inspectionResult
  const isIndexed = inspection?.indexStatusResult?.verdict === 'PASS'
  return { inspection, isIndexed }
}

/**
 * Batch inspect multiple URLs with rate limiting.
 * Returns inspection results for each URL.
 */
export async function batchInspectUrls(
  client: GoogleSearchConsoleClient,
  siteUrl: string,
  urls: string[],
  options: {
    delayMs?: number
    concurrency?: number
    onProgress?: (result: InspectUrlResult, index: number, total: number) => void
  } = {},
): Promise<InspectUrlResult[]> {
  const { delayMs = 200, concurrency, onProgress } = options
  return runSequentialBatch(
    urls,
    async (url) => {
      const { inspection, isIndexed } = await inspectUrl(client, siteUrl, url)
      return { url, inspection, isIndexed } satisfies InspectUrlResult
    },
    { delayMs, concurrency, onProgress },
  )
}

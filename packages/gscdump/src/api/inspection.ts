import type { UrlInspectionResult as GscUrlInspectionResult } from '../core/types'
import type { GoogleSearchConsoleClient } from '../core/client'

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
  const response = await client.urlInspection.inspect(siteUrl, inspectionUrl)
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
    onProgress?: (result: InspectUrlResult, index: number, total: number) => void
  } = {},
): Promise<InspectUrlResult[]> {
  const { delayMs = 200, onProgress } = options
  const results: InspectUrlResult[] = []

  for (let i = 0; i < urls.length; i++) {
    const url = urls[i]
    const { inspection, isIndexed } = await inspectUrl(client, siteUrl, url)
    const result: InspectUrlResult = { url, inspection, isIndexed }
    results.push(result)
    onProgress?.(result, i, urls.length)
    if (i < urls.length - 1 && delayMs > 0)
      await new Promise(r => setTimeout(r, delayMs))
  }

  return results
}
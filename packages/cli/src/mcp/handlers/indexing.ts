import type { IndexingMetadata, IndexingResult, InspectUrlResult } from 'gscdump'
import type { z } from 'zod'
import type { batchInspectUrlsInput, batchRequestIndexingInput, HandlerContext, inspectUrlInput, requestIndexingInput } from '../types'
import { getIndexingMetadata, batchRequestIndexing as gscBatchIndexing, batchInspectUrls as gscBatchInspect, inspectUrl as gscInspectUrl, requestIndexing as gscRequestIndexing } from 'gscdump'

export async function inspectUrl(
  input: z.infer<typeof inspectUrlInput>,
  ctx: HandlerContext,
): Promise<{ inspection: unknown, isIndexed: boolean }> {
  return gscInspectUrl(ctx.client, input.siteUrl, input.inspectionUrl)
}

export async function requestIndexing(
  input: z.infer<typeof requestIndexingInput>,
  ctx: HandlerContext,
): Promise<IndexingResult> {
  // requestIndexing now throws on error, but MCP handler probably expects to handle it or let it bubble?
  // Previous implementation: return gscRequestIndexing(...) which returned { error } if failed?
  // No, gscRequestIndexing in api.ts WAS catching. Now it's NOT.
  // So if I return the promise, it will reject on error.
  // The MCP server wrapper likely catches errors.
  // However, I should check if I need to catch and return format with error.
  // The return type is Promise<IndexingResult>. IndexingResult has error?: string.
  // If I want to return an object with error, I should catch.
  return gscRequestIndexing(ctx.client, input.url, { type: input.type || 'URL_UPDATED' })
    .catch((e: Error) => ({
      url: input.url,
      type: input.type || 'URL_UPDATED',
      error: e.message,
    }))
}

export async function getIndexingStatus(
  input: { url: string },
  ctx: HandlerContext,
): Promise<IndexingMetadata> {
  return getIndexingMetadata(ctx.client, input.url)
    .catch((e: Error) => ({
      url: input.url,
      error: e.message,
    }))
}

export async function batchRequestIndexing(
  input: z.infer<typeof batchRequestIndexingInput>,
  ctx: HandlerContext,
): Promise<{ results: IndexingResult[], success: number, failed: number }> {
  const results = await gscBatchIndexing(ctx.client, input.urls, {
    type: input.type || 'URL_UPDATED',
    delayMs: input.delayMs || 100,
  })
  return {
    results,
    success: results.length,
    failed: 0,
  }
}

export async function batchInspectUrls(
  input: z.infer<typeof batchInspectUrlsInput>,
  ctx: HandlerContext,
): Promise<{ results: InspectUrlResult[], indexed: number, notIndexed: number }> {
  const results = await gscBatchInspect(ctx.client, input.siteUrl, input.urls, {
    delayMs: input.delayMs || 200,
  })
  return {
    results,
    indexed: results.filter(r => r.isIndexed).length,
    notIndexed: results.filter(r => !r.isIndexed).length,
  }
}

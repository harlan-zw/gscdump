import type { IndexingMetadata, IndexingResult, InspectUrlResult } from 'gscdump/indexing'
import type { z } from 'zod'
import type { batchInspectUrlsInput, batchRequestIndexingInput, HandlerContext, inspectUrlInput, requestIndexingInput } from '../types'
import { getIndexingMetadata, batchRequestIndexing as gscBatchIndexing, batchInspectUrls as gscBatchInspect, inspectUrl as gscInspectUrl, requestIndexing as gscRequestIndexing } from 'gscdump/indexing'

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
  // Let a real Indexing API failure (quota/403/auth/network) propagate to the MCP
  // error boundary rather than swallowing it into a fake-success payload — matches
  // the query/reports handlers. `IndexingResult` has no `error` field.
  return gscRequestIndexing(ctx.client, input.url, { type: input.type || 'URL_UPDATED' })
}

export async function getIndexingStatus(
  input: { url: string },
  ctx: HandlerContext,
): Promise<IndexingMetadata> {
  return getIndexingMetadata(ctx.client, input.url)
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

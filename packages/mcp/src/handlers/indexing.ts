import type { IndexingMetadata, IndexingResult, UrlInspectionResult } from 'gscdump'
import type { z } from 'zod'
import type { batchInspectUrlsInput, batchRequestIndexingInput, HandlerContext, inspectUrlInput, requestIndexingInput } from '../types'
import { getIndexingMetadata, batchRequestIndexing as gscBatchIndexing, batchInspectUrls as gscBatchInspect, requestIndexing as gscRequestIndexing, inspectGscUrl } from 'gscdump'

export async function inspectUrl(
  input: z.infer<typeof inspectUrlInput>,
  ctx: HandlerContext,
): Promise<{ inspection: unknown, isIndexed: boolean }> {
  return inspectGscUrl(ctx.auth, input.siteUrl, input.inspectionUrl)
}

export async function requestIndexing(
  input: z.infer<typeof requestIndexingInput>,
  ctx: HandlerContext,
): Promise<IndexingResult> {
  return gscRequestIndexing(ctx.auth, input.url, input.type || 'URL_UPDATED')
}

export async function getIndexingStatus(
  input: { url: string },
  ctx: HandlerContext,
): Promise<IndexingMetadata> {
  return getIndexingMetadata(ctx.auth, input.url)
}

export async function batchRequestIndexing(
  input: z.infer<typeof batchRequestIndexingInput>,
  ctx: HandlerContext,
): Promise<{ results: IndexingResult[], success: number, failed: number }> {
  const results = await gscBatchIndexing(ctx.auth, input.urls, {
    type: input.type || 'URL_UPDATED',
    delayMs: input.delayMs || 100,
  })
  return {
    results,
    success: results.filter(r => !r.error).length,
    failed: results.filter(r => r.error).length,
  }
}

export async function batchInspectUrls(
  input: z.infer<typeof batchInspectUrlsInput>,
  ctx: HandlerContext,
): Promise<{ results: UrlInspectionResult[], indexed: number, notIndexed: number }> {
  const results = await gscBatchInspect(ctx.auth, input.siteUrl, input.urls, {
    delayMs: input.delayMs || 200,
  })
  return {
    results,
    indexed: results.filter(r => r.isIndexed).length,
    notIndexed: results.filter(r => !r.isIndexed).length,
  }
}

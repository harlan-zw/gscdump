/**
 * Sequential batch runner with inter-call delay and progress callback.
 * Used by batchRequestIndexing / batchInspectUrls. Sequential (not concurrent)
 * because the underlying APIs rate-limit aggressively per-key.
 */
export async function runSequentialBatch<I, R>(
  items: I[],
  operation: (item: I, index: number) => Promise<R>,
  options: {
    delayMs?: number
    onProgress?: (result: R, index: number, total: number) => void
  } = {},
): Promise<R[]> {
  const { delayMs = 0, onProgress } = options
  const results: R[] = []

  for (let i = 0; i < items.length; i++) {
    const result = await operation(items[i]!, i)
    results.push(result)
    onProgress?.(result, i, items.length)
    if (i < items.length - 1 && delayMs > 0)
      await new Promise(r => setTimeout(r, delayMs))
  }

  return results
}

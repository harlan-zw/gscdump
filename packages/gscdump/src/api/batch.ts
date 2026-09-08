/**
 * Batch runner with optional concurrency, inter-call delay, and progress.
 * Used by batchRequestIndexing / batchInspectUrls. Defaults to sequential
 * (concurrency = 1) because the underlying APIs rate-limit aggressively;
 * callers that know their quota headroom can opt into parallelism.
 */
export async function runSequentialBatch<I, R>(
  items: I[],
  operation: (item: I, index: number) => Promise<R>,
  options: {
    delayMs?: number
    concurrency?: number
    onProgress?: (result: R, index: number, total: number) => void
  } = {},
): Promise<R[]> {
  const { delayMs = 0, concurrency = 1, onProgress } = options
  if (!Number.isInteger(concurrency) || concurrency < 1)
    throw new RangeError('concurrency must be a positive integer.')
  if (!Number.isFinite(delayMs) || delayMs < 0)
    throw new RangeError('delayMs must be a finite, nonnegative number.')
  const results: R[] = Array.from({ length: items.length })
  let completed = 0

  if (concurrency <= 1) {
    for (let i = 0; i < items.length; i++) {
      const result = await operation(items[i]!, i)
      results[i] = result
      onProgress?.(result, i, items.length)
      if (i < items.length - 1 && delayMs > 0)
        await new Promise(r => setTimeout(r, delayMs))
    }
    return results
  }

  const cursor = { i: 0 }
  const worker = async (): Promise<void> => {
    while (true) {
      const i = cursor.i++
      if (i >= items.length)
        return
      const result = await operation(items[i]!, i)
      results[i] = result
      // Progress is fired in completion order, not input order, since
      // concurrent workers race; use `completed` for monotonic counts.
      completed++
      onProgress?.(result, completed - 1, items.length)
      if (delayMs > 0)
        await new Promise(r => setTimeout(r, delayMs))
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, worker),
  )
  return results
}

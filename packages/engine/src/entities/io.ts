const ENTITY_IO_CONCURRENCY = 8

export async function mapEntityIo<T, R>(items: readonly T[], fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  if (items.length === 0)
    return []
  const results = Array.from({ length: items.length }, () => undefined as R | undefined)
  let next = 0
  async function worker(): Promise<void> {
    while (true) {
      const index = next++
      if (index >= items.length)
        return
      results[index] = await fn(items[index]!, index)
    }
  }
  await Promise.all(Array.from({ length: Math.min(ENTITY_IO_CONCURRENCY, items.length) }, worker))
  return results as R[]
}

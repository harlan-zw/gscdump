import type { AsyncBuffer } from 'hyparquet'

/** Internal, one-group cache. The caller has admitted a flat scalar schema. */
export function parquetRangeCache(source: AsyncBuffer, maxBytes: number): { file: AsyncBuffer, close: () => void } {
  const entries = new Map<string, ArrayBuffer>()
  let retainedBytes = 0
  let closed = false
  return {
    file: {
      byteLength: source.byteLength,
      async slice(start: number, end = source.byteLength) {
        const key = `${start}:${end}`
        const cached = entries.get(key)
        if (cached) {
          entries.delete(key)
          entries.set(key, cached)
          return cached
        }
        const bytes = await source.slice(start, end)
        // A failed sibling read can close the group while this miss is pending.
        if (!closed && bytes.byteLength > 0 && bytes.byteLength <= maxBytes) {
          const previous = entries.get(key)
          if (previous) {
            retainedBytes -= previous.byteLength
            entries.delete(key)
          }
          while (entries.size >= 128 || retainedBytes + bytes.byteLength > maxBytes) {
            const oldest = entries.keys().next().value!
            retainedBytes -= entries.get(oldest)!.byteLength
            entries.delete(oldest)
          }
          entries.set(key, bytes)
          retainedBytes += bytes.byteLength
        }
        return bytes
      },
    } satisfies AsyncBuffer,
    close() {
      closed = true
      entries.clear()
      retainedBytes = 0
    },
  }
}

import type { AsyncBuffer, Compressors } from 'hyparquet'
import { snappyUncompress } from 'hyparquet'

/**
 * Internal, cumulative work admission for one physical group. Source cache
 * misses and SNAPPY outputs consume the same budget before allocation/dispatch.
 * Raw pages and V2 levels are covered by the input charge; this deliberately
 * counts compressed data twice. It does not measure retained/expanded JS heap.
 */
export function parquetDecodeBudget(source: AsyncBuffer, maxBytes: number): {
  file: AsyncBuffer
  compressors: Compressors
  close: () => void
} {
  let remaining = maxBytes
  let closed = false
  let failure: unknown
  function fail(error: unknown): never {
    if (!closed) {
      closed = true
      failure = error
    }
    throw failure
  }
  function assertOpen(): void {
    if (closed)
      throw failure
  }
  function charge(bytes: number): void {
    assertOpen()
    if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > remaining)
      fail(new RangeError('parquet stream exceeds maxReadAndDecompressBytes'))
    remaining -= bytes
  }
  return {
    file: {
      byteLength: source.byteLength,
      async slice(start, end = source.byteLength) {
        try {
          if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || end > source.byteLength)
            fail(new RangeError('parquet stream invalid decode-buffer range'))
          charge(end - start)
          const bytes = await source.slice(start, end)
          assertOpen() // A sibling failure may have closed this group meanwhile.
          if (bytes.byteLength !== end - start)
            fail(new Error('parquet stream returned an incomplete decode-buffer range'))
          return bytes
        }
        catch (error) {
          fail(error)
        }
      },
    },
    compressors: {
      SNAPPY(input, size) {
        charge(size)
        try {
          const output = new Uint8Array(size)
          snappyUncompress(input, output)
          return output
        }
        catch (error) {
          fail(error)
        }
      },
      ZSTD() {
        // fzstd's existing allocating API uses its own frame size/window before
        // Parquet's length check. Leave it unchanged for callers without a budget.
        fail(new Error('parquet stream maxReadAndDecompressBytes does not support ZSTD'))
      },
    },
    close() {
      if (!closed) {
        closed = true
        failure = new Error('parquet stream decode-buffer budget is closed')
      }
    },
  }
}

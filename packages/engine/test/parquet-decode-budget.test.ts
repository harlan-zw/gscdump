import { describe, expect, it, vi } from 'vitest'
import { parquetDecodeBudget } from '../src/adapters/parquet-decode-budget'
import { parquetRangeCache } from '../src/adapters/parquet-range-cache'

// SNAPPY literal "abc": decoded length, literal tag, three bytes.
const compressed = new Uint8Array([3, 8, 97, 98, 99])
function source() {
  return { byteLength: 100, slice: vi.fn(async (start: number, end = 100) => new ArrayBuffer(end - start)) }
}

describe('physical-group decode-buffer budget', () => {
  it('charges reads and output against one shared budget before allocation', async () => {
    const input = source()
    const budget = parquetDecodeBudget(input, 8)
    await budget.file.slice(0, 5)
    expect(budget.compressors.SNAPPY!(compressed, 3)).toEqual(new Uint8Array([97, 98, 99]))
    await expect(budget.file.slice(5, 6)).rejects.toThrow('maxReadAndDecompressBytes')
    expect(input.slice).toHaveBeenCalledTimes(1)
    expect(() => budget.compressors.SNAPPY!(compressed, 3)).toThrow('maxReadAndDecompressBytes')
  })

  it('reserves concurrent column reads before either resolves and fences a late result', async () => {
    let release!: (bytes: ArrayBuffer) => void
    const input = source()
    input.slice.mockReturnValueOnce(new Promise(resolve => release = resolve))
    const budget = parquetDecodeBudget(input, 8)
    const first = budget.file.slice(0, 5)
    const second = budget.file.slice(5, 10)
    const settled = Promise.allSettled([first, second])
    release(new ArrayBuffer(5))
    const results = await settled
    expect(results.every(result => result.status === 'rejected')).toBe(true)
    expect((results[0] as PromiseRejectedResult).reason).toBe((results[1] as PromiseRejectedResult).reason)
    expect(input.slice).toHaveBeenCalledTimes(1)
  })

  it('preserves a transport rejection and does not reopen for sibling decompression', async () => {
    const error = new Error('cancelled pinned read')
    const input = source()
    input.slice.mockRejectedValueOnce(error)
    const budget = parquetDecodeBudget(input, 50)
    await expect(budget.file.slice(0, 5)).rejects.toBe(error)
    expect(() => budget.compressors.SNAPPY!(compressed, 3)).toThrow(error)
    budget.close()
    await expect(budget.file.slice(0, 1)).rejects.toBe(error)
  })

  it.each([2, 4])('rejects SNAPPY length mismatch %i and retains the original error through cleanup', (size) => {
    const budget = parquetDecodeBudget(source(), 50)
    let error: unknown
    try {
      budget.compressors.SNAPPY!(compressed, size)
    }
    catch (caught) { error = caught }
    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toContain('premature end')
    budget.close()
    expect(() => budget.compressors.SNAPPY!(compressed, 3)).toThrow(error as Error)
  })

  it('does not recharge a range-cache hit but charges every repeated decompression', async () => {
    const input = source()
    const budget = parquetDecodeBudget(input, 11)
    const cache = parquetRangeCache(budget.file, 8)
    await cache.file.slice(0, 5)
    await cache.file.slice(0, 5)
    expect(input.slice).toHaveBeenCalledOnce()
    expect(budget.compressors.SNAPPY!(compressed, 3)).toHaveLength(3)
    expect(budget.compressors.SNAPPY!(compressed, 3)).toHaveLength(3)
    expect(() => budget.compressors.SNAPPY!(compressed, 3)).toThrow('maxReadAndDecompressBytes')
    cache.close()
    budget.close()
  })

  it('refuses impossible output sizes without passing them to an allocator', () => {
    for (const size of [-1, NaN, Infinity, 1.5, Number.MAX_SAFE_INTEGER]) {
      const budget = parquetDecodeBudget(source(), 50)
      expect(() => budget.compressors.SNAPPY!(compressed, size)).toThrow('maxReadAndDecompressBytes')
    }
  })

  it('closes pending reads and allows a separate group or retry a fresh budget', async () => {
    const input = source()
    let release!: (bytes: ArrayBuffer) => void
    input.slice.mockReturnValueOnce(new Promise(resolve => release = resolve))
    const budget = parquetDecodeBudget(input, 5)
    const pending = budget.file.slice(0, 5)
    budget.close()
    release(new ArrayBuffer(5))
    await expect(pending).rejects.toThrow('closed')
    expect((await parquetDecodeBudget(input, 5).file.slice(0, 5)).byteLength).toBe(5)
  })

  it('does not admit malformed ranges or incomplete source responses', async () => {
    const input = source()
    await expect(parquetDecodeBudget(input, 50).file.slice(3, 2)).rejects.toThrow('range')
    expect(input.slice).not.toHaveBeenCalled()
    input.slice.mockResolvedValueOnce(new ArrayBuffer(4))
    await expect(parquetDecodeBudget(input, 50).file.slice(0, 5)).rejects.toThrow('incomplete')
  })
})

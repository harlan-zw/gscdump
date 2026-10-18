import { describe, expect, it, vi } from 'vitest'
import { parquetRangeCache } from '../src/adapters/parquet-range-cache'

function source() {
  return { byteLength: 1024, slice: vi.fn(async (start: number, end = 1024) => new ArrayBuffer(end - start)) }
}

describe('one-group Parquet range cache', () => {
  it('evicts by byte budget and recency, and bypasses oversize reads', async () => {
    const input = source()
    const cache = parquetRangeCache(input, 8)
    await cache.file.slice(0, 4)
    await cache.file.slice(4, 8)
    await cache.file.slice(0, 4) // Keep oldest range alive.
    await cache.file.slice(8, 12)
    expect(input.slice).toHaveBeenCalledTimes(3)
    await cache.file.slice(0, 4)
    expect(input.slice).toHaveBeenCalledTimes(3)
    await cache.file.slice(4, 8)
    expect(input.slice).toHaveBeenCalledTimes(4)
    await cache.file.slice(20, 29)
    await cache.file.slice(20, 29)
    expect(input.slice).toHaveBeenCalledTimes(6)
  })

  it('limits tiny entries independently of payload bytes', async () => {
    const input = source()
    const cache = parquetRangeCache(input, 1024)
    for (let i = 0; i < 128; i++)
      await cache.file.slice(i, i + 1)
    await cache.file.slice(0, 1)
    await cache.file.slice(128, 129)
    await cache.file.slice(0, 1)
    expect(input.slice).toHaveBeenCalledTimes(129)
    await cache.file.slice(1, 2)
    expect(input.slice).toHaveBeenCalledTimes(130)
  })

  it('does not double-count simultaneous misses or retain a late miss after close', async () => {
    let release!: () => void
    const pending = new Promise<void>((resolve) => {
      release = resolve
    })
    const input = source()
    input.slice.mockImplementation(async (start, end = 1024) => {
      await pending
      return new ArrayBuffer(end - start)
    })
    const cache = parquetRangeCache(input, 8)
    const first = cache.file.slice(0, 4)
    const duplicate = cache.file.slice(0, 4)
    release()
    await Promise.all([first, duplicate])
    await cache.file.slice(4, 8)
    await cache.file.slice(0, 4)
    expect(input.slice).toHaveBeenCalledTimes(3)
    cache.close()
    await cache.file.slice(0, 4)
    await cache.file.slice(0, 4)
    expect(input.slice).toHaveBeenCalledTimes(5)
  })

  it('clears and disables retention even when an outstanding read resolves later', async () => {
    let release!: (bytes: ArrayBuffer) => void
    const input = source()
    input.slice.mockReturnValueOnce(new Promise((resolve) => {
      release = resolve
    }))
    const cache = parquetRangeCache(input, 8)
    const read = cache.file.slice(0, 4)
    cache.close()
    release(new ArrayBuffer(4))
    await read
    await cache.file.slice(0, 4)
    expect(input.slice).toHaveBeenCalledTimes(2)
  })

  it('preserves failures without caching them', async () => {
    const input = source()
    const error = new Error('pinned range failure')
    input.slice.mockRejectedValueOnce(error)
    const cache = parquetRangeCache(input, 8)
    await expect(cache.file.slice(0, 4)).rejects.toBe(error)
    expect((await cache.file.slice(0, 4)).byteLength).toBe(4)
    expect(input.slice).toHaveBeenCalledTimes(2)
  })
})

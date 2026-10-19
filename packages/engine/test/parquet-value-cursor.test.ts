import { describe, expect, it } from 'vitest'
import { hybridCursor, plainCursor } from '../src/adapters/parquet-value-cursor'

describe('bounded scalar cursor primitives', () => {
  it.each([new Uint8Array(), new Uint8Array([8])])('accepts implicit and explicit zero-width dictionary runs', (encoded) => {
    const cursor = hybridCursor(encoded, 0, 4)
    expect(Array.from({ length: 4 }, () => cursor.next())).toEqual([0, 0, 0, 0])
    cursor.finish()
  })
  it('reads bitpacked IDs across byte boundaries and bounded padding', () => {
    const cursor = hybridCursor(new Uint8Array([3, 0b10001000, 0b11000110, 0b11111010]), 3, 7)
    expect(Array.from({ length: 7 }, () => cursor.next())).toEqual([0, 1, 2, 3, 4, 5, 6])
    cursor.finish()
  })
  it('accepts DuckDB final 256-value block padding without materializing it', () => {
    const cursor = hybridCursor(new Uint8Array([65, ...new Uint8Array(128)]), 4, 168)
    expect(Array.from({ length: 168 }, () => cursor.next())).toEqual(Array.from({ length: 168 }).fill(0))
    cursor.finish()
    expect(() => hybridCursor(new Uint8Array([65, 0]), 4, 168).next()).toThrow('truncated')
  })
  it('rejects oversize runs, trailing bytes and truncated values', () => {
    expect(() => hybridCursor(new Uint8Array([10, 1]), 1, 2).next()).toThrow('run length')
    const trailing = hybridCursor(new Uint8Array([4, 1, 4, 0]), 1, 2)
    trailing.next()
    trailing.next()
    expect(() => trailing.finish()).toThrow('trailing')
    expect(() => plainCursor(new Uint8Array([9, 0, 0, 0]), { name: 'query', type: 'BYTE_ARRAY', repetition_type: 'REQUIRED' }, 1, 100).next()).toThrow('truncated')
  })
  it('normalizes an INT96 UTC day without materializing a column array', () => {
    const bytes = new Uint8Array(12)
    const view = new DataView(bytes.buffer)
    view.setBigInt64(0, 43_200_000_000_000n, true)
    view.setInt32(8, 2440588, true)
    const cursor = plainCursor(bytes, { name: 'date', type: 'INT96', repetition_type: 'REQUIRED' }, 1, 100)
    expect(cursor.next().value()).toBe('1970-01-01')
    cursor.finish()
  })
})

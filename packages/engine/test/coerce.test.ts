import { describe, expect, it } from 'vitest'
import { coerceRow, coerceRows } from '../src/coerce'

describe('query row coercion', () => {
  it('returns ordinary rows unchanged without cloning each object', () => {
    const row = { clicks: 2, impressions: 10 }
    expect(coerceRow(row)).toBe(row)
    expect(coerceRows([row])[0]).toBe(row)
  })

  it('clones only rows containing BigInts and converts every BigInt property', () => {
    const clean = { clicks: 2, label: 'clean' }
    const bigint = { clicks: 3n, impressions: 20n, label: 'coerced' }
    const result = coerceRows([clean, bigint])

    expect(result[0]).toBe(clean)
    expect(result[1]).not.toBe(bigint)
    expect(result[1]).toEqual({ clicks: 3, impressions: 20, label: 'coerced' })
    expect(bigint).toEqual({ clicks: 3n, impressions: 20n, label: 'coerced' })
  })

  it('ignores inherited enumerable properties like Object.entries did', () => {
    const row = Object.assign(Object.create({ inherited: 3n }), { clicks: 2 })
    expect(coerceRow(row)).toBe(row)
    expect(Object.hasOwn(coerceRow(row), 'inherited')).toBe(false)
  })
})

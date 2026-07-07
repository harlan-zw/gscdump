import { describe, expect, it } from 'vitest'
import { bigintJsonReplacer, coerceBigIntToNumber, encodeJsonBigintSafe, stringifyBigintSafe } from '../src/bigint'

describe('bigint JSON-boundary helpers', () => {
  it('stringifyBigintSafe serializes BigInt losslessly as a decimal string', () => {
    const id = 8114363535789397000n // > Number.MAX_SAFE_INTEGER
    const json = stringifyBigintSafe({ 'current-snapshot-id': id, 'nested': [{ 'sequence-number': 42n }] })
    expect(json).toBe('{"current-snapshot-id":"8114363535789397000","nested":[{"sequence-number":"42"}]}')
    // lossless: the exact digits survive (Number would round 8114363535789397000 → ...396928)
    expect(JSON.parse(json)['current-snapshot-id']).toBe('8114363535789397000')
  })

  it('stringifyBigintSafe leaves BigInt-free values byte-identical to JSON.stringify', () => {
    const value = { a: 1, b: 'x', c: [true, null], d: { e: 2.5 } }
    expect(stringifyBigintSafe(value)).toBe(JSON.stringify(value))
  })

  it('encodeJsonBigintSafe returns UTF-8 bytes and never throws on BigInt', () => {
    const bytes = encodeJsonBigintSafe({ id: 9007199254740993n })
    expect(bytes).toBeInstanceOf(Uint8Array)
    expect(new TextDecoder().decode(bytes)).toBe('{"id":"9007199254740993"}')
  })

  it('bigintJsonReplacer passes non-BigInt through untouched', () => {
    expect(bigintJsonReplacer('k', 5)).toBe(5)
    expect(bigintJsonReplacer('k', 'v')).toBe('v')
    expect(bigintJsonReplacer('k', 7n)).toBe('7')
  })

  it('coerceBigIntToNumber converts aggregates to number, passes others through', () => {
    expect(coerceBigIntToNumber(123n)).toBe(123)
    expect(coerceBigIntToNumber(4.2)).toBe(4.2)
    expect(coerceBigIntToNumber('s')).toBe('s')
    expect(coerceBigIntToNumber(null)).toBe(null)
  })
})

// Regression: R2 Data Catalog's managed compaction writes 64-bit snapshot ids
// that exceed Number.MAX_SAFE_INTEGER. icebird's `parseIcebergJson` promotes
// them to BigInt, then the catalog commit body's `JSON.stringify` would throw
// "TypeError: Do not know how to serialize a BigInt", breaking every Iceberg
// ingest commit in production (2026-05-25 incident).
//
// Icebird 0.8.26 includes `stringifyIcebergJson`. This repo's package patch
// uses it for REST catalog commit bodies.
// The engine BUNDLES this patched icebird into its dist, so this guard lives
// here (not in the consumer, which no longer depends on icebird): it pins the
// contract that plain `JSON.stringify` throws on a BigInt while
// `stringifyIcebergJson` emits it as a bare integer literal so int64 precision
// survives the round-trip.

// @ts-expect-error icebird json.js is plain JS, no .d.ts
import { parseIcebergJson, stringifyIcebergJson } from 'icebird/src/json.js'
import { describe, expect, it } from 'vitest'

describe('icebird BigInt stringify regression', () => {
  it('parseIcebergJson promotes >MAX_SAFE_INTEGER ints to BigInt', () => {
    const meta = parseIcebergJson('{"current-snapshot-id":9007199254740993,"x":5}')
    expect(typeof meta['current-snapshot-id']).toBe('bigint')
    expect(meta['current-snapshot-id']).toBe(9007199254740993n)
    expect(typeof meta.x).toBe('number')
  })

  it('plain JSON.stringify throws on the BigInt-laced metadata (the bug)', () => {
    const meta = parseIcebergJson('{"current-snapshot-id":9007199254740993}')
    expect(() => JSON.stringify(meta)).toThrow(/serialize a BigInt/)
  })

  it('stringifyIcebergJson emits BigInts as bare integer literals (the fix)', () => {
    const meta = parseIcebergJson('{"current-snapshot-id":9007199254740993,"x":5,"s":"hi"}')
    const text = stringifyIcebergJson(meta)
    expect(text).toContain('"current-snapshot-id": 9007199254740993')
    expect(text).not.toContain('"9007199254740993"')
    // Round-trip preserves exact int64 value.
    expect(parseIcebergJson(text)['current-snapshot-id']).toBe(9007199254740993n)
  })

  it('handles nested objects, arrays, indentation', () => {
    const v = { a: 9007199254740993n, list: [1n, 'x', null], nested: { b: 18014398509481985n } }
    const text = stringifyIcebergJson(v)
    expect(text).toContain('"a": 9007199254740993')
    expect(text).not.toContain('"9007199254740993"')
    expect(parseIcebergJson(text).nested.b).toBe(18014398509481985n)
    const indented = stringifyIcebergJson(v, 2)
    expect(indented).toContain('\n  "a": 9007199254740993')
    expect(parseIcebergJson(indented).nested.b).toBe(18014398509481985n)
  })
})

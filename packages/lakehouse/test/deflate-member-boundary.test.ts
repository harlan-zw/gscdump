import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import { createRequire } from 'node:module'
import { constants, deflateRawSync, gzipSync, inflateRawSync } from 'node:zlib'
import { describe, it } from 'vitest'

const icebirdRequire = createRequire(import.meta.resolve('icebird'))
const { gunzip } = await import(icebirdRequire.resolve('hyparquet-compressors'))
const text = new TextEncoder().encode('abcdefghijk')

describe('actual compressor raw DEFLATE and GZIP member boundaries', () => {
  for (const value of ['', 'a', 'abcdef', 'abcdefghijk']) {
    it(`decodes a complete small raw stream once: ${JSON.stringify(value)}`, () => {
      const expected = new TextEncoder().encode(value)
      const input = deflateRawSync(expected)
      assert.deepEqual(gunzip(input), expected)
      assert.deepEqual(gunzip(input, undefined, 0, 0, { raw: true, maxOutputBytes: expected.length }), expected)
    })
  }

  it('does not decode raw input again into spare caller output capacity', () => {
    const output = new Uint8Array(64).fill(0xA5)
    assert.equal(gunzip(deflateRawSync(text), output), output)
    assert.deepEqual(output.subarray(0, text.length), text)
    assert.deepEqual(output.subarray(text.length), new Uint8Array(64 - text.length).fill(0xA5))
  })

  for (const options of [{ level: 0 as const }, { strategy: constants.Z_FIXED }, { level: 9 as const }]) {
    it(`keeps real stored/fixed/dynamic raw output exact: ${JSON.stringify(options)}`, () => {
      const expected = new TextEncoder().encode('raw deflate value with repeated words '.repeat(1000))
      const input = deflateRawSync(expected, options)
      assert.deepEqual(gunzip(input), expected)
      assert.deepEqual(gunzip(input, new Uint8Array(expected.length)), expected)
      assert.deepEqual(gunzip(input, undefined, 0, 0, { raw: true, maxOutputBytes: expected.length }), expected)
    })
  }

  it('preserves concatenated GZIP decoding into the supplied complete output', () => {
    const second = new TextEncoder().encode('second member')
    const input = Buffer.concat([gzipSync(text), gzipSync(new Uint8Array(0)), gzipSync(second)])
    const output = new Uint8Array(text.length + second.length)
    assert.equal(gunzip(input, output), output)
    assert.deepEqual(output, Uint8Array.from([...text, ...second]))
    assert.deepEqual(gunzip(gzipSync(text)), text)
  })

  it('preserves default raw trailing-byte tolerance and strict trailing-byte refusal', () => {
    const input = Buffer.concat([deflateRawSync(text), Buffer.from([1, 2, 3])])
    // The existing default accepts trailing raw bytes with a supplied output.
    assert.deepEqual(gunzip(input, new Uint8Array(text.length)), new Uint8Array(inflateRawSync(input)))
    assert.deepEqual(gunzip(input), text)
    assert.throws(() => gunzip(input, undefined, 0, 0, { raw: true, maxOutputBytes: text.length }), /trailing raw DEFLATE bytes/)
  })

  it('continues refusing truncated raw data and preserves the strict output cap', () => {
    const input = deflateRawSync(text)
    assert.throws(() => gunzip(input.subarray(0, -1)))
    assert.throws(() => gunzip(input.subarray(0, -1), undefined, 0, 0, { raw: true, maxOutputBytes: text.length }))
    assert.throws(() => gunzip(input, undefined, 0, 0, { raw: true, maxOutputBytes: text.length - 1 }), /output byte limit/)
  })

  for (const kind of ['footer', 'body', 'trailing', 'truncated-next-header']) {
    it(`continues refusing malformed GZIP member boundaries: ${kind}`, () => {
      const gzip = gzipSync(text)
      const input = kind === 'footer'
        ? gzip.subarray(0, -1)
        : kind === 'body'
          ? gzip.subarray(0, 14)
          : Buffer.concat([gzip, kind === 'trailing' ? Buffer.from([1, 2, 3]) : Buffer.from([31, 139])])
      assert.throws(() => gunzip(input))
    })
  }
})

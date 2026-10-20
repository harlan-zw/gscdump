import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import { createRequire } from 'node:module'
import { crc32, gunzipSync, gzipSync } from 'node:zlib'
import { describe, it } from 'vitest'

const icebirdRequire = createRequire(import.meta.resolve('icebird'))
const { gunzip } = await import(icebirdRequire.resolve('hyparquet-compressors'))
const text = new TextEncoder().encode('abcdefghijk')

interface HeaderFields { extra?: Buffer, name?: string, comment?: string, headerCrc?: boolean }

// Rewrite the 10 byte header of a real node:zlib member with optional RFC 1952 fields.
function withHeader(member: Buffer, fields: HeaderFields): Buffer {
  const base = Buffer.from(member.subarray(0, 10))
  const parts: Buffer[] = [base]
  let flag = 0
  if (fields.extra) {
    flag |= 4
    const xlen = Buffer.alloc(2)
    xlen.writeUInt16LE(fields.extra.length)
    parts.push(xlen, fields.extra)
  }
  if (fields.name !== undefined) {
    flag |= 8
    parts.push(Buffer.from(`${fields.name}\0`, 'latin1'))
  }
  if (fields.comment !== undefined) {
    flag |= 16
    parts.push(Buffer.from(`${fields.comment}\0`, 'latin1'))
  }
  if (fields.headerCrc)
    flag |= 2
  base[3] = flag
  if (fields.headerCrc) {
    const crc = Buffer.alloc(2)
    crc.writeUInt16LE(crc32(Buffer.concat(parts)) & 0xFFFF)
    parts.push(crc)
  }
  const result = Buffer.concat([...parts, member.subarray(10)])
  // node:zlib is the oracle: the rewritten member must be a valid GZIP stream.
  assert.deepEqual(new Uint8Array(gunzipSync(result)), new Uint8Array(gunzipSync(member)))
  return result
}

describe('actual compressor GZIP member headers and member iteration', () => {
  const cases: [string, HeaderFields][] = [
    ['FEXTRA', { extra: Buffer.from([65, 66, 4, 0, 1, 2, 3, 4]) }],
    ['FEXTRA larger than the payload', { extra: Buffer.alloc(300, 7) }],
    ['FNAME', { name: 'slice.parquet' }],
    ['FCOMMENT', { comment: 'a comment' }],
    ['FHCRC', { headerCrc: true }],
    ['all optional fields', { extra: Buffer.from([1, 2, 3]), name: 'n', comment: 'c', headerCrc: true }],
  ]
  for (const [label, fields] of cases) {
    it(`skips the ${label} header field`, () => {
      const input = withHeader(gzipSync(text), fields)
      assert.deepEqual(gunzip(input), text)
      assert.deepEqual(gunzip(input, new Uint8Array(text.length)), text)
    })
  }

  it('skips FEXTRA in a later member', () => {
    const second = new TextEncoder().encode('second member')
    const input = Buffer.concat([gzipSync(text), withHeader(gzipSync(second), { extra: Buffer.from([9, 9]) })])
    assert.deepEqual(gunzip(input, new Uint8Array(text.length + second.length)), Uint8Array.from([...text, ...second]))
  })

  it('refuses a truncated FEXTRA field', () => {
    const input = withHeader(gzipSync(text), { extra: Buffer.alloc(16, 1) })
    assert.throws(() => gunzip(input.subarray(0, 20)), /unexpected EOF/)
  })

  it('refuses reserved header flags as node:zlib does', () => {
    const input = Buffer.from(gzipSync(text))
    input[3] = 32
    assert.throws(() => gunzipSync(input))
    assert.throws(() => gunzip(input), /invalid gzip header flags/)
  })

  it('returns every member without a supplied output', () => {
    const second = new TextEncoder().encode('second member')
    const input = Buffer.concat([gzipSync(text), gzipSync(new Uint8Array(0)), gzipSync(second)])
    assert.deepEqual(gunzip(input), Uint8Array.from([...text, ...second]))
  })

  it('grows the output across large members without a supplied output', () => {
    const first = new TextEncoder().encode('first member value '.repeat(20000))
    const second = new Uint8Array(300000).map((_, i) => (i * 31) % 251)
    const input = Buffer.concat([gzipSync(first), gzipSync(second, { level: 0 }), gzipSync(first)])
    assert.deepEqual(gunzip(input), new Uint8Array(gunzipSync(input)))
  })

  it('keeps a supplied output bounded across members', () => {
    const second = new TextEncoder().encode('second member')
    const input = Buffer.concat([gzipSync(text), gzipSync(second)])
    const output = new Uint8Array(text.length)
    assert.equal(gunzip(input, output), output)
    assert.deepEqual(output, text)
  })

  it('iterates 50000 empty members without recursion', () => {
    const empty = gzipSync(new Uint8Array(0))
    const input = Buffer.concat([...Array.from({ length: 50000 }).fill(empty), gzipSync(text)])
    assert.deepEqual(gunzip(input), text)
    assert.deepEqual(gunzip(input, new Uint8Array(text.length)), text)
  })
})

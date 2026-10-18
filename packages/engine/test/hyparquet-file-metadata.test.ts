import type { Row } from '../src/storage'
import { createHash } from 'node:crypto'
import { parquetMetadata } from 'hyparquet'
import { describe, expect, it } from 'vitest'
import { decodeParquetToRows, encodeRowsToParquet, encodeRowsToParquetFlex } from '../src/adapters/hyparquet'
import { SCHEMAS, TABLE_METADATA } from '../src/schema'

const rows = [{ url: '/page', date: '2026-10-01', clicks: 3, impressions: 7, sum_position: 10 }]
const encoders = {
  canonical: (rows: readonly Row[], fileMetadata?: Readonly<Record<string, string>>) => encodeRowsToParquet('pages', rows, { fileMetadata }),
  flex: (rows: readonly Row[], fileMetadata?: Readonly<Record<string, string>>) => encodeRowsToParquetFlex(rows, { columns: SCHEMAS.pages.columns, sortKey: TABLE_METADATA.pages.clusterKey, fileMetadata }),
}

function metadata(bytes: Uint8Array) {
  return parquetMetadata(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer)
}
function hash(bytes: Uint8Array) {
  return createHash('sha256').update(bytes).digest('hex')
}

describe.each(Object.entries(encoders))('%s file metadata', (_name, encode) => {
  it.each([{ input: rows }, { input: [] }])('separates publication bytes while preserving rows and physical schema ($input.length rows)', async ({ input }) => {
    const plain = encode(input)
    const first = encode(input, { 'gscdump.publication': 'publication-a' })
    const second = encode(input, { 'gscdump.publication': 'publication-b' })
    expect(hash(first)).not.toBe(hash(second))
    expect(hash(first)).not.toBe(hash(plain))
    expect(encode(input, { 'gscdump.publication': 'publication-a' })).toEqual(first)
    expect(metadata(first).key_value_metadata).toContainEqual({ key: 'gscdump.publication', value: 'publication-a' })
    expect(metadata(first).schema).toEqual(metadata(plain).schema)
    expect(metadata(first).row_groups).toEqual(metadata(plain).row_groups)
    expect(metadata(first).num_rows).toBe(BigInt(input.length))
    expect(await decodeParquetToRows(first)).toEqual(await decodeParquetToRows(plain))
  })

  it('keeps metadata ordering deterministic and does not mutate caller input', () => {
    const first = Object.freeze({ z: 'last', a: 'first', unicode: '日本語', empty: '' })
    const second = { empty: '', unicode: '日本語', a: 'first', z: 'last' }
    expect(encode(rows, first)).toEqual(encode(rows, second))
    expect(metadata(encode(rows, first)).key_value_metadata).toEqual([
      { key: 'a', value: 'first' },
      { key: 'empty', value: '' },
      { key: 'unicode', value: '日本語' },
      { key: 'z', value: 'last' },
    ])
    expect(Object.keys(first)).toEqual(['z', 'a', 'unicode', 'empty'])
  })

  it('keeps omitted and empty metadata byte-identical to the legacy encoder', () => {
    const legacy = _name === 'canonical'
      ? encodeRowsToParquet('pages', rows)
      : encodeRowsToParquetFlex(rows, { columns: SCHEMAS.pages.columns, sortKey: TABLE_METADATA.pages.clusterKey })
    expect(encode(rows)).toEqual(legacy)
    expect(encode(rows, {})).toEqual(legacy)
  })
})

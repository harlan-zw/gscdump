import type { DecodeParquetGroupsOptions, ParquetRangeSource } from '../src/adapters/hyparquet'
import type { Row } from '../src/storage'
import { readFile } from 'node:fs/promises'
import { parquetMetadata } from 'hyparquet'
import { ByteWriter, parquetWriteRows } from 'hyparquet-writer'
import { describe, expect, it, vi } from 'vitest'
import { decodeParquetRowGroups, decodeParquetToRows, encodeRowsToParquetFlex } from '../src/adapters/hyparquet'

function source(bytes: Uint8Array): ParquetRangeSource {
  return { byteLength: bytes.length, slice: vi.fn(async (start, end = bytes.length) => bytes.slice(start, end).buffer) }
}
async function collect(bytes: Uint8Array, opts: DecodeParquetGroupsOptions = { boundedValues: {} }) {
  const batches: Row[][] = []
  for await (const rows of decodeParquetRowGroups(source(bytes), opts))
    batches.push(rows)
  return batches
}
function fixture(dictionary = false, nullable = false, codec: 'SNAPPY' | 'UNCOMPRESSED' = 'SNAPPY') {
  const rows = Array.from({ length: 513 }, (_, i) => ({ query: nullable && i % 5 === 0 ? null : `${i % 23}:${'宽🌿é'.repeat(50)}`, clicks: i }))
  const writer = new ByteWriter()
  parquetWriteRows({ writer, rows, rowGroupSize: 300, pageSize: 1024, codec, columns: [
    { name: 'query', type: 'STRING', encoding: dictionary ? 'RLE_DICTIONARY' : 'PLAIN', nullable },
    { name: 'clicks', type: 'INT32', nullable: false },
  ] })
  return { rows, bytes: writer.getBytes().slice() }
}

describe('strict bounded Parquet value cursors', () => {
  it('decodes the actual large no-index DuckDB V1 page with bounded output and read bytes', async () => {
    const bytes = new Uint8Array(await readFile(new URL('./fixtures/bounded-values/existing-nearcap.parquet', import.meta.url)))
    const file = source(bytes)
    const actual: Row[] = []
    for await (const batch of decodeParquetRowGroups(file, { boundedValues: { targetRows: 128 } })) {
      expect(batch.length).toBeLessThanOrEqual(128)
      actual.push(...batch)
    }
    expect(actual).toHaveLength(25000)
    expect(actual).toEqual(await decodeParquetToRows(bytes))
    const readBytes = vi.mocked(file.slice).mock.calls.reduce((sum, [start, end]) => sum + (end ?? bytes.length) - start, 0)
    expect(readBytes).toBeLessThan(bytes.length * 1.02)
  })
  it.each(['mixed-plain_dictionary', 'mixed-rle_dictionary'])('preserves %s to PLAIN page transitions', async (name) => {
    const bytes = new Uint8Array(await readFile(new URL(`./fixtures/bounded-values/${name}.parquet`, import.meta.url)))
    expect((await collect(bytes, { boundedValues: { targetRows: 1 } })).flat()).toEqual(await decodeParquetToRows(bytes))
  })
  it('refuses unsupported later page headers before emitting their valid prefix', async () => {
    const bytes = new Uint8Array(await readFile(new URL('./fixtures/bounded-values/unsupported-later-delta.parquet', import.meta.url)))
    expect(await decodeParquetToRows(bytes)).toHaveLength(6)
    await expect(decodeParquetRowGroups(source(bytes), { boundedValues: { targetRows: 1 } }).next()).rejects.toThrow('unsupported data encoding')
  })
  it('rejects a malformed string length without attempting its allocation', async () => {
    const bytes = new Uint8Array(await readFile(new URL('./fixtures/bounded-values/malformed-string-length.parquet', import.meta.url)))
    await expect(decodeParquetRowGroups(source(bytes), { boundedValues: {} }).next()).rejects.toThrow('maxValueBytes')
  })
  it.each([false, true])('preserves optional=%s, dictionary values and byte-capped batches', async (nullable) => {
    const { rows, bytes } = fixture(true, nullable)
    const batches = await collect(bytes, { boundedValues: { targetRows: 19, maxBatchBytes: 12_000 } })
    expect(batches.flat()).toEqual(rows)
    expect(batches.flat()).toEqual(await decodeParquetToRows(bytes))
    expect(batches.every(batch => batch.length <= 19 && JSON.stringify(batch).length * 2 < 12_000)).toBe(true)
    expect(await collect(bytes, { boundedValues: { targetRows: 19, maxBatchBytes: 12_000 } })).toEqual(batches)
  })
  it.each(['SNAPPY', 'UNCOMPRESSED'] as const)('preserves PLAIN %s Unicode and null alignment across pages', async (codec) => {
    const { rows, bytes } = fixture(false, true, codec)
    expect((await collect(bytes, { boundedValues: { targetRows: 13 } })).flat()).toEqual(rows)
  })
  it('supports projection, missing older columns and physical row slices', async () => {
    const { rows, bytes } = fixture(true, true)
    expect((await collect(bytes, { boundedValues: { targetRows: 11 }, columns: ['query', 'missing'], rowStart: 211, rowEnd: 409 })).flat())
      .toEqual(rows.slice(211, 409).map(({ query }) => ({ query })))
    expect((await collect(bytes, { boundedValues: {}, columns: ['missing'], rowStart: 2, rowEnd: 5 })).flat()).toEqual([{}, {}, {}])
  })
  it('preserves scalar/date values with frozen output batches owned by the caller', async () => {
    const rows = Array.from({ length: 15 }, (_, i) => ({ date: `2026-10-${String(i + 1).padStart(2, '0')}`, n: BigInt(i) - 9n, value: i / 7 }))
    const bytes = encodeRowsToParquetFlex(rows, { columns: [{ name: 'date', type: 'DATE' }, { name: 'n', type: 'BIGINT' }, { name: 'value', type: 'DOUBLE' }] })
    const iterator = decodeParquetRowGroups(source(bytes), { boundedValues: { targetRows: 2 } })
    const first = await iterator.next()
    Object.freeze(first.value)
    for (const row of first.value!) Object.freeze(row)
    const all = [...first.value!]
    for await (const batch of iterator) all.push(...batch)
    expect(all).toEqual(await decodeParquetToRows(bytes))
  })
  it('preserves BOOLEAN and FLOAT native scalar columns', async () => {
    const writer = new ByteWriter()
    parquetWriteRows({ writer, rows: [{ enabled: true, n: 1.5 }, { enabled: false, n: -2.25 }], columns: [{ name: 'enabled', type: 'BOOLEAN', nullable: false }, { name: 'n', type: 'FLOAT', nullable: false }] })
    const bytes = writer.getBytes().slice()
    expect((await collect(bytes)).flat()).toEqual(await decodeParquetToRows(bytes))
  })
  it('preserves unsigned scalar boundary values', async () => {
    const writer = new ByteWriter()
    parquetWriteRows({ writer, rows: [{ small: 4294967295, large: 18446744073709551615n }, { small: 2147483648, large: 9223372036854775808n }], columns: [{ name: 'small', type: 'INT32', nullable: false }, { name: 'large', type: 'INT64', nullable: false }], schema: [
      { name: 'root', num_children: 2 },
      { name: 'small', type: 'INT32', converted_type: 'UINT_32', repetition_type: 'REQUIRED' },
      { name: 'large', type: 'INT64', converted_type: 'UINT_64', repetition_type: 'REQUIRED' },
    ] })
    const bytes = writer.getBytes().slice()
    expect((await collect(bytes)).flat()).toEqual(await decodeParquetToRows(bytes))
    expect((await collect(bytes)).flat()[0]).toEqual({ small: 4294967295, large: 18446744073709551615n })
  })
  it('matches the existing DATE normalization outside four-digit years', async () => {
    const days = ['0001-02-03T00:00:00Z', '+010000-02-03T00:00:00Z', '-000001-02-03T00:00:00Z'].map(value => new Date(value).getTime() / 86400000)
    const bytes = encodeRowsToParquetFlex(days.map(date => ({ date })), { columns: [{ name: 'date', type: 'DATE' }] })
    expect((await collect(bytes)).flat()).toEqual(await decodeParquetToRows(bytes))
  })
  it('refuses unannotated binary before output and leaves default behavior alone', async () => {
    const writer = new ByteWriter()
    parquetWriteRows({ writer, rows: [{ raw: new Uint8Array([1, 2]) }], columns: [{ name: 'raw', type: 'BYTE_ARRAY', nullable: false }] })
    const bytes = writer.getBytes().slice()
    await expect(decodeParquetRowGroups(source(bytes), { boundedValues: {} }).next()).rejects.toThrow('flat scalar')
    expect((await collect(bytes, {})).flat()).toEqual(await decodeParquetToRows(bytes))
  })
  it('refuses real page buffer peaks and unsupported codecs before yielding', async () => {
    const { bytes } = fixture()
    await expect(decodeParquetRowGroups(source(bytes), { boundedValues: { maxActiveBytes: 128 } }).next()).rejects.toThrow('maxActiveBytes')
    expect((await collect(bytes, {})).flat()).toEqual(await decodeParquetToRows(bytes))
  })
  it('refuses one oversized string and one oversized row before materialization', async () => {
    const { bytes } = fixture()
    await expect(decodeParquetRowGroups(source(bytes), { boundedValues: { maxValueBytes: 5 } }).next()).rejects.toThrow('maxValueBytes')
    await expect(decodeParquetRowGroups(source(bytes), { boundedValues: { maxBatchBytes: 100 } }).next()).rejects.toThrow('maxBatchBytes')
  })
  it('stops further source reads on return and starts independent cursors for retry', async () => {
    const { bytes, rows } = fixture()
    const file = source(bytes)
    const iterator = decodeParquetRowGroups(file, { boundedValues: { targetRows: 1 } })
    expect((await iterator.next()).value).toEqual(rows.slice(0, 1))
    const calls = vi.mocked(file.slice).mock.calls.length
    await iterator.return(undefined)
    expect(vi.mocked(file.slice).mock.calls.length).toBe(calls)
    expect((await collect(bytes)).flat()).toEqual(rows)
  })
  it('keeps the optional cumulative work budget effective', async () => {
    const { bytes } = fixture()
    await expect(collect(bytes, { boundedValues: {}, limits: { maxReadAndDecompressBytes: 100 } })).rejects.toThrow('maxReadAndDecompressBytes')
  })
  it('charges adaptive header probes to the same work budget before physical reads', async () => {
    const { bytes } = fixture()
    const file = source(bytes)
    await expect(decodeParquetRowGroups(file, { boundedValues: {}, limits: { maxReadAndDecompressBytes: 511 } }).next()).rejects.toThrow('maxReadAndDecompressBytes')
    expect(file.slice).toHaveBeenCalledTimes(2) // Only the separately bounded footer.
  })
  it.each([
    { maxPages: 1 },
    { maxHeaderBytes: 1 },
    { maxDictionaryEntries: 1 },
  ])('enforces strict preflight limits before output: %j', async (boundedValues) => {
    await expect(decodeParquetRowGroups(source(fixture(true).bytes), { boundedValues }).next()).rejects.toThrow()
  })
  it('converts only the admitted output strings, including a large dictionary', async () => {
    const writer = new ByteWriter()
    const text = '宽🌿é'.repeat(10_000)
    const rows = Array.from({ length: 40 }, () => ({ query: text }))
    parquetWriteRows({ writer, rows, columns: [{ name: 'query', type: 'STRING', encoding: 'RLE_DICTIONARY', nullable: false }] })
    const bytes = writer.getBytes().slice()
    const original = TextDecoder.prototype.decode
    let wideStrings = 0
    const spy = vi.spyOn(TextDecoder.prototype, 'decode').mockImplementation(function (input, options) {
      if (input && input.byteLength > 50_000)
        wideStrings++
      return original.call(this, input, options)
    })
    try {
      const iterator = decodeParquetRowGroups(source(bytes), { boundedValues: { targetRows: 1000, maxBatchBytes: 400_000 } })
      const first = (await iterator.next()).value!
      expect(first.length).toBe(2)
      expect(wideStrings).toBe(2)
      expect(first).toEqual(rows.slice(0, 2))
      await iterator.return(undefined)
      expect(wideStrings).toBe(2)
    }
    finally { spy.mockRestore() }
  })
  it('decodes all-null optional pages without reading a value', async () => {
    const bytes = encodeRowsToParquetFlex([{ query: null }, { query: null }], { columns: [{ name: 'query', type: 'VARCHAR', nullable: true }] })
    expect((await collect(bytes)).flat()).toEqual([{ query: null }, { query: null }])
  })
  it('decodes an all-null dictionary column with no dictionary entries', async () => {
    const writer = new ByteWriter()
    const rows = Array.from({ length: 17 }, () => ({ query: null }))
    parquetWriteRows({ writer, rows, columns: [{ name: 'query', type: 'STRING', nullable: true, encoding: 'RLE_DICTIONARY' }] })
    const bytes = writer.getBytes().slice()
    expect(parquetMetadata(bytes.buffer).row_groups[0]!.columns[0]!.meta_data!.dictionary_page_offset).toBeDefined()
    expect((await collect(bytes)).flat()).toEqual(rows)
  })
  it('validates strict mode before I/O and never downgrades to indexed/filter fallback', async () => {
    const file = source(fixture().bytes)
    await expect(decodeParquetRowGroups(file, { boundedValues: { targetRows: 0 } }).next()).rejects.toThrow('targetRows')
    await expect(decodeParquetRowGroups(file, { boundedValues: {}, indexedRowWindow: { targetRows: 10, requiredIndexedColumns: ['query'] } }).next()).rejects.toThrow('cannot be combined')
    expect(file.slice).not.toHaveBeenCalled()
  })
})

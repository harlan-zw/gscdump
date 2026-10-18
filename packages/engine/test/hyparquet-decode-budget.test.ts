import type { DecodeParquetGroupsOptions, ParquetRangeSource } from '../src/adapters/hyparquet'
import type { Row } from '../src/storage'
import { Buffer } from 'node:buffer'
import { readFile } from 'node:fs/promises'
import { parquetMetadata } from 'hyparquet'
import { ByteWriter, parquetWriteRows } from 'hyparquet-writer'
import { writePageHeader } from 'hyparquet-writer/src/datapage.js'
import { writeMetadata } from 'hyparquet-writer/src/metadata.js'
import { describe, expect, it, vi } from 'vitest'
import { decodeParquetRowGroups, decodeParquetToRows, encodeRowsToParquetFlex } from '../src/adapters/hyparquet'

function source(bytes: Uint8Array) {
  return { byteLength: bytes.length, slice: vi.fn(async (start: number, end = bytes.length) => bytes.slice(start, end).buffer) }
}

async function collect(file: ParquetRangeSource, options: DecodeParquetGroupsOptions = {}) {
  const rows: Row[] = []
  for await (const group of decodeParquetRowGroups(file, options))
    rows.push(...group)
  return rows
}

const budget = (maxReadAndDecompressBytes: number): DecodeParquetGroupsOptions => ({ limits: { maxReadAndDecompressBytes } })
const input = Array.from({ length: 128 }, (_, index) => ({ query: `${index} ${'数据🌿café'.repeat(40)}`, clicks: index }))

function fixture(codec: 'SNAPPY' | 'UNCOMPRESSED' = 'SNAPPY', dictionary = false, rowGroupSize = 128) {
  const writer = new ByteWriter()
  parquetWriteRows({ writer, rows: input, codec, rowGroupSize, pageSize: 512, columns: [
    { name: 'query', type: 'STRING', encoding: dictionary ? 'RLE_DICTIONARY' : 'PLAIN', nullable: false, offsetIndex: true },
    { name: 'clicks', type: 'INT32', nullable: false, offsetIndex: true },
  ] })
  return writer.getBytes().slice()
}

// Actual minimal V1 raw and V2 uncompressed-value pages. The V2 fixture has a
// SNAPPY column but is_compressed=false, so no custom decompressor is called.
function rawPage(version: 1 | 2, snappyV1 = false) {
  const template = encodeRowsToParquetFlex([{ clicks: 1 }], { columns: [{ name: 'clicks', type: 'INTEGER', nullable: false }] })
  const metadata = parquetMetadata(template.buffer)
  const writer = new ByteWriter()
  writer.appendUint32(0x31524150)
  const count = 50
  const body = new Uint8Array(count * 4)
  const view = new DataView(body.buffer)
  for (let i = 0; i < count; i++) view.setInt32(i * 4, i, true)
  // Tiny valid literal-only SNAPPY block: length 200, one 200-byte literal.
  const encoded = snappyV1 ? new Uint8Array([200, 1, 240, 199, ...body]) : body
  writePageHeader(writer, version === 1
    ? { type: 'DATA_PAGE', uncompressed_page_size: count * 4, compressed_page_size: encoded.length, data_page_header: { num_values: count, encoding: 'PLAIN', definition_level_encoding: 'RLE', repetition_level_encoding: 'RLE' } }
    : { type: 'DATA_PAGE_V2', uncompressed_page_size: count * 4, compressed_page_size: count * 4, data_page_header_v2: { num_values: count, num_rows: count, num_nulls: 0, encoding: 'PLAIN', definition_levels_byte_length: 0, repetition_levels_byte_length: 0, is_compressed: false } })
  writer.appendBytes(encoded)
  const group = metadata.row_groups[0]!
  const column = group.columns[0]!
  metadata.num_rows = group.num_rows = BigInt(count)
  group.total_byte_size = BigInt(writer.offset - 4)
  group.columns = [{ file_offset: 4n, meta_data: { ...column.meta_data!, codec: version === 1 && !snappyV1 ? 'UNCOMPRESSED' : 'SNAPPY', data_page_offset: 4n, num_values: BigInt(count), total_compressed_size: group.total_byte_size, total_uncompressed_size: group.total_byte_size, encodings: ['PLAIN'], encoding_stats: undefined, dictionary_page_offset: undefined } }]
  writeMetadata(writer, metadata)
  writer.appendUint32(0x31524150)
  return writer.getBytes().slice()
}

describe('opt-in cumulative Parquet decode-buffer admission', () => {
  it('rejects expansion hidden by current-writer footer sizes while omission remains exact', async () => {
    const bytes = fixture()
    const metadata = parquetMetadata(bytes.buffer)
    const declared = metadata.row_groups[0]!.columns.reduce((sum, col) => sum + Number(col.meta_data!.total_uncompressed_size), 0)
    expect(declared).toBeLessThan(16_000)
    expect(Buffer.byteLength(JSON.stringify(input))).toBeGreaterThan(50_000)
    expect(await collect(source(bytes))).toEqual(input)
    await expect(collect(source(bytes), budget(16_000))).rejects.toThrow('maxReadAndDecompressBytes')
    expect(await collect(source(bytes), budget(200_000))).toEqual(input)
  })

  it('charges compressed dictionary output as well as data pages', async () => {
    const bytes = fixture('SNAPPY', true)
    expect(parquetMetadata(bytes.buffer).row_groups[0]!.columns[0]!.meta_data!.dictionary_page_offset).toBeDefined()
    expect(await collect(source(bytes))).toEqual(input)
    await expect(collect(source(bytes), budget(16_000))).rejects.toThrow('maxReadAndDecompressBytes')
    expect(await collect(source(bytes), budget(200_000))).toEqual(input)
  })

  it.each([1, 2] as const)('charges V%i raw/bypassed bodies before reading rather than depending on compressor hooks', async (version) => {
    const bytes = rawPage(version)
    const expected = Array.from({ length: 50 }, (_, clicks) => ({ clicks }))
    expect(await collect(source(bytes))).toEqual(expected)
    const file = source(bytes)
    await expect(collect(file, budget(100))).rejects.toThrow('maxReadAndDecompressBytes')
    expect(file.slice).toHaveBeenCalledTimes(2) // Footer only; no physical page read.
    expect(await collect(source(bytes), budget(500))).toEqual(expected)
  })

  it('admits UNCOMPRESSED bytes only within the group budget', async () => {
    const bytes = fixture('UNCOMPRESSED')
    expect(await collect(source(bytes), budget(200_000))).toEqual(input)
    await expect(collect(source(bytes), budget(16_000))).rejects.toThrow('maxReadAndDecompressBytes')
  })

  it('charges compressed V1 DATA_PAGE output separately from its source read', async () => {
    const bytes = rawPage(1, true)
    const expected = Array.from({ length: 50 }, (_, clicks) => ({ clicks }))
    expect(await collect(source(bytes))).toEqual(expected)
    expect(await collect(source(bytes), budget(500))).toEqual(expected)
    const file = source(bytes)
    await expect(collect(file, budget(300))).rejects.toThrow('maxReadAndDecompressBytes')
    expect(file.slice).toHaveBeenCalledTimes(3) // Footer and admitted compressed body.
  })

  it('covers nullable V2 definition levels through source ranges and preserves nulls', async () => {
    const rows = Array.from({ length: 128 }, (_, i) => ({ query: i % 2 ? input[i]!.query : null }))
    const bytes = encodeRowsToParquetFlex(rows, { columns: [{ name: 'query', type: 'VARCHAR', nullable: true }] })
    const column = parquetMetadata(bytes.buffer).row_groups[0]!.columns[0]!.meta_data!
    expect(column.codec).toBe('SNAPPY')
    expect(column.encoding_stats?.some(stat => stat.page_type === 'DATA_PAGE_V2')).toBe(true)
    expect(await collect(source(bytes), budget(100_000))).toEqual(rows)
    await expect(collect(source(bytes), budget(10_000))).rejects.toThrow('maxReadAndDecompressBytes')
  })

  it('does not enable a compression codec that the original reader rejects', async () => {
    const bytes = rawPage(1)
    const metadata = parquetMetadata(bytes.buffer)
    metadata.row_groups[0]!.columns[0]!.meta_data!.codec = 'GZIP'
    const footerBytes = new DataView(bytes.buffer, bytes.length - 8).getUint32(0, true)
    const writer = new ByteWriter()
    writer.appendBytes(bytes.subarray(0, bytes.length - footerBytes - 8))
    writeMetadata(writer, metadata)
    writer.appendUint32(0x31524150)
    const unsupported = writer.getBytes().slice()
    await expect(collect(source(unsupported))).rejects.toThrow('unsupported compression codec: GZIP')
    await expect(collect(source(unsupported), budget(1_000))).rejects.toThrow('unsupported compression codec: GZIP')
  })

  it('refuses unbounded ZSTD allocation only under the explicit option', async () => {
    const bytes = new Uint8Array(await readFile(new URL('./fixtures/pages-zstd.parquet', import.meta.url)))
    const expected = await decodeParquetToRows(bytes)
    expect(await collect(source(bytes))).toEqual(expected)
    await expect(collect(source(bytes), budget(1_000_000))).rejects.toThrow('ZSTD')
    expect(await decodeParquetToRows(bytes, budget(1) as never)).toEqual(expected)
  })

  it('resets for each physical group and each independent retry', async () => {
    const bytes = fixture('SNAPPY', false, 16)
    expect(await collect(source(bytes), budget(16_000))).toEqual(input)
    await expect(collect(source(bytes), budget(500))).rejects.toThrow('maxReadAndDecompressBytes')
    expect(await collect(source(bytes), budget(16_000))).toEqual(input)
  })

  it('keeps one cumulative budget across indexed windows and closes on refusal', async () => {
    const bytes = fixture()
    const indexedRowWindow = { targetRows: 8, requiredIndexedColumns: ['query'], rangeCacheBytes: 2 * 1024 * 1024 }
    const iterator = decodeParquetRowGroups(source(bytes), { ...budget(30_000), indexedRowWindow })
    expect((await iterator.next()).value).toHaveLength(8)
    await expect((async () => {
      for await (const _rows of iterator) { /* Consume remaining windows. */ }
    })()).rejects.toThrow('maxReadAndDecompressBytes')
    expect(await iterator.next()).toEqual({ done: true, value: undefined })
    expect(await collect(source(bytes), { ...budget(500_000), indexedRowWindow })).toEqual(input)
  })

  it('preserves transport cancellation and gives a new iterator a fresh budget', async () => {
    const bytes = fixture()
    const error = new Error('caller aborted range request')
    const file = source(bytes)
    file.slice.mockImplementation(async (start, end = bytes.length) => {
      if (start === 4)
        throw error
      return bytes.slice(start, end).buffer
    })
    await expect(collect(file, budget(200_000))).rejects.toBe(error)
    expect(await collect(source(bytes), budget(200_000))).toEqual(input)
  })

  it('does not read later groups after iterator return', async () => {
    const bytes = fixture('SNAPPY', false, 16)
    const file = source(bytes)
    const iterator = decodeParquetRowGroups(file, budget(16_000))
    expect((await iterator.next()).value).toHaveLength(16)
    const reads = file.slice.mock.calls.length
    await iterator.return(undefined)
    expect(file.slice).toHaveBeenCalledTimes(reads)
    expect(await collect(source(bytes), budget(16_000))).toEqual(input)
  })

  it('captures the validated option once and preserves ineligible window fallback', async () => {
    const bytes = fixture('SNAPPY', true, 16)
    const options = { ...budget(16_000), indexedRowWindow: { targetRows: 1, requiredIndexedColumns: ['query'] } }
    const file = source(bytes)
    const iterator = decodeParquetRowGroups(file, options)
    const first = await iterator.next()
    expect(first.value).toHaveLength(16) // Dictionary remains ineligible for windows.
    options.limits!.maxReadAndDecompressBytes = 1
    const rows = [...first.value!]
    for await (const batch of iterator) rows.push(...batch)
    expect(rows).toEqual(input)
    expect(await collect(source(bytes), budget(16_000))).toEqual(input)
  })

  it.each([0, -1, NaN, Infinity, 1.5, Number.MAX_SAFE_INTEGER + 1])('validates the opt-in budget before I/O: %s', async (value) => {
    const file = source(fixture())
    await expect(collect(file, budget(value))).rejects.toThrow('maxReadAndDecompressBytes')
    expect(file.slice).not.toHaveBeenCalled()
  })
})

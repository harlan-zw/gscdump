import type { FileMetaData } from 'hyparquet'
import type { ColumnSource } from 'hyparquet-writer'
import type { DecodeParquetGroupsOptions, ParquetRangeSource } from '../src/adapters/hyparquet'
import type { Row } from '../src/storage'
import { parquetMetadata, readOffsetIndex } from 'hyparquet'
import { ByteWriter, parquetWriteRows } from 'hyparquet-writer'
import { writeMetadata } from 'hyparquet-writer/src/metadata.js'
import { serializeTCompactProtocol } from 'hyparquet-writer/src/thrift.js'
import { describe, expect, it, vi } from 'vitest'
import { decodeParquetRowGroups, decodeParquetToRows } from '../src/adapters/hyparquet'
import * as rangeCache from '../src/adapters/parquet-range-cache'

const policy = { targetRows: 7, requiredIndexedColumns: ['query', 'url'], rangeCacheBytes: 2 * 1024 * 1024 }
const rows = Array.from({ length: 73 }, (_, i) => ({ query: `${i}日本語🌿${'q'.repeat(40)}`, url: `/路/${i}/${'u'.repeat(40)}`, clicks: i, date: 20727 + i % 3 }))

function fixture(options: { unindexed?: string[], dictionary?: boolean, binary?: boolean, count?: number } = {}) {
  const writer = new ByteWriter()
  const columns: Omit<ColumnSource, 'data'>[] = [
    { name: 'query', type: 'STRING', encoding: options.dictionary ? 'RLE_DICTIONARY' : 'PLAIN', nullable: false },
    { name: 'url', type: 'STRING', encoding: 'PLAIN', nullable: false },
    { name: 'clicks', type: 'INT32', encoding: 'PLAIN', nullable: false },
    { name: 'date', type: 'INT32', encoding: 'PLAIN', nullable: true },
  ]
  if (options.binary)
    columns.push({ name: 'raw', type: 'BYTE_ARRAY', encoding: 'PLAIN', nullable: false })
  parquetWriteRows({
    writer,
    rows: rows.slice(0, options.count ?? rows.length).map(row => ({ ...row, raw: new Uint8Array([1, 2]) })),
    columns: columns.map(col => ({ ...col, offsetIndex: !options.unindexed?.includes(col.name) })),
    rowGroupSize: 25,
    pageSize: 128,
    codec: 'UNCOMPRESSED',
    schema: [
      { name: 'root', num_children: columns.length },
      { name: 'query', type: 'BYTE_ARRAY', converted_type: 'UTF8', repetition_type: 'REQUIRED' },
      { name: 'url', type: 'BYTE_ARRAY', converted_type: 'UTF8', repetition_type: 'REQUIRED' },
      { name: 'clicks', type: 'INT32', repetition_type: 'REQUIRED' },
      { name: 'date', type: 'INT32', converted_type: 'DATE', repetition_type: 'OPTIONAL' },
      ...(options.binary ? [{ name: 'raw', type: 'FIXED_LEN_BYTE_ARRAY' as const, type_length: 2, repetition_type: 'REQUIRED' as const }] : []),
    ],
  })
  return writer.getBytes().slice()
}

function source(bytes: Uint8Array) {
  return { byteLength: bytes.length, slice: vi.fn(async (start: number, end = bytes.length) => bytes.slice(start, end).buffer) }
}

async function batches(file: ParquetRangeSource, options: DecodeParquetGroupsOptions = {}) {
  const output: Row[][] = []
  for await (const batch of decodeParquetRowGroups(file, options))
    output.push(batch)
  return output
}

function changeMetadata(bytes: Uint8Array, change: (metadata: FileMetaData) => void) {
  const metadata = parquetMetadata(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength))
  const footerLength = new DataView(bytes.buffer, bytes.byteOffset + bytes.length - 8).getUint32(0, true)
  const writer = new ByteWriter()
  writer.appendBytes(bytes.subarray(0, bytes.length - footerLength - 8))
  change(metadata)
  writeMetadata(writer, metadata)
  writer.appendUint32(0x31524150)
  return writer.getBytes().slice()
}

function changeIndex(bytes: Uint8Array, column: number, change: (index: ReturnType<typeof readOffsetIndex>) => void) {
  const metadata = parquetMetadata(bytes.buffer)
  const chunk = metadata.row_groups[0]!.columns[column]!
  const index = readOffsetIndex({ view: new DataView(bytes.buffer, Number(chunk.offset_index_offset), chunk.offset_index_length), offset: 0 })
  change(index)
  const footerLength = new DataView(bytes.buffer, bytes.length - 8).getUint32(0, true)
  const writer = new ByteWriter()
  writer.appendBytes(bytes.subarray(0, bytes.length - footerLength - 8))
  chunk.offset_index_offset = BigInt(writer.offset)
  serializeTCompactProtocol(writer, {
    field_1: index.page_locations.map(page => ({ field_1: page.offset, field_2: page.compressed_page_size, field_3: page.first_row_index })),
  })
  chunk.offset_index_length = writer.offset - Number(chunk.offset_index_offset)
  writeMetadata(writer, metadata)
  writer.appendUint32(0x31524150)
  return writer.getBytes().slice()
}

describe('indexed Parquet row windows', () => {
  it('splits eligible physical groups in order without changing decoded values', async () => {
    const bytes = fixture()
    const metadata = parquetMetadata(bytes.buffer)
    expect(metadata.row_groups.every(group => group.columns.slice(0, 2).every(col => col.offset_index_length! > 0))).toBe(true)
    const actual = await batches(source(bytes), { indexedRowWindow: policy })
    expect(actual.map(batch => batch.length)).toEqual([7, 7, 7, 4, 7, 7, 7, 4, 7, 7, 7, 2])
    expect(actual.flat()).toEqual(await decodeParquetToRows(bytes))
  })

  it('keeps omission and the legacy buffered decoder unchanged', async () => {
    const bytes = fixture()
    expect((await batches(source(bytes))).map(batch => batch.length)).toEqual([25, 25, 23])
    expect(await decodeParquetToRows(bytes, { indexedRowWindow: { targetRows: 0 } } as never))
      .toEqual((await batches(source(bytes))).flat())
  })

  it('keeps unannotated BYTE_ARRAY strings detached from cached bytes', async () => {
    const bytes = changeMetadata(fixture(), (metadata) => {
      delete metadata.schema[1]!.converted_type
    })
    const output = await batches(source(bytes), { indexedRowWindow: policy })
    expect(output.every(batch => batch.length <= 7)).toBe(true)
    expect(output.every(batch => batch.every(row => typeof row.query === 'string'))).toBe(true)
    expect(output.flat()).toEqual(await decodeParquetToRows(bytes))
  })

  it.each([
    { label: 'unindexed query', fixture: { unindexed: ['query'] } },
    { label: 'unindexed url', fixture: { unindexed: ['url'] } },
    { label: 'dictionary query', fixture: { dictionary: true } },
    { label: 'binary output', fixture: { binary: true } },
  ])('uses the exact uncached original path for $label', async ({ fixture: opts }) => {
    const bytes = fixture(opts)
    const original = source(bytes)
    const candidate = source(bytes)
    expect(await batches(candidate, { indexedRowWindow: policy })).toEqual(await batches(original))
    expect(candidate.slice.mock.calls).toEqual(original.slice.mock.calls)
  })

  it.each([
    { requiredIndexedColumns: ['query', 'missing'] },
    { requiredIndexedColumns: ['query', 'url'], columns: ['query', 'clicks'] },
  ])('requires every designated column to be present and selected: %j', async ({ requiredIndexedColumns, columns }) => {
    const bytes = fixture()
    const original = source(bytes)
    const candidate = source(bytes)
    expect(await batches(candidate, { columns, indexedRowWindow: { ...policy, requiredIndexedColumns } }))
      .toEqual(await batches(original, { columns }))
    expect(candidate.slice.mock.calls).toEqual(original.slice.mock.calls)
  })

  it('decides eligibility independently for each group', async () => {
    const bytes = changeMetadata(fixture(), metadata => delete metadata.row_groups[1]!.columns[0]!.offset_index_offset)
    const output = await batches(source(bytes), { indexedRowWindow: policy })
    expect(output.map(batch => batch.length)).toEqual([7, 7, 7, 4, 25, 7, 7, 7, 2])
    expect(output.flat()).toEqual(await decodeParquetToRows(bytes))
  })

  it.each(['dictionary offset zero', 'plain dictionary encoding', 'RLE dictionary encoding', 'index outside file', 'zero index length'])(
    'keeps the original path for ineligible metadata: %s',
    async (reason) => {
      const bytes = changeMetadata(fixture(), (metadata) => {
        for (const group of metadata.row_groups) {
          const col = group.columns[0]!
          if (reason === 'dictionary offset zero')
            col.meta_data!.dictionary_page_offset = 0n
          if (reason === 'plain dictionary encoding')
            col.meta_data!.encodings.push('PLAIN_DICTIONARY')
          if (reason === 'RLE dictionary encoding')
            col.meta_data!.encodings.push('RLE_DICTIONARY')
          if (reason === 'index outside file')
            col.offset_index_offset = 999_999n
          if (reason === 'zero index length')
            col.offset_index_length = 0
        }
      })
      const original = source(bytes)
      const candidate = source(bytes)
      expect(await batches(candidate, { indexedRowWindow: policy })).toEqual(await batches(original))
      expect(candidate.slice.mock.calls).toEqual(original.slice.mock.calls)
    },
  )

  it.each([
    { rowStart: 11, rowEnd: 61, columns: ['query', 'url', 'missing'] },
    { rowStart: 11, rowEnd: 61, columns: ['query', 'url'], filter: { clicks: { $gte: 19 } } },
    { rowStart: 25, rowEnd: 25 },
    { rowStart: 72, rowEnd: 90 },
  ])('preserves range, projection, missing columns and filters: %j', async (options) => {
    const bytes = fixture()
    expect((await batches(source(bytes), { ...options, indexedRowWindow: policy })).flat())
      .toEqual(await decodeParquetToRows(bytes, options))
  })

  it('preserves empty schema-bearing input', async () => {
    expect(await batches(source(fixture({ count: 0 })), { indexedRowWindow: policy })).toEqual([])
  })

  it('snapshots the policy before the first awaited read', async () => {
    const bytes = fixture()
    const mutable = { ...policy, requiredIndexedColumns: [...policy.requiredIndexedColumns] }
    const file = source(bytes)
    file.slice.mockImplementation(async (start, end = bytes.length) => {
      mutable.targetRows = 0
      mutable.requiredIndexedColumns.length = 0
      return bytes.slice(start, end).buffer
    })
    expect((await batches(file, { indexedRowWindow: mutable })).map(batch => batch.length))
      .toEqual([7, 7, 7, 4, 7, 7, 7, 4, 7, 7, 7, 2])
  })

  it.each([
    { targetRows: 0 },
    { targetRows: -1 },
    { targetRows: 1.5 },
    { targetRows: Infinity },
    { requiredIndexedColumns: [] },
    { requiredIndexedColumns: [''] },
    { rangeCacheBytes: -1 },
    { rangeCacheBytes: 0.5 },
    { rangeCacheBytes: 2 * 1024 * 1024 + 1 },
  ])('rejects invalid opt-in before reading: %j', async (change) => {
    const file = source(fixture())
    await expect(batches(file, { indexedRowWindow: { ...policy, ...change } })).rejects.toThrow('indexedRowWindow')
    expect(file.slice).not.toHaveBeenCalled()
  })

  it('retains physical-group limits even when target rows are smaller', async () => {
    const file = source(fixture())
    await expect(batches(file, { indexedRowWindow: policy, limits: { maxRowGroupRows: 10 } })).rejects.toThrow('maxRowGroupRows')
    expect(file.slice).toHaveBeenCalledTimes(2)
  })

  it('reduces repeated reads only within an eligible group and never shares a cache across passes', async () => {
    const bytes = fixture()
    const uncached = source(bytes)
    const cached = source(bytes)
    const expected = await batches(uncached, { indexedRowWindow: { ...policy, rangeCacheBytes: 0 } })
    expect(await batches(cached, { indexedRowWindow: policy })).toEqual(expected)
    const firstPass = cached.slice.mock.calls.map(call => [...call])
    expect(firstPass.length).toBeLessThan(uncached.slice.mock.calls.length)
    expect(await batches(cached, { indexedRowWindow: policy })).toEqual(expected)
    expect(cached.slice.mock.calls.slice(firstPass.length)).toEqual(firstPass)
  })

  it('stops pulling on return and does not swallow an uncached pinned-source failure', async () => {
    const file = source(fixture())
    const iterator = decodeParquetRowGroups(file, { indexedRowWindow: policy })
    expect((await iterator.next()).value).toHaveLength(7)
    const readCount = file.slice.mock.calls.length
    await iterator.return(undefined)
    expect(file.slice).toHaveBeenCalledTimes(readCount)
    const fresh = decodeParquetRowGroups(file, { indexedRowWindow: { ...policy, rangeCacheBytes: 0 } })
    expect((await fresh.next()).value).toHaveLength(7)
    const error = new Error('pinned ETag changed')
    file.slice.mockRejectedValue(error)
    await expect(fresh.next()).rejects.toBe(error)
    expect((await fresh.next()).done).toBe(true)
  })

  it.each(['complete', 'return', 'failure'] as const)('releases the actual group cache on %s', async (finish) => {
    const original = rangeCache.parquetRangeCache
    const closers: ReturnType<typeof vi.fn>[] = []
    const spy = vi.spyOn(rangeCache, 'parquetRangeCache').mockImplementation((...args) => {
      const cache = original(...args)
      closers.push(vi.spyOn(cache, 'close'))
      return cache
    })
    try {
      const bytes = fixture()
      if (finish === 'failure') {
        const column = parquetMetadata(bytes.buffer).row_groups[0]!.columns[0]!
        bytes.fill(255, Number(column.offset_index_offset), Number(column.offset_index_offset) + column.offset_index_length!)
      }
      const iterator = decodeParquetRowGroups(source(bytes), { indexedRowWindow: policy })
      if (finish === 'complete') {
        for await (const _ of iterator) { /* Complete every physical group. */ }
      }
      else if (finish === 'return') {
        await iterator.next()
        await iterator.return(undefined)
      }
      else {
        await expect(iterator.next()).rejects.toThrow()
      }
      expect(closers).toHaveLength(finish === 'complete' ? 3 : 1)
      for (const close of closers)
        expect(close).toHaveBeenCalledOnce()
    }
    finally { spy.mockRestore() }
  })

  it('rejects corrupt attempted indexes rather than returning empty rows', async () => {
    const bytes = fixture()
    const meta = parquetMetadata(bytes.buffer)
    const index = meta.row_groups[0]!.columns[0]!
    bytes.fill(255, Number(index.offset_index_offset), Number(index.offset_index_offset) + index.offset_index_length!)
    await expect(batches(source(bytes), { indexedRowWindow: policy })).rejects.toThrow()
  })

  it.each([
    'first row',
    'row order',
    'page offset',
    'page size',
    'empty index',
    'unrequired index',
    'filter-only index',
  ])(
    'rejects structurally corrupt window indexes before yielding: %s',
    async (reason) => {
      // The URL index is not designated in the final two cases, but the reader
      // still uses it when windows enable offset indexes for the entire read.
      const bytes = changeIndex(fixture(), reason.includes('index') && reason !== 'empty index' ? 1 : 0, (index) => {
        if (reason === 'row order')
          index.page_locations[1]!.first_row_index = index.page_locations[0]!.first_row_index
        else if (reason === 'page offset')
          index.page_locations[0]!.offset = 1n
        else if (reason === 'page size')
          index.page_locations[0]!.compressed_page_size = 0
        else if (reason === 'empty index')
          index.page_locations.length = 0
        else
          index.page_locations[0]!.first_row_index = 1n
      })
      expect(await decodeParquetToRows(bytes)).toEqual(await decodeParquetToRows(fixture()))
      const options = reason === 'filter-only index'
        ? { columns: ['query'], filter: { url: { $ne: 'absent' } } }
        : {}
      const iterator = decodeParquetRowGroups(source(bytes), { ...options, indexedRowWindow: { ...policy, requiredIndexedColumns: ['query'] } })
      await expect(iterator.next()).rejects.toThrow('offset index')
    },
  )
})

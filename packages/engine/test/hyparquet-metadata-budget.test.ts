import type { EncodeParquetBatchesOptions, ParquetRangeSource } from '../src/adapters/hyparquet'
import type { Row } from '../src/storage'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DuckDBInstance } from '@duckdb/node-api'
import { parquetMetadata, readOffsetIndex } from 'hyparquet'
import { describe, expect, it, vi } from 'vitest'
import { decodeParquetRowGroups, decodeParquetToRows, encodeParquetRowBatches } from '../src/adapters/hyparquet'

const columns = [
  { name: 'date', type: 'DATE', nullable: false },
  { name: 'query', type: 'VARCHAR', nullable: true },
  { name: 'clicks', type: 'INTEGER', nullable: false },
] as const

function source(bytes: Uint8Array): ParquetRangeSource {
  return { byteLength: bytes.length, slice: async (start, end) => bytes.slice(start, end).buffer }
}

async function encode(batches: Iterable<readonly Row[]>, options: Partial<EncodeParquetBatchesOptions> = {}) {
  const chunks: Uint8Array[] = []
  const result = await encodeParquetRowBatches(batches, { columns, ...options }, async (chunk) => {
    chunks.push(chunk.slice())
  })
  const bytes = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0))
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.length
  }
  return { bytes, chunks, rowCount: result.rowCount }
}

async function collect(bytes: Uint8Array, options: Parameters<typeof decodeParquetRowGroups>[1]) {
  const rows: Row[] = []
  for await (const batch of decodeParquetRowGroups(source(bytes), options))
    rows.push(...batch)
  return rows
}

const wideRows = Array.from({ length: 12 }, (_, index) => ({
  date: `2026-10-${String(index + 1).padStart(2, '0')}`,
  query: index === 5 ? null : `${index}-${'数据🌿'.repeat(2500)}`,
  clicks: index,
}))
const overflowOptions = { rowGroupSize: 1, limits: { maxRetainedMetadataBytes: 128 * 1024 } }

describe('optional Parquet statistics omission', () => {
  it('keeps ordinary bytes and metadata identical when the opt-in budget fits', async () => {
    const rows = [{ date: '2026-10-01', query: '日本語😀', clicks: 1 }, { date: '2026-10-02', query: null, clicks: 2 }]
    const normal = await encode([rows], { rowGroupSize: 1 })
    const opted = await encode([rows], { rowGroupSize: 1, metadataOverflow: 'omit-statistics' })
    expect(opted.bytes).toEqual(normal.bytes)
    expect(parquetMetadata(opted.bytes.buffer).row_groups[0].columns[1].meta_data?.statistics).toBeDefined()
  })

  it('retains the default refusal, but omits whole optional structures after opt-in overflow', async () => {
    await expect(encode([wideRows], overflowOptions)).rejects.toThrow('maxRetainedMetadataBytes')
    const result = await encode([wideRows], { ...overflowOptions, metadataOverflow: 'omit-statistics' })
    expect(result.rowCount).toBe(wideRows.length)
    expect(await decodeParquetToRows(result.bytes)).toEqual(wideRows)
    const metadata = parquetMetadata(result.bytes.buffer)
    expect(Number(metadata.num_rows)).toBe(wideRows.length)
    for (const group of metadata.row_groups) {
      expect(Number(group.num_rows)).toBe(1)
      for (const column of group.columns) {
        expect(column.meta_data?.statistics).toBeUndefined()
        expect(column.column_index_offset).toBeUndefined()
        expect(column.column_index_length).toBeUndefined()
        expect(column.meta_data?.encoding_stats).toBeDefined()
        expect(column.meta_data?.encodings.length).toBeGreaterThan(0)
      }
    }
  })

  it('does not change dictionary/page bytes, row groups, required metadata or schema', async () => {
    const rows = Array.from({ length: 40 }, (_, index) => ({ date: '2026-10-01', query: `dictionary-${index % 2}-${'x'.repeat(10_000)}`, clicks: index }))
    const normal = await encode([rows], { rowGroupSize: 10 })
    const omitted = await encode([rows], { rowGroupSize: 10, limits: { maxRetainedMetadataBytes: 40_000 }, metadataOverflow: 'omit-statistics' })
    // Data groups flush before indexes/footer. Omission must never rewrite them.
    expect(omitted.chunks.slice(0, -1)).toEqual(normal.chunks.slice(0, -1))
    const normalMetadata = parquetMetadata(normal.bytes.buffer)
    const omittedMetadata = parquetMetadata(omitted.bytes.buffer)
    expect(omittedMetadata.schema).toEqual(normalMetadata.schema)
    expect(omittedMetadata.num_rows).toEqual(normalMetadata.num_rows)
    expect(omittedMetadata.row_groups).toHaveLength(normalMetadata.row_groups.length)
    for (let index = 0; index < normalMetadata.row_groups.length; index++) {
      const normalGroup = normalMetadata.row_groups[index]
      const omittedGroup = omittedMetadata.row_groups[index]
      for (let column = 0; column < normalGroup.columns.length; column++) {
        const { statistics: _statistics, ...required } = normalGroup.columns[column].meta_data!
        expect(omittedGroup.columns[column].meta_data).toEqual(required)
      }
    }
    expect(normalMetadata.row_groups[0].columns[1].meta_data?.dictionary_page_offset).toBeDefined()
    expect(await decodeParquetToRows(omitted.bytes)).toEqual(rows)
  })

  it('preserves offset indexes while omitting page bounds and supports indexed row windows', async () => {
    // Unique 1 KiB strings avoid dictionaries; the 1 MiB page target creates
    // multiple pages in each 8 MiB scalar-budget group.
    const rows = Array.from({ length: 2400 }, (_, index) => ({ date: '2026-10-01', query: `${String(index).padStart(5, '0')}-${'x'.repeat(1024)}`, clicks: index }))
    const options = { rowGroupSize: 2400, limits: { maxRowGroupBytes: 8 * 1024 * 1024, maxBatchBytes: 8 * 1024 * 1024 } }
    const normal = await encode([rows], options)
    const omitted = await encode([rows], { ...options, limits: { ...options.limits, maxRetainedMetadataBytes: 8000 }, metadataOverflow: 'omit-statistics' })
    const before = parquetMetadata(normal.bytes.buffer).row_groups[0].columns[1]
    const after = parquetMetadata(omitted.bytes.buffer).row_groups[0].columns[1]
    expect(before.column_index_offset).toBeDefined()
    expect(after.column_index_offset).toBeUndefined()
    expect(after.offset_index_offset).toBeDefined()
    const index = (bytes: Uint8Array, chunk: typeof after) => readOffsetIndex({ view: new DataView(bytes.buffer, Number(chunk.offset_index_offset), chunk.offset_index_length), offset: 0 })
    expect(index(omitted.bytes, after)).toEqual(index(normal.bytes, before))
    expect(omitted.chunks.slice(0, -1)).toEqual(normal.chunks.slice(0, -1))
    expect(await collect(omitted.bytes, { rowStart: 1000, rowEnd: 1100, columns: ['query', 'clicks'], indexedRowWindow: { targetRows: 32, requiredIndexedColumns: ['query'] } }))
      .toEqual(rows.slice(1000, 1100).map(({ query, clicks }) => ({ query, clicks })))
  })

  it('does not interpret omitted statistics as no matches or no nulls in filtered/projected reads', async () => {
    const result = await encode([wideRows], { ...overflowOptions, metadataOverflow: 'omit-statistics' })
    expect(await collect(result.bytes, { columns: ['clicks'], filter: { query: { $eq: null } } })).toEqual([{ clicks: 5 }])
    expect(await collect(result.bytes, { columns: ['date', 'clicks'], filter: { clicks: { $gte: 10 } } }))
      .toEqual(wideRows.slice(10).map(({ date, clicks }) => ({ date, clicks })))
    expect(await collect(result.bytes, { columns: ['clicks'], rowStart: 2, rowEnd: 7, boundedValues: { targetRows: 2 } }))
      .toEqual(wideRows.slice(2, 7).map(({ clicks }) => ({ clicks })))
    await expect(collect(result.bytes, { boundedValues: {}, filter: { clicks: { $gte: 10 } } })).rejects.toThrow()
  })

  it('preserves independent DuckDB predicate/null semantics with omitted statistics', async () => {
    const result = await encode([wideRows], { ...overflowOptions, metadataOverflow: 'omit-statistics' })
    const directory = await mkdtemp(join(tmpdir(), 'gscdump-optional-stats-'))
    const instance = await DuckDBInstance.create(':memory:', { threads: '1' })
    const connection = await instance.connect()
    try {
      const path = join(directory, 'rows.parquet')
      await writeFile(path, result.bytes)
      const escapedPath = path.replaceAll('\'', '\'\'')
      const reader = await connection.runAndReadAll(`SELECT count(*)::INTEGER AS n, count(query)::INTEGER AS nonnull, sum(clicks)::INTEGER AS clicks FROM read_parquet('${escapedPath}') WHERE date >= DATE '2026-10-06'`)
      expect(reader.getRowObjects()).toEqual([{ n: 7, nonnull: 6, clicks: 56 }])
    }
    finally {
      connection.closeSync()
      instance.closeSync()
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('is deterministic across producer batches and retains explicit file metadata', async () => {
    const options = { ...overflowOptions, metadataOverflow: 'omit-statistics' as const, fileMetadata: { publication: 'immutable-proof', z: 'last' } }
    const together = await encode([wideRows], options)
    const separate = await encode(wideRows.map(row => [row]), options)
    expect(separate.bytes).toEqual(together.bytes)
    expect(parquetMetadata(separate.bytes.buffer).key_value_metadata).toEqual([{ key: 'publication', value: 'immutable-proof' }, { key: 'z', value: 'last' }])
  })

  it('preserves sixteen long legacy values plus thirty thousand incoming rows under the original 8 MiB metadata cap', async () => {
    // The real legacy fixture has only four referenced 240 KiB dictionary
    // values. The unused dictionary is irrelevant to the downstream encoder:
    // repeated retained min/max values across its small groups cause overflow.
    const queries = Array.from({ length: 4 }, (_, index) => `${index}-${'q'.repeat(239_998)}`)
    const legacy = Array.from({ length: 16 }, (_, index) => ({ date: '2026-10-01', query: queries[index % 4], clicks: index }))
    const incoming = Array.from({ length: 30_000 }, (_, index) => ({ date: '2026-10-18', query: `query-${index}`, clicks: 1 }))
    function* batches() {
      yield legacy.slice(0, 8)
      yield legacy.slice(8)
      for (let offset = 0; offset < incoming.length; offset += 500)
        yield incoming.slice(offset, offset + 500)
    }
    await expect(encode(batches(), { rowGroupSize: 1000 })).rejects.toThrow('maxRetainedMetadataBytes')
    const result = await encode(batches(), { rowGroupSize: 1000, metadataOverflow: 'omit-statistics' })
    expect(result.rowCount).toBe(30_016)
    expect(await decodeParquetToRows(result.bytes)).toEqual([...legacy, ...incoming])
    expect(await collect(result.bytes, { rowStart: 12, rowEnd: 20, boundedValues: { targetRows: 2, maxValueBytes: 256 * 1024, maxHeaderBytes: 8 * 1024 * 1024, maxActiveBytes: 40 * 1024 * 1024 } }))
      .toEqual([...legacy, ...incoming].slice(12, 20))
  })

  it('distinguishes retained full statistics from truncated serialized footer bounds', async () => {
    const rows = Array.from({ length: 8 }, (_, index) => ({ date: '2026-10-01', query: `${index % 4}-${'q'.repeat(239_998)}`, clicks: index }))
    const unchanged = await encode([rows], { rowGroupSize: 1000, metadataOverflow: 'omit-statistics' })
    const footerBytes = new DataView(unchanged.bytes.buffer).getUint32(unchanged.bytes.length - 8, true)
    expect(footerBytes).toBeLessThan(1024 * 1024)
    expect(parquetMetadata(unchanged.bytes.buffer).row_groups[0].columns[1].meta_data?.statistics).toBeDefined()
    // The writer truncates serialized BYTE_ARRAY statistics. Its retained full
    // strings can approach the metadata budget without a large encoded footer.
    // This fixture is not evidence of a host reader/encoder footer mismatch.
    expect(await collect(unchanged.bytes, {})).toEqual(rows)
    const matched = await encode([rows], { rowGroupSize: 1000, metadataOverflow: 'omit-statistics', limits: { maxRetainedMetadataBytes: 1024 * 1024 } })
    expect(new DataView(matched.bytes.buffer).getUint32(matched.bytes.length - 8, true)).toBeLessThan(1024 * 1024)
    expect(await collect(matched.bytes, {})).toEqual(rows)
  })

  it('still refuses mandatory descriptors and closes the producer without a footer', async () => {
    const closed = vi.fn()
    const pulled = vi.fn()
    async function* batches() {
      try {
        for (const row of wideRows) {
          pulled()
          yield [row]
        }
      }
      finally { closed() }
    }
    const chunks: Uint8Array[] = []
    await expect(encodeParquetRowBatches(batches(), { columns, rowGroupSize: 1, limits: { maxRetainedMetadataBytes: 3000 }, metadataOverflow: 'omit-statistics' }, async (chunk) => {
      chunks.push(chunk.slice())
    })).rejects.toThrow('maxRetainedMetadataBytes')
    expect(pulled.mock.calls.length).toBeLessThan(wideRows.length)
    expect(closed).toHaveBeenCalledOnce()
    expect(chunks.at(-1)?.slice(-4)).not.toEqual(new TextEncoder().encode('PAR1'))
  })

  it('never drops explicit file metadata to fit the retained budget', async () => {
    const write = vi.fn()
    await expect(encodeParquetRowBatches([], { columns, metadataOverflow: 'omit-statistics', fileMetadata: { proof: 'x'.repeat(20_000) }, limits: { maxRetainedMetadataBytes: 40_000 } }, write)).rejects.toThrow('maxRetainedMetadataBytes')
    expect(write).not.toHaveBeenCalled()
  })

  it.each([false, true])('captures the initial policy across awaited output callbacks (enabled=%s)', async (enabled) => {
    const options: EncodeParquetBatchesOptions = { columns, ...overflowOptions, metadataOverflow: enabled ? 'omit-statistics' : undefined }
    const write = vi.fn(async () => {
      options.metadataOverflow = enabled ? undefined : 'omit-statistics'
    })
    const pending = encodeParquetRowBatches([wideRows], options, write)
    if (enabled)
      expect(await pending).toMatchObject({ rowCount: wideRows.length })
    else
      await expect(pending).rejects.toThrow('maxRetainedMetadataBytes')
    expect(write).toHaveBeenCalled()
  })

  it('still refuses output-buffer overflow rather than silently omitting required bytes', async () => {
    await expect(encode([wideRows], { ...overflowOptions, limits: { ...overflowOptions.limits, maxOutputBufferBytes: 32 }, metadataOverflow: 'omit-statistics' })).rejects.toThrow('maxOutputBufferBytes')
  })

  it('propagates a late output failure after omission without reporting success', async () => {
    const error = new Error('upload failed after optional omission')
    const write = vi.fn().mockResolvedValueOnce(undefined).mockRejectedValueOnce(error)
    await expect(encodeParquetRowBatches([wideRows], { columns, rowGroupSize: 1, limits: { maxRetainedMetadataBytes: 32 * 1024 }, metadataOverflow: 'omit-statistics' }, write)).rejects.toBe(error)
    expect(write).toHaveBeenCalledTimes(2)
  })

  it('rejects an unknown policy before consuming input', async () => {
    const iterator = vi.fn()
    await expect(encodeParquetRowBatches({ [Symbol.asyncIterator]: iterator } as never, { columns, metadataOverflow: 'truncate' as never }, vi.fn())).rejects.toThrow('metadataOverflow')
    expect(iterator).not.toHaveBeenCalled()
  })
})

import type { EncodeParquetBatchesOptions, ParquetRangeSource } from '../src/adapters/hyparquet'
import type { ColumnDef } from '../src/schema'
import type { Row, TableName } from '../src/storage'
import { readFile } from 'node:fs/promises'
import { parquetMetadata } from 'hyparquet'
import { describe, expect, it, vi } from 'vitest'
import { decodeParquetRowGroups, decodeParquetToRows, encodeParquetRowBatches, encodeRowsToParquetFlex } from '../src/adapters/hyparquet'
import { SCHEMAS } from '../src/schema'

function concatenate(chunks: Uint8Array[]) {
  const result = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0))
  let offset = 0
  for (const chunk of chunks) {
    result.set(chunk, offset)
    offset += chunk.byteLength
  }
  return result
}

async function encode(batches: readonly (readonly Row[])[], opts: EncodeParquetBatchesOptions) {
  const chunks: Uint8Array[] = []
  const result = await encodeParquetRowBatches(batches, opts, async (bytes) => {
    chunks.push(bytes.slice())
  })
  return { ...result, bytes: concatenate(chunks), chunks }
}

function source(bytes: Uint8Array): ParquetRangeSource & { slice: ReturnType<typeof vi.fn> } {
  return { byteLength: bytes.byteLength, slice: vi.fn(async (start: number, end?: number) => bytes.slice(start, end).buffer) }
}

async function collect(file: ParquetRangeSource, options?: Parameters<typeof decodeParquetRowGroups>[1]) {
  const result: Row[] = []
  for await (const group of decodeParquetRowGroups(file, options))
    result.push(...group)
  return result
}

const columns = [
  { name: 'date', type: 'DATE', nullable: false },
  { name: 'query', type: 'VARCHAR', nullable: true },
  { name: 'clicks', type: 'BIGINT', nullable: true },
] as const
const rows: Row[] = [
  { date: '2026-10-01', query: '日本語 é 😀', clicks: 3 },
  { date: new Date('2026-10-02T23:00:00Z'), query: null, clicks: null },
  { date: 20728, query: undefined, clicks: undefined },
  { date: '2026-10-03', query: 'last', clicks: 9n },
]

const schemaCases = Object.keys(SCHEMAS).flatMap(table => (['int', 'string'] as const).map(encoding => ({ table: table as TableName, encoding })))
describe('streaming Parquet compatibility', () => {
  it.each(schemaCases)(
    'preserves schema, bytes and rows for $table / $encoding',
    async ({ table, encoding }) => {
      const declared: ColumnDef[] = [
        { name: 'site_id', type: encoding === 'int' ? 'INTEGER' : 'VARCHAR', nullable: false },
        { name: 'search_type', type: encoding === 'int' ? 'INTEGER' : 'VARCHAR', nullable: false },
        ...SCHEMAS[table].columns,
      ]
      const input = Array.from({ length: 7 }, (_, index) => Object.freeze(Object.fromEntries(declared.map(column => [column.name, column.type === 'DATE' ? '2026-10-01' : column.type === 'VARCHAR' ? `${column.name}日本語-é-😀-${index}` : index + 0.25])))) as Row[]
      const frozen = Object.freeze(input)
      const options = { columns: declared, rowGroupSize: 3, fileMetadata: { z: 'last', publication: 'fixture', a: 'first' } }
      const expected = encodeRowsToParquetFlex(frozen, options)
      const result = await encode([frozen.slice(0, 1), frozen.slice(1, 5), frozen.slice(5)], options)
      expect(result.bytes).toEqual(expected)
      expect(result.rowCount).toBe(7)
      expect(result.chunks.length).toBe(4) // Three groups, then one footer.
      expect(await collect(source(result.bytes))).toEqual(await decodeParquetToRows(expected))
      expect(parquetMetadata(result.bytes.buffer).schema).toEqual(parquetMetadata(expected.buffer).schema)
    },
  )

  it('normalizes DATE/int/null/undefined consistently and accepts projected ranges', async () => {
    const result = await encode([rows.slice(0, 1), rows.slice(1)], { columns, rowGroupSize: 2 })
    const expected = encodeRowsToParquetFlex(rows, { columns, rowGroupSize: 2 })
    expect(result.bytes).toEqual(expected)
    expect(await collect(source(result.bytes), { columns: ['date', 'missing'], rowStart: 1, rowEnd: 3 }))
      .toEqual(await decodeParquetToRows(expected, { columns: ['date', 'missing'], rowStart: 1, rowEnd: 3 }))
  })

  it('emits deterministic bytes across producer batch boundaries and byte-limited groups', async () => {
    const input = Array.from({ length: 30 }, (_, i) => ({ date: '2026-10-01', query: `${i}🦆`.repeat(10), clicks: i }))
    const options = { columns, rowGroupSize: 25, limits: { maxRowGroupBytes: 400 } }
    const first = await encode([input], options)
    const second = await encode(input.map(row => [row]), options)
    expect(second.bytes).toEqual(first.bytes)
    expect(parquetMetadata(first.bytes.buffer).row_groups.length).toBeGreaterThan(2)
    expect(await collect(source(first.bytes))).toHaveLength(30)
  })

  it.each([undefined, { publication: 'empty' }])('emits a valid empty schema-bearing file with metadata %j', async (fileMetadata) => {
    const result = await encode([[], []], { columns, fileMetadata })
    expect(result.bytes).toEqual(encodeRowsToParquetFlex([], { columns, fileMetadata }))
    expect(await collect(source(result.bytes))).toEqual([])
    expect(result.rowCount).toBe(0)
  })
})

describe('streaming Parquet lifetime and admission', () => {
  it('awaits each group before requesting another producer batch', async () => {
    let release!: () => void
    const blocked = new Promise<void>((resolve) => {
      release = resolve
    })
    const pulled = vi.fn()
    const closed = vi.fn()
    async function* batches() {
      try {
        pulled()
        yield rows.slice(0, 2)
        pulled()
        yield rows.slice(2)
      }
      finally { closed() }
    }
    const chunks: Uint8Array[] = []
    const write = vi.fn(async (chunk: Uint8Array) => {
      chunks.push(chunk.slice())
      if (chunks.length === 1)
        await blocked
    })
    const pending = encodeParquetRowBatches(batches(), { columns, rowGroupSize: 2 }, write)
    await vi.waitFor(() => expect(write).toHaveBeenCalledOnce())
    expect(pulled).toHaveBeenCalledOnce()
    release()
    expect(await pending).toEqual({ bytes: concatenate(chunks).byteLength, rowCount: 4 })
    expect(closed).toHaveBeenCalledOnce()
    expect(await collect(source(concatenate(chunks)))).toHaveLength(4)
  })

  it.each(['source', 'output'] as const)('closes the producer and does not finish after a late %s failure', async (kind) => {
    const failure = new Error(`${kind} failed`)
    const closed = vi.fn()
    async function* batches() {
      try {
        yield rows.slice(0, 2)
        if (kind === 'source')
          throw failure
        yield rows.slice(2)
      }
      finally { closed() }
    }
    const chunks: Uint8Array[] = []
    await expect(encodeParquetRowBatches(batches(), { columns, rowGroupSize: 2 }, async (bytes) => {
      if (kind === 'output' && chunks.length === 1)
        throw failure
      chunks.push(bytes.slice())
    })).rejects.toBe(failure)
    expect(closed).toHaveBeenCalledOnce()
    expect(chunks).toHaveLength(1)
    await expect(collect(source(concatenate(chunks)))).rejects.toThrow()
  })

  it('does not report success when the footer output fails', async () => {
    const write = vi.fn().mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('footer failed'))
    await expect(encodeParquetRowBatches([rows], { columns }, write)).rejects.toThrow('footer failed')
    expect(write).toHaveBeenCalledTimes(2)
  })

  it.each([
    { limits: { maxBatchRows: 1 }, message: 'maxBatchRows' },
    { limits: { maxBatchBytes: 10 }, message: 'maxBatchBytes' },
    { limits: { maxRowGroupBytes: 10 }, message: 'single row' },
    { limits: { maxRowGroups: 1 }, rowGroupSize: 1, message: 'maxRowGroups' },
    { limits: { maxOutputBufferBytes: 8 }, message: 'maxOutputBufferBytes' },
  ])('refuses $message rather than returning partial success', async ({ limits, rowGroupSize, message }) => {
    await expect(encode([rows], { columns, limits, rowGroupSize })).rejects.toThrow(message)
  })

  it.each([0, -1, Infinity, 1.5])('rejects invalid limits before reading input: %s', async (rowGroupSize) => {
    const input = { [Symbol.asyncIterator]: vi.fn() }
    await expect(encodeParquetRowBatches(input as never, { columns, rowGroupSize }, vi.fn())).rejects.toThrow('positive safe integer')
    expect(input[Symbol.asyncIterator]).not.toHaveBeenCalled()
  })

  it('refuses oversized footer metadata before output', async () => {
    const write = vi.fn()
    await expect(encodeParquetRowBatches([], { columns, fileMetadata: { note: 'x'.repeat(100) }, limits: { maxOutputBufferBytes: 100 } }, write)).rejects.toThrow('file metadata')
    expect(write).not.toHaveBeenCalled()
  })

  it('bounds retained string statistics before consuming the complete source', async () => {
    const pulled = vi.fn()
    const closed = vi.fn()
    async function* batches() {
      try {
        for (let i = 0; i < 30; i++) {
          pulled()
          yield [{ date: '2026-10-01', query: `${i}-${'x'.repeat(1000)}`, clicks: i }]
        }
      }
      finally { closed() }
    }
    const chunks: Uint8Array[] = []
    await expect(encodeParquetRowBatches(batches(), { columns, rowGroupSize: 1, limits: { maxRetainedMetadataBytes: 12_000 } }, async (chunk) => {
      chunks.push(chunk.slice())
    })).rejects.toThrow('maxRetainedMetadataBytes')
    expect(pulled.mock.calls.length).toBeLessThan(30)
    expect(closed).toHaveBeenCalledOnce()
    await expect(collect(source(concatenate(chunks)))).rejects.toThrow()
  })

  it('propagates invalid values instead of completing an apparently empty file', async () => {
    await expect(encode([[{ date: 'not-a-date', query: 'x', clicks: 1 }]], { columns })).rejects.toThrow('invalid date string')
    await expect(encode([[{ date: '2026-10-01', query: 'x', clicks: Infinity }]], { columns })).rejects.toThrow('non-finite')
  })
})

describe('range reader bounds', () => {
  it('reads metadata and only the requested physical groups without whole-file download', async () => {
    const bytes = encodeRowsToParquetFlex(rows, { columns, rowGroupSize: 2 })
    const file = source(bytes)
    const iterator = decodeParquetRowGroups(file)
    expect((await iterator.next()).value).toHaveLength(2)
    const count = file.slice.mock.calls.length
    expect(count).toBeGreaterThan(2)
    expect(file.slice.mock.calls.every(([start, end]) => end - start < bytes.byteLength)).toBe(true)
    await iterator.return(undefined)
    expect(file.slice.mock.calls).toHaveLength(count)
  })

  it.each([
    { limits: { maxMetadataBytes: 1 }, message: 'maxMetadataBytes' },
    { limits: { maxRowGroupRows: 1 }, message: 'maxRowGroupRows' },
    { limits: { maxRowGroupBytes: 1 }, message: 'maxRowGroupBytes' },
    { limits: { maxRowGroups: 1 }, message: 'descriptor limits' },
    { limits: { maxReadBytes: 4 }, message: 'maxReadBytes' },
  ])('refuses $message before reading fact column ranges', async ({ limits, message }) => {
    const bytes = encodeRowsToParquetFlex(rows, { columns, rowGroupSize: 2 })
    const file = source(bytes)
    await expect(collect(file, { limits })).rejects.toThrow(message)
    expect(file.slice.mock.calls.length).toBeLessThanOrEqual(2)
  })

  it('rejects incomplete ranges and preserves source errors', async () => {
    const bytes = encodeRowsToParquetFlex(rows, { columns })
    await expect(collect({ byteLength: bytes.length, slice: async () => new ArrayBuffer(0) })).rejects.toThrow('incomplete range')
    const error = new Error('ETag changed')
    await expect(collect({ byteLength: bytes.length, slice: async () => {
      throw error
    } })).rejects.toBe(error)
  })

  it('propagates a late pinned-range failure after yielding a complete earlier group', async () => {
    const bytes = encodeRowsToParquetFlex(rows, { columns, rowGroupSize: 2 })
    const file = source(bytes)
    const iterator = decodeParquetRowGroups(file)
    expect((await iterator.next()).value).toHaveLength(2)
    const error = new Error('pinned object changed')
    file.slice.mockRejectedValue(error)
    await expect(iterator.next()).rejects.toBe(error)
    expect((await iterator.next()).done).toBe(true)
  })

  it('preserves ZSTD decoding, projection and filter semantics for existing catalog files', async () => {
    const bytes = new Uint8Array(await readFile(new URL('./fixtures/pages-zstd.parquet', import.meta.url)))
    const options = { columns: ['date', 'url', 'clicks', 'missing'], filter: { url: { $eq: 'https://example.com/b' } } }
    expect(await collect(source(bytes), options)).toEqual(await decodeParquetToRows(bytes, options))
    expect(await collect(source(bytes), options)).toEqual([{ date: '2026-10-02', url: 'https://example.com/b', clicks: 5n }])
  })

  it('does not treat absent or truncated bytes as an empty Parquet object', async () => {
    await expect(collect(source(new Uint8Array()))).rejects.toThrow('file length')
    await expect(collect(source(new Uint8Array(20)))).rejects.toThrow('invalid footer')
  })

  it('accepts the old encoder default 25000-row group', async () => {
    const input = Array.from({ length: 25_000 }, (_, clicks) => ({ date: '2026-10-01', query: 'same', clicks }))
    const bytes = encodeRowsToParquetFlex(input, { columns })
    expect(await collect(source(bytes))).toHaveLength(25_000)
  })
})

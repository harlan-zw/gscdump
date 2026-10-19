import type { ManifestReadLimits } from 'icebird/src/manifest.js'
import type { Resolver, TableMetadata } from 'icebird/src/types.js'
import { deflateRawSync } from 'node:zlib'
import { ByteWriter } from 'hyparquet-writer'
import { avroWrite } from 'icebird/avro'
import { avroMetadata, readZigZag } from 'icebird/src/avro/avro.metadata.js'

export const limits: ManifestReadLimits = {
  maxObjectBytes: 2 * 1024 * 1024,
  maxTotalObjectBytes: 8 * 1024 * 1024,
  maxManifests: 8,
  maxEntries: 128,
  maxInflatedBlockBytes: 2 * 1024 * 1024,
  maxTotalInflatedBytes: 8 * 1024 * 1024,
  maxValueBytes: 1024 * 1024,
  maxDecodedValues: 100_000,
  maxHeaderBytes: 64 * 1024,
  maxSchemaDepth: 32,
}

export const entrySchema: Parameters<typeof avroWrite>[0]['schema'] = {
  type: 'record',
  name: 'entry',
  fields: [
    { name: 'status', type: 'int' },
    { name: 'snapshot_id', type: ['null', 'long'] },
    { name: 'sequence_number', type: ['null', 'long'] },
    { name: 'file_sequence_number', type: ['null', 'long'] },
    { name: 'data_file', type: { type: 'record', name: 'file', fields: [
      { name: 'content', type: 'int' },
      { name: 'file_path', type: 'string' },
      { name: 'file_size_in_bytes', type: 'long' },
      { name: 'record_count', type: 'long' },
      { name: 'partition', type: { type: 'record', name: 'partition', fields: [
        { name: 'site_id', type: 'int' },
        { name: 'date_month', type: 'int' },
      ] } },
    ] } },
  ],
}
export const listSchema: Parameters<typeof avroWrite>[0]['schema'] = {
  type: 'record',
  name: 'manifest',
  fields: [
    { name: 'manifest_path', type: 'string' },
    { name: 'manifest_length', type: 'long' },
    { name: 'partition_spec_id', type: 'int' },
    { name: 'content', type: 'int' },
    { name: 'sequence_number', type: 'long' },
    { name: 'added_snapshot_id', type: 'long' },
  ],
}
export const snapshotId = 9007199254740999n
export function record(index: number): { status: number, snapshot_id: bigint, sequence_number: bigint, file_sequence_number: bigint, data_file: { content: number, file_path: string, file_size_in_bytes: bigint, record_count: bigint, partition: { site_id: number, date_month: number } } } {
  return { status: 1, snapshot_id: snapshotId, sequence_number: 10n, file_sequence_number: 10n, data_file: { content: 0, file_path: `s3://synthetic/data/${index}.parquet`, file_size_in_bytes: 123n, record_count: 45n, partition: { site_id: 7, date_month: 681 } } }
}
export function encode(schema: typeof entrySchema, records: Record<string, unknown>[], blockSize = 512): ArrayBuffer {
  const writer = new ByteWriter()
  avroWrite({ writer, schema, records, blockSize })
  return writer.getBuffer()
}
export function zig(value: number | bigint): Uint8Array {
  let n = BigInt(value)
  n = n >= 0 ? n * 2n : -n * 2n - 1n
  const bytes = []
  do {
    const rest = n >> 7n
    bytes.push(Number(n & 127n) | (rest ? 128 : 0))
    n = rest
  } while (n)
  return Uint8Array.from(bytes)
}
export function container(schema: unknown, blocks: { count: number, bytes: Uint8Array }[], codec = 'null'): ArrayBuffer {
  const text = new TextEncoder()
  const parts: Uint8Array[] = [Uint8Array.of(79, 98, 106, 1), zig(2)]
  for (const [key, value] of [['avro.schema', JSON.stringify(schema)], ['avro.codec', codec]]) {
    for (const item of [key!, value!]) {
      const bytes = text.encode(item)
      parts.push(zig(bytes.length), bytes)
    }
  }
  const sync = new Uint8Array(16).fill(17)
  parts.push(zig(0), sync)
  for (const block of blocks) parts.push(zig(block.count), zig(block.bytes.length), block.bytes, sync)
  return Uint8Array.from(parts.flatMap(value => [...value])).buffer
}
export function compressed(input: ArrayBuffer): ArrayBuffer {
  const reader = { view: new DataView(input), offset: 0 }
  const { metadata } = avroMetadata(reader)
  const blocks = []
  while (reader.offset < input.byteLength) {
    const count = readZigZag(reader)
    const length = readZigZag(reader)
    const bytes = deflateRawSync(new Uint8Array(input, reader.offset, length))
    blocks.push({ count, bytes })
    reader.offset += length + 16
  }
  return container(metadata['avro.schema'], blocks, 'deflate')
}
export function fixture(count = 2, entries = 4, deflate = false): { objects: Map<string, ArrayBuffer>, reads: { path: string, bytes: number }[], resolver: Resolver, metadata: TableMetadata } {
  const objects = new Map<string, ArrayBuffer>()
  const manifestRows = []
  for (let i = 0; i < count; i++) {
    const raw = encode(entrySchema, Array.from({ length: entries }, (_, j) => record(i * entries + j)), 16)
    const bytes = deflate ? compressed(raw) : raw
    objects.set(`memory://manifest-${i}`, bytes)
    manifestRows.push({ manifest_path: `memory://manifest-${i}`, manifest_length: BigInt(bytes.byteLength), partition_spec_id: 0, content: 0, sequence_number: 10n, added_snapshot_id: snapshotId })
  }
  const raw = encode(listSchema, manifestRows, 4)
  objects.set('memory://list', deflate ? compressed(raw) : raw)
  const reads: { path: string, bytes: number }[] = []
  const resolver: Resolver = { reader(path) {
    const bytes = objects.get(path)!
    return { byteLength: bytes.byteLength, slice: async (start, end) => {
      reads.push({ path, bytes: (end ?? bytes.byteLength) - start })
      return bytes.slice(start, end)
    } }
  } }
  const metadata = { 'current-snapshot-id': snapshotId, 'snapshots': [{ 'snapshot-id': snapshotId, 'manifest-list': 'memory://list' }] } as TableMetadata
  return { objects, reads, resolver, metadata }
}

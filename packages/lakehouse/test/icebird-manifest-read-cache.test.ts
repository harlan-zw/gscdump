import type { Resolver, TableMetadata } from 'icebird'
import { ByteWriter } from 'hyparquet-writer'
import { avroWrite } from 'icebird/avro'
import { icebergManifests } from 'icebird/src/manifest.js'
import { expect, it } from 'vitest'

const entrySchema: Parameters<typeof avroWrite>[0]['schema'] = {
  type: 'record',
  name: 'manifest_entry',
  fields: [
    { name: 'status', type: 'int' },
    { name: 'snapshot_id', type: ['null', 'long'] },
    { name: 'sequence_number', type: ['null', 'long'] },
    { name: 'file_sequence_number', type: ['null', 'long'] },
    { name: 'data_file', type: { type: 'record', name: 'data_file', fields: [
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

const listSchema: Parameters<typeof avroWrite>[0]['schema'] = {
  type: 'record',
  name: 'manifest_file',
  fields: [
    { name: 'manifest_path', type: 'string' },
    { name: 'manifest_length', type: 'long' },
    { name: 'partition_spec_id', type: 'int' },
    { name: 'content', type: 'int' },
    { name: 'sequence_number', type: 'long' },
    { name: 'added_snapshot_id', type: 'long' },
  ],
}

function avroBytes(schema: Parameters<typeof avroWrite>[0]['schema'], records: Record<string, unknown>[]): ArrayBuffer {
  const writer = new ByteWriter()
  avroWrite({ writer, schema, records })
  return writer.getBuffer()
}

it('decodes each immutable manifest list and manifest once for a shared read batch', async () => {
  const manifest = avroBytes(entrySchema, [{
    status: 1,
    snapshot_id: 1n,
    sequence_number: 1n,
    file_sequence_number: 1n,
    data_file: {
      content: 0,
      file_path: 's3://bucket/gsc/dates/site-1.parquet',
      file_size_in_bytes: 100n,
      record_count: 1n,
      partition: { site_id: 1, date_month: 676 },
    },
  }])
  const list = avroBytes(listSchema, [{
    manifest_path: 'memory://manifest',
    manifest_length: BigInt(manifest.byteLength),
    partition_spec_id: 0,
    content: 0,
    sequence_number: 1n,
    added_snapshot_id: 1n,
  }])
  const bytes = new Map([['memory://list', list], ['memory://manifest', manifest]])
  const reads = new Map<string, number>()
  const resolver: Resolver = {
    reader(path) {
      const body = bytes.get(path)
      if (!body)
        throw new Error(`missing ${path}`)
      return {
        byteLength: body.byteLength,
        slice: async (start, end) => {
          reads.set(path, (reads.get(path) ?? 0) + 1)
          await new Promise(resolve => setTimeout(resolve, 2))
          return body.slice(start, end)
        },
      }
    },
  }
  const metadata = {
    'current-snapshot-id': 1n,
    'snapshots': [{ 'snapshot-id': 1n, 'manifest-list': 'memory://list' }],
  } as TableMetadata
  const manifestCache = { lists: new Map(), entries: new Map() }

  const [first, second] = await Promise.all([
    icebergManifests({ metadata, resolver, manifestCache }),
    icebergManifests({ metadata, resolver, manifestCache }),
  ])

  expect(first[0]?.entries[0]?.data_file.file_path).toBe('s3://bucket/gsc/dates/site-1.parquet')
  expect(second).toEqual(first)
  expect(Object.fromEntries(reads)).toEqual({ 'memory://list': 1, 'memory://manifest': 1 })

  let failed = false
  const flakyResolver: Resolver = {
    reader(path, length) {
      if (path === 'memory://manifest' && !failed) {
        failed = true
        throw new Error('manifest temporarily unavailable')
      }
      return resolver.reader(path, length)
    },
  }
  const retryCache = { lists: new Map(), entries: new Map() }
  const firstAttempt = icebergManifests({ metadata, resolver: flakyResolver, manifestCache: retryCache })
  await expect(firstAttempt).rejects.toThrow('manifest temporarily unavailable')
  const retried = await icebergManifests({ metadata, resolver: flakyResolver, manifestCache: retryCache })
  expect(retried).toEqual(first)
})

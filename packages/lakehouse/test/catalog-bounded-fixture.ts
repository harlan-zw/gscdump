import type { ManifestReadLimits } from 'icebird/src/manifest.js'
import type { TableMetadata } from 'icebird/src/types.js'
import { compressed, encode, entrySchema, fixture, record, snapshotId } from './bounded-avro-fixtures'

/** Synthetic fanout shape from the recorded 164-manifest / 93-file read, not customer bytes. */
export function multiMonthFixture(deflate = false): ReturnType<typeof fixture> {
  const f = fixture(0)
  const integer = (value: number): Uint8Array => {
    const bytes = new Uint8Array(4)
    new DataView(bytes.buffer).setInt32(0, value, true)
    return bytes
  }
  const summary = (value: number): { contains_null: boolean, lower_bound: Uint8Array, upper_bound: Uint8Array } => ({ contains_null: false, lower_bound: integer(value), upper_bound: integer(value) })
  const rows = []
  for (let i = 0; i < 164; i++) {
    const value = record(i)
    const month = 669 + i % 13 // October 2025 through October 2026.
    value.data_file.partition.date_month = month
    value.status = i < 93 ? 1 : 2
    const raw = encode(entrySchema, [value])
    const bytes = deflate ? compressed(raw) : raw
    const path = `memory://manifest-${i}`
    f.objects.set(path, bytes)
    rows.push({ manifest_path: path, manifest_length: BigInt(bytes.byteLength), partition_spec_id: 0, content: 0, sequence_number: 10n, added_snapshot_id: snapshotId, partitions: [summary(7), summary(month)] })
  }
  const schema: typeof entrySchema = { type: 'record', name: 'manifest', fields: [
    { name: 'manifest_path', type: 'string' },
    { name: 'manifest_length', type: 'long' },
    { name: 'partition_spec_id', type: 'int' },
    { name: 'content', type: 'int' },
    { name: 'sequence_number', type: 'long' },
    { name: 'added_snapshot_id', type: 'long' },
    {
      name: 'partitions',
      type: ['null', { type: 'array', items: { type: 'record', name: 'field_summary', fields: [
        { name: 'contains_null', type: 'boolean' },
        { name: 'lower_bound', type: ['null', 'bytes'] },
        { name: 'upper_bound', type: ['null', 'bytes'] },
      ] } }],
    },
  ] }
  const raw = encode(schema, rows, 32)
  f.objects.set('memory://list', deflate ? compressed(raw) : raw)
  // Keep the catalog's actual date schema so ordinary date-bound logic runs.
  f.metadata = { ...f.metadata, 'current-schema-id': 0, 'schemas': [{ 'schema-id': 0, 'type': 'struct', 'fields': [{ id: 1, name: 'date', type: 'date', required: true }] }] } as TableMetadata
  return f
}

// Fixture policy only. Production values require retained-corpus evidence.
export const multiMonthLimits: ManifestReadLimits = {
  maxObjectBytes: 1024 * 1024,
  maxTotalObjectBytes: 4 * 1024 * 1024,
  maxManifests: 164,
  maxEntries: 164,
  maxInflatedBlockBytes: 1024 * 1024,
  maxTotalInflatedBytes: 4 * 1024 * 1024,
  maxValueBytes: 64 * 1024,
  maxDecodedValues: 1_000_000,
  maxHeaderBytes: 64 * 1024,
  maxSchemaDepth: 32,
}

import type { Manifest, ManifestEntry, Resolver } from 'icebird/src/types.js'
import type { IcebergConnection } from './catalog'
import type { CatalogCache } from './catalog-cache'
import { ByteWriter } from 'hyparquet-writer'
import { restCatalogLoadTable, restCatalogUpdateTable } from 'icebird/src/catalog/rest.js'
import { icebergManifests } from 'icebird/src/manifest.js'
import { uuid4 } from 'icebird/src/utils.js'
import { writeExistingDataManifest } from 'icebird/src/write/manifest.js'
import { buildPartitionSummaries, buildSnapshotUpdate, loadPriorManifests } from 'icebird/src/write/snapshot.js'
import { newSnapshotId } from 'icebird/src/write/stage.js'
import { invalidateSnapshotRef } from './catalog'

const MAX_MANIFEST_BYTES = 4 * 1024 * 1024
const MAX_INPUT_BYTES = 8 * 1024 * 1024
const MAX_ENTRIES = 10_000
// The underlying v2 writer carries only these DATA fields. Refuse non-null
// extensions, including encryption metadata, instead of silently discarding them.
const PRESERVED_DATA_FIELDS = new Set([
  'content',
  'file_path',
  'file_format',
  'partition',
  'record_count',
  'file_size_in_bytes',
  'column_sizes',
  'value_counts',
  'null_value_counts',
  'nan_value_counts',
  'lower_bounds',
  'upper_bounds',
  'split_offsets',
  'sort_order_id',
])

export interface MergeIcebergManifestsOptions {
  /** Lower the four-MiB encoded manifest limit. */
  maxManifestBytes?: number
  /** Lower the eight-MiB aggregate metadata input/output limit. */
  maxInputBytes?: number
  /** Lower the ten-thousand live-entry limit. */
  maxEntries?: number
  /** Invalidate this reader cache after a successful commit. */
  cache?: CatalogCache
  /** Recheck external authority immediately before the catalog CAS. Exceptions propagate. */
  confirmAuthority?: () => Promise<boolean>
}

export type MergeIcebergManifestsResult
  = | { _tag: 'Merged', snapshotId: string, manifestsBefore: number, manifestsAfter: number, files: number }
    | { _tag: 'Unchanged' }
    | { _tag: 'Conflict' }
    | { _tag: 'Err', reason: 'unsupported-format' | 'unsupported-deletes' | 'invalid-inventory' | 'metadata-limit' | 'authority-changed' }

/**
 * Merge current append-only v2 manifests without reading or rewriting DATA files.
 * Historical snapshots and their immutable manifests remain available to append retries.
 * Conflicts leave staged metadata unreferenced. Never delete it after an ambiguous commit response.
 */
export async function mergeIcebergManifests(conn: IcebergConnection, table: string, options: MergeIcebergManifestsOptions = {}): Promise<MergeIcebergManifestsResult> {
  const limit = (value: number | undefined, ceiling: number): number => {
    if (value !== undefined && (!Number.isSafeInteger(value) || value <= 0 || value > ceiling))
      throw new RangeError(`Maintenance limit must be between 1 and ${ceiling}`)
    return value ?? ceiling
  }
  const maxManifestBytes = limit(options.maxManifestBytes, MAX_MANIFEST_BYTES)
  const maxInputBytes = limit(options.maxInputBytes, MAX_INPUT_BYTES)
  const maxEntries = limit(options.maxEntries, MAX_ENTRIES)
  if (!conn.resolver.writer)
    throw new Error('Manifest merging requires a metadata writer')
  const { metadata } = await restCatalogLoadTable(conn.catalog, { namespace: conn.namespace, table })
  if (metadata['format-version'] !== 2)
    return { _tag: 'Err', reason: 'unsupported-format' }
  if (metadata['current-snapshot-id'] == null || metadata['current-snapshot-id'] < 0)
    return { _tag: 'Unchanged' }
  const overflow = new Error('Metadata merge byte limit exceeded')
  let inputBytes = 0
  // Reserve the declared object size before reading. Eight concurrent decoder tasks
  // cannot collectively admit more than the aggregate byte limit.
  const resolver: Resolver = { ...conn.resolver, reader: async (path) => {
    const file = await conn.resolver.reader(path)
    if (!Number.isSafeInteger(file.byteLength) || file.byteLength < 0 || file.byteLength > MAX_MANIFEST_BYTES || inputBytes + file.byteLength > maxInputBytes)
      throw overflow
    inputBytes += file.byteLength
    return { byteLength: file.byteLength, slice: async (start, end) => {
      const bytes = await file.slice(start, end)
      if (bytes.byteLength !== (end ?? file.byteLength) - start)
        throw new Error('Metadata object length changed while reading')
      return bytes
    } }
  } }
  const lists = new Map()
  const prior = await loadPriorManifests(metadata, resolver).catch((error: unknown) => {
    if (error === overflow)
      return null
    throw error
  })
  if (!prior)
    return { _tag: 'Err', reason: 'metadata-limit' }
  if (prior.some(manifest => manifest.content !== 0 || manifest.deleted_files_count > 0))
    return { _tag: 'Err', reason: 'unsupported-deletes' }
  if (prior.length < 2)
    return { _tag: 'Unchanged' }
  const snapshot = metadata.snapshots?.find(s => BigInt(s['snapshot-id']) === BigInt(metadata['current-snapshot-id']!))
  if (snapshot?.['manifest-list'])
    lists.set(snapshot['manifest-list'], Promise.resolve(prior))
  const inventory = await icebergManifests({ metadata, resolver, manifestCache: { lists, entries: new Map() } }).catch((error: unknown) => {
    if (error === overflow)
      return null
    throw error
  })
  if (!inventory)
    return { _tag: 'Err', reason: 'metadata-limit' }
  const groups = new Map<number, ManifestEntry[]>()
  const paths = new Set<string>()
  for (const manifest of inventory) {
    for (const entry of manifest.entries) {
      if (entry.status === 2 || entry.data_file.content !== 0)
        return { _tag: 'Err', reason: 'unsupported-deletes' }
      if (Object.entries(entry.data_file).some(([field, value]) => value != null && !PRESERVED_DATA_FIELDS.has(field)))
        return { _tag: 'Err', reason: 'invalid-inventory' }
      if (entry.snapshot_id == null || entry.sequence_number == null || entry.file_sequence_number == null || entry.partition_spec_id == null
        || paths.has(entry.data_file.file_path) || !metadata['partition-specs'].some(spec => spec['spec-id'] === entry.partition_spec_id)) {
        return { _tag: 'Err', reason: 'invalid-inventory' }
      }
      paths.add(entry.data_file.file_path)
      if (paths.size > maxEntries)
        return { _tag: 'Err', reason: 'metadata-limit' }
      const group = groups.get(entry.partition_spec_id) ?? []
      group.push(entry)
      groups.set(entry.partition_spec_id, group)
    }
  }
  const schema = metadata.schemas.find(schema => schema['schema-id'] === metadata['current-schema-id'])
  if (!schema)
    return { _tag: 'Err', reason: 'invalid-inventory' }
  const planned: { bytes: Uint8Array<ArrayBuffer>, entries: ManifestEntry[], specId: number }[] = []
  let outputBytes = 0
  function boundedWriter(): ByteWriter {
    const writer = new ByteWriter(Math.min(1024, maxManifestBytes))
    const ensure = writer.ensure.bind(writer)
    writer.ensure = (size) => {
      if (writer.offset + size > maxManifestBytes)
        throw overflow
      ensure(size)
    }
    return writer
  }
  async function encode(entries: ManifestEntry[], specId: number): Promise<boolean> {
    const writer = boundedWriter()
    const spec = metadata['partition-specs'].find(spec => spec['spec-id'] === specId)!
    const encoded = await Promise.resolve().then(() => writeExistingDataManifest({ writer, schema: schema!, partitionSpec: spec, entries, formatVersion: 2 })).then(() => true, (error: unknown) => {
      if (error === overflow)
        return false
      throw error
    })
    if (!encoded) {
      if (entries.length < 2)
        return false
      const middle = Math.floor(entries.length / 2)
      return await encode(entries.slice(0, middle), specId) && await encode(entries.slice(middle), specId)
    }
    if (outputBytes + writer.offset > maxInputBytes)
      return false
    outputBytes += writer.offset
    planned.push({ bytes: new Uint8Array(writer.getBuffer()), entries, specId })
    return true
  }
  for (const [specId, entries] of groups) {
    if (!await encode(entries, specId))
      return { _tag: 'Err', reason: 'metadata-limit' }
  }
  if (planned.length >= prior.length || planned.length === 0)
    return { _tag: 'Unchanged' }
  const snapshotId = newSnapshotId(metadata)
  const sequenceNumber = BigInt(metadata['last-sequence-number']) + 1n
  const manifestUuid = uuid4()
  const manifests: Manifest[] = []
  for (const [index, plan] of planned.entries()) {
    const path = `${metadata.location}/metadata/${manifestUuid}-merge-${index}.avro`
    const writer = conn.resolver.writer(path)
    writer.appendBytes(plan.bytes)
    await writer.finish()
    const spec = metadata['partition-specs'].find(spec => spec['spec-id'] === plan.specId)!
    manifests.push({ manifest_path: path, manifest_length: BigInt(plan.bytes.byteLength), partition_spec_id: plan.specId, content: 0, sequence_number: sequenceNumber, min_sequence_number: plan.entries.reduce((min, entry) => entry.sequence_number! < min ? entry.sequence_number! : min, sequenceNumber), added_snapshot_id: snapshotId, added_files_count: 0, existing_files_count: plan.entries.length, deleted_files_count: 0, added_rows_count: 0n, existing_rows_count: plan.entries.reduce((sum, entry) => sum + entry.data_file.record_count, 0n), deleted_rows_count: 0n, partitions: buildPartitionSummaries(plan.entries.map(entry => entry.data_file.partition), schema, spec) })
  }
  const listWriter = boundedWriter()
  const staged = await buildSnapshotUpdate({ tableUrl: metadata.location, metadata, resolver: { ...resolver, writer: () => listWriter }, snapshotId, sequenceNumber, manifestUuid, timestampMs: Date.now(), formatVersion: 2, priorManifests: prior, skipPriorManifestPaths: new Set(prior.map(manifest => manifest.manifest_path)), newManifests: manifests, summary: { operation: 'replace' }, writtenFiles: manifests.map(manifest => manifest.manifest_path) }).catch((error: unknown) => {
    if (error === overflow)
      return null
    throw error
  })
  if (!staged || outputBytes + listWriter.offset > maxInputBytes)
    return { _tag: 'Err', reason: 'metadata-limit' }
  const persistedList = conn.resolver.writer(staged.snapshot['manifest-list']!)
  persistedList.appendBytes(listWriter.getBytes())
  await persistedList.finish()
  if (options.confirmAuthority && !await options.confirmAuthority())
    return { _tag: 'Err', reason: 'authority-changed' }
  const committed = await restCatalogUpdateTable(conn.catalog, { namespace: conn.namespace, table, requirements: staged.requirements, updates: staged.updates }).then(() => true, (error: unknown) => {
    if (typeof error === 'object' && error !== null && 'status' in error && (error.status === 409 || error.status === 412))
      return false
    throw error
  })
  if (!committed)
    return { _tag: 'Conflict' }
  if (options.cache)
    await invalidateSnapshotRef(options.cache, conn.namespace, table, conn.cacheScope)
  return { _tag: 'Merged', snapshotId: String(snapshotId), manifestsBefore: prior.length, manifestsAfter: manifests.length, files: paths.size }
}

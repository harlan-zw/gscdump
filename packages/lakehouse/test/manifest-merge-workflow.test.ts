import type { TableMetadata } from 'icebird'
import type { IcebergConnection } from '../src/catalog'
import { ByteWriter } from 'hyparquet-writer'
import { icebergManifests } from 'icebird'
import { avroMetadata } from 'icebird/src/avro/avro.metadata.js'
import { avroRead } from 'icebird/src/avro/avro.read.js'
import { avroWrite } from 'icebird/src/avro/avro.write.js'
import { stringifyIcebergJson } from 'icebird/src/json.js'
import { applyUpdates, checkRequirements } from 'icebird/src/write/commit.js'
import { writeManifestList } from 'icebird/src/write/manifest-list.js'
import { loadPriorManifests } from 'icebird/src/write/snapshot.js'
import { afterEach, expect, it, vi } from 'vitest'
import { createIcebergAppendFileResolver, icebergAppendRetrying } from '../src/catalog'
import { mergeIcebergManifests } from '../src/maintenance'

afterEach(() => vi.unstubAllGlobals())

async function fixture(count = 5) {
  let metadata: TableMetadata = {
    'format-version': 2,
    'table-uuid': '00000000-0000-4000-8000-000000000001',
    'location': 's3://local/table',
    'last-sequence-number': 0,
    'last-updated-ms': 1,
    'last-column-id': 1,
    'current-schema-id': 0,
    'schemas': [{ 'type': 'struct', 'schema-id': 0, 'fields': [{ id: 1, name: 'site_id', required: true, type: 'int' }, { id: 2, name: 'url', required: true, type: 'string' }] }],
    'default-spec-id': 0,
    'partition-specs': [{ 'spec-id': 0, 'fields': [] }],
    'last-partition-id': 999,
    'default-sort-order-id': 0,
    'sort-orders': [{ 'order-id': 0, 'fields': [] }],
    'properties': { 'write.parquet.compression-codec': 'uncompressed' },
    'snapshots': [],
    'refs': {},
  }
  const objects = new Map<string, ByteWriter>()
  const written: string[] = []
  const read: string[] = []
  let beforeCommit: (() => void) | undefined
  let commits = 0
  let ambiguous = false
  vi.stubGlobal('fetch', async (_input: unknown, init?: RequestInit) => {
    if (init?.method === 'POST') {
      beforeCommit?.()
      beforeCommit = undefined
      const body = JSON.parse(String(init.body))
      try {
        checkRequirements(metadata, body.requirements)
      }
      catch {
        return Response.json({ error: { message: 'Conflict' } }, { status: 409 })
      }
      metadata = applyUpdates(metadata, body.updates)
      commits++
      if (ambiguous) {
        ambiguous = false
        return Response.json({ error: { message: 'Lost response' } }, { status: 503 })
      }
    }
    return new Response(stringifyIcebergJson({ 'metadata-location': `memory://${metadata['current-snapshot-id'] ?? 'empty'}`, metadata }), { headers: { 'content-type': 'application/json' } })
  })
  const conn = {
    catalog: { type: 'rest', url: 'https://catalog.invalid', prefix: '', defaults: {}, overrides: {} },
    namespace: 'gsc',
    resolver: {
      writer: (key: string) => {
        written.push(key)
        const writer = new ByteWriter()
        objects.set(key, writer)
        return writer
      },
      reader: async (key: string) => {
        read.push(key)
        const buffer = objects.get(key)?.getBuffer()
        if (!buffer)
          throw new Error('Missing object')
        return { byteLength: buffer.byteLength, slice: async (start: number, end: number) => buffer.slice(start, end) }
      },
    },
  } as unknown as IcebergConnection
  for (let i = 0; i < count; i++)
    await icebergAppendRetrying({ ...conn, table: 'queries', records: [{ site_id: 17, url: `/${i}` }] }, { appendId: `append-${i}` })
  return {
    conn,
    objects,
    written,
    read,
    metadata: () => metadata,
    commits: () => commits,
    race: (callback: () => void) => {
      beforeCommit = callback
    },
    mutate: (callback: (metadata: TableMetadata) => void) => callback(metadata),
    loseResponse: () => {
      ambiguous = true
    },
  }
}

it('merges only metadata, keeps current files and sequence numbers, and resolves original append retries', async () => {
  const f = await fixture()
  const before = await icebergManifests({ metadata: f.metadata(), resolver: f.conn.resolver })
  const entries = before.flatMap(m => m.entries).map(e => ({ ...e, status: 0 }))
  const oldSnapshots = structuredClone(f.metadata().snapshots)
  const writes = f.written.length
  expect((await mergeIcebergManifests(f.conn, 'queries'))._tag).toBe('Merged')
  const after = await icebergManifests({ metadata: f.metadata(), resolver: f.conn.resolver })
  expect(after).toHaveLength(1)
  expect(after.flatMap(m => m.entries)).toEqual(entries)
  expect(f.metadata().snapshots!.slice(0, -1)).toEqual(oldSnapshots)
  expect(f.written.slice(writes).every(key => key.endsWith('.avro'))).toBe(true)
  const resolver = await createIcebergAppendFileResolver(f.conn, 'queries')
  expect((await resolver('append-0', []))._tag).toBe('Ok')
  const commits = f.commits()
  await icebergAppendRetrying({ ...f.conn, table: 'queries', records: [{ site_id: 17, url: '/0' }] }, { appendId: 'append-0' })
  expect(f.commits()).toBe(commits)
  const writesAfterMerge = f.written.length
  expect(await mergeIcebergManifests(f.conn, 'queries')).toEqual({ _tag: 'Unchanged' })
  expect(f.written).toHaveLength(writesAfterMerge)
  expect(f.commits()).toBe(commits)
})

it.each(['uuid', 'snapshot'] as const)('does not overwrite a concurrent %s change', async (change) => {
  const f = await fixture()
  const snapshots = f.metadata().snapshots!.length
  f.race(() => f.mutate((metadata) => {
    if (change === 'uuid') {
      metadata['table-uuid'] = 'replacement-table'
    }
    else {
      metadata['current-snapshot-id'] = metadata.snapshots![0]!['snapshot-id']
      metadata.refs!.main!['snapshot-id'] = metadata['current-snapshot-id']!
    }
  }))
  expect(await mergeIcebergManifests(f.conn, 'queries')).toEqual({ _tag: 'Conflict' })
  expect(f.metadata().snapshots).toHaveLength(snapshots)
  expect(f.objects.size).toBeGreaterThan(0)
})

it('retains all newly committed metadata after a lost success response', async () => {
  const f = await fixture()
  f.loseResponse()
  await expect(mergeIcebergManifests(f.conn, 'queries')).rejects.toThrow('Lost response')
  expect((await icebergManifests({ metadata: f.metadata(), resolver: f.conn.resolver }))).toHaveLength(1)
  expect(await mergeIcebergManifests(f.conn, 'queries')).toEqual({ _tag: 'Unchanged' })
})

it.each(['format', 'delete', 'duplicate', 'entries', 'input'] as const)('leaves authority unchanged for unsupported or bounded %s input', async (mode) => {
  const f = await fixture()
  const prior = await loadPriorManifests(f.metadata(), f.conn.resolver)
  if (mode === 'format')
    f.mutate((metadata) => { metadata['format-version'] = 3 })
  if (mode === 'duplicate')
    f.objects.set(prior[1]!.manifest_path, f.objects.get(prior[0]!.manifest_path)!)
  if (mode === 'delete') {
    prior[0]!.deleted_files_count = 1
    const snapshot = f.metadata().snapshots!.at(-1)!
    await writeManifestList({ writer: f.conn.resolver.writer!(snapshot['manifest-list']!), snapshotId: BigInt(snapshot['snapshot-id']), sequenceNumber: BigInt(snapshot['sequence-number']!), manifests: prior, formatVersion: 2 })
  }
  const snapshotId = f.metadata()['current-snapshot-id']
  const writes = f.written.length
  const reason = mode === 'format' ? 'unsupported-format' : mode === 'delete' ? 'unsupported-deletes' : mode === 'duplicate' ? 'invalid-inventory' : 'metadata-limit'
  expect(await mergeIcebergManifests(f.conn, 'queries', mode === 'entries' ? { maxEntries: 2 } : mode === 'input' ? { maxInputBytes: 1 } : {})).toEqual({ _tag: 'Err', reason })
  expect(f.metadata()['current-snapshot-id']).toBe(snapshotId)
  expect(f.written).toHaveLength(writes)
})

it('splits oversized merged metadata and never writes more than the configured object limit', async () => {
  const f = await fixture(20)
  const oldFiles = (await icebergManifests({ metadata: f.metadata(), resolver: f.conn.resolver })).flatMap(manifest => manifest.entries.map(entry => entry.data_file.file_path))
  const writes = f.written.length
  const result = await mergeIcebergManifests(f.conn, 'queries', { maxManifestBytes: 4000 })
  expect(result._tag).toBe('Merged')
  const after = await icebergManifests({ metadata: f.metadata(), resolver: f.conn.resolver })
  expect(after.length).toBeGreaterThan(1)
  expect(after.flatMap(manifest => manifest.entries.map(entry => entry.data_file.file_path))).toEqual(oldFiles)
  for (const key of f.written.slice(writes)) expect(f.objects.get(key)!.offset).toBeLessThanOrEqual(4000)
})

it('keeps separate partition specifications when merging a current head', async () => {
  const f = await fixture(2)
  f.mutate((metadata) => {
    metadata['partition-specs'].push({ 'spec-id': 1, 'fields': [] })
    metadata['default-spec-id'] = 1
  })
  for (let i = 2; i < 4; i++) await icebergAppendRetrying({ ...f.conn, table: 'queries', records: [{ site_id: 17, url: `/${i}` }] }, { appendId: `append-${i}` })
  const before = (await icebergManifests({ metadata: f.metadata(), resolver: f.conn.resolver })).flatMap(manifest => manifest.entries).map(entry => ({ ...entry, status: 0 }))
  expect((await mergeIcebergManifests(f.conn, 'queries'))._tag).toBe('Merged')
  const after = await icebergManifests({ metadata: f.metadata(), resolver: f.conn.resolver })
  expect(after).toHaveLength(2)
  expect(after.flatMap(manifest => manifest.entries)).toEqual(before)
})

it('rechecks caller authority immediately before committing staged metadata', async () => {
  const f = await fixture()
  const before = f.commits()
  expect(await mergeIcebergManifests(f.conn, 'queries', { confirmAuthority: async () => false })).toEqual({ _tag: 'Err', reason: 'authority-changed' })
  expect(f.commits()).toBe(before)
  await expect(mergeIcebergManifests(f.conn, 'queries', { confirmAuthority: async () => {
    throw new Error('Authority unavailable')
  } })).rejects.toThrow('Authority unavailable')
  expect(f.commits()).toBe(before)
})

it('counts rebuilt partition summaries in the aggregate staged-output byte limit', async () => {
  const f = await fixture(0)
  f.mutate((metadata) => {
    metadata['partition-specs'][0]!.fields.push({ 'source-id': 2, 'field-id': 1000, 'name': 'url', 'transform': 'identity' })
    metadata['last-sequence-number'] = 2 ** 40
  })
  for (let i = 0; i < 2; i++)
    await icebergAppendRetrying({ ...f.conn, table: 'queries', records: Array.from({ length: 150 }, (_, row) => ({ site_id: 17, url: `/${i}/${row}` })) }, { appendId: `many-${i}` })
  const prior = await loadPriorManifests(f.metadata(), f.conn.resolver)
  for (const manifest of prior)
    manifest.partitions = []
  const snapshot = f.metadata().snapshots!.at(-1)!
  const listPath = snapshot['manifest-list']!
  await writeManifestList({ writer: f.conn.resolver.writer!(listPath), snapshotId: BigInt(snapshot['snapshot-id']), sequenceNumber: BigInt(snapshot['sequence-number']!), manifests: prior, formatVersion: 2 })
  const inputBytes = f.objects.get(listPath)!.offset + prior.reduce((sum, manifest) => sum + f.objects.get(manifest.manifest_path)!.offset, 0)
  const commits = f.commits()
  const result = await mergeIcebergManifests(f.conn, 'queries', { maxInputBytes: inputBytes })
  expect(result).toEqual({ _tag: 'Err', reason: 'metadata-limit' })
  expect(f.commits()).toBe(commits)
  expect(f.metadata()['current-snapshot-id']).toBe(snapshot['snapshot-id'])
})

it.each(['key_metadata', 'future_field'])('refuses live DATA metadata that the writer cannot preserve: %s', async (field) => {
  const f = await fixture()
  const prior = await loadPriorManifests(f.metadata(), f.conn.resolver)
  const path = prior[0]!.manifest_path
  const bytes = f.objects.get(path)!.getBuffer()
  const reader = { view: new DataView(bytes), offset: 0 }
  const decoded = avroMetadata(reader)
  const records = avroRead({ reader, ...decoded })
  const schema = decoded.metadata['avro.schema']
  schema.fields.find((entry: { name: string }) => entry.name === 'data_file').type.fields.push({ 'name': field, 'type': ['null', 'bytes'], 'default': null, 'field-id': 131 })
  records[0]!.data_file[field] = new Uint8Array([1, 2, 3])
  const writer = f.conn.resolver.writer!(path)
  await avroWrite({ writer, schema, records })
  prior[0]!.manifest_length = BigInt(writer.offset)
  const snapshot = f.metadata().snapshots!.at(-1)!
  await writeManifestList({ writer: f.conn.resolver.writer!(snapshot['manifest-list']!), snapshotId: BigInt(snapshot['snapshot-id']), sequenceNumber: BigInt(snapshot['sequence-number']!), manifests: prior, formatVersion: 2 })
  const writes = f.written.length
  expect(await mergeIcebergManifests(f.conn, 'queries')).toEqual({ _tag: 'Err', reason: 'invalid-inventory' })
  expect(f.metadata()['current-snapshot-id']).toBe(snapshot['snapshot-id'])
  expect(f.written).toHaveLength(writes)
})

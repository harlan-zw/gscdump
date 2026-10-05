import type { IcebergConnection } from '../src/catalog'
import { ByteWriter } from 'hyparquet-writer'
import { afterEach, expect, it, vi } from 'vitest'
import { defineIcebergDataset } from '../src/dataset'

const dataset = defineIcebergDataset({
  namespace: 'gsc_v1',
  table: 'pages',
  identity: { kind: 'site-int' },
  columns: [{ name: 'url', type: 'STRING', required: false }],
  partition: [{ sourceColumn: 'site_id', name: 'site_id', transform: 'identity' }],
  naturalKey: ['url'],
})

function fixture() {
  const objects = new Map<string, ByteWriter>()
  const schema = dataset.icebergSchema()
  const metadata: Record<string, any> = {
    'format-version': 2,
    'table-uuid': '00000000-0000-4000-8000-000000000001',
    'location': 'memory://warehouse/gsc_v1/pages',
    'last-sequence-number': 0,
    'last-updated-ms': 1,
    'last-column-id': 2,
    'current-schema-id': 0,
    'schemas': [schema],
    'default-spec-id': 0,
    'partition-specs': [dataset.icebergPartitionSpec()],
    'last-partition-id': 1000,
    'default-sort-order-id': 0,
    'sort-orders': [{ 'order-id': 0, 'fields': [] }],
    'properties': {},
    'snapshots': [],
    'snapshot-log': [],
    'metadata-log': [],
    'refs': {},
  }
  const catalogUrl = 'https://catalog.example/v1/namespaces/gsc_v1/tables/pages'
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    if (String(input) !== catalogUrl)
      return new Response('not found', { status: 404 })
    if (init?.method === 'POST') {
      const body = JSON.parse(String(init.body))
      for (const update of body.updates) {
        if (update.action === 'add-snapshot')
          metadata.snapshots.push(update.snapshot)
        if (update.action === 'set-snapshot-ref') {
          metadata['current-snapshot-id'] = update['snapshot-id']
          metadata.refs[update['ref-name']] = { 'snapshot-id': update['snapshot-id'], 'type': update.type }
        }
      }
    }
    return Response.json({ 'metadata-location': 'memory://metadata.json', metadata })
  }))
  const conn = {
    namespace: 'gsc_v1',
    catalog: { type: 'rest', url: 'https://catalog.example', prefix: '', defaults: {}, overrides: {} },
    resolver: {
      writer: (url: string) => {
        const writer = new ByteWriter()
        objects.set(url, writer)
        return writer
      },
      reader: async (url: string) => {
        const bytes = objects.get(url)?.getBuffer()
        if (!bytes)
          throw new Error('Missing committed object')
        return { byteLength: bytes.byteLength, slice: async (start: number, end: number) => bytes.slice(start, end) }
      },
    },
  } as unknown as IcebergConnection
  return { conn, metadata }
}

afterEach(() => vi.unstubAllGlobals())

it('resolves only files from the captured append and Site partition after later commits', async () => {
  const { conn } = fixture()
  await dataset.appendBatches(conn, () => [[{ site_id: 17, url: '/first' }]], { appendId: 'wave-first' })
  await dataset.appendBatches(conn, () => [[{ site_id: 17, url: '/later' }, { site_id: 18, url: '/foreign' }]], { appendId: 'wave-later' })
  const first = await dataset.resolveAppendFiles(conn, 'wave-first', 17)
  const later = await dataset.resolveAppendFiles(conn, 'wave-later', 17)
  expect(first).toMatchObject({ _tag: 'Ok', files: [{ rowCount: 1 }] })
  expect(later).toMatchObject({ _tag: 'Ok', files: [{ rowCount: 1 }] })
  if (first._tag === 'Ok' && later._tag === 'Ok') {
    expect(first.files).toHaveLength(1)
    expect(later.files).toHaveLength(1)
    expect(first.files[0].objectKey).not.toBe(later.files[0].objectKey)
  }
  expect(await dataset.resolveAppendFiles(conn, 'wave-first', 18)).toEqual({ _tag: 'Err', reason: 'append-unavailable' })
})

it('refuses missing or ambiguous commit membership and propagates catalog failure', async () => {
  const { conn, metadata } = fixture()
  expect(await dataset.resolveAppendFiles(conn, 'unknown', 17)).toEqual({ _tag: 'Err', reason: 'append-unavailable' })
  await dataset.appendBatches(conn, () => [[{ site_id: 17, url: '/first' }]], { appendId: 'wave-first' })
  metadata.snapshots.push({ ...metadata.snapshots[0], 'snapshot-id': 999 })
  expect(await dataset.resolveAppendFiles(conn, 'wave-first', 17)).toEqual({ _tag: 'Err', reason: 'append-unavailable' })
  vi.stubGlobal('fetch', vi.fn(async () => {
    throw new Error('Catalog unavailable')
  }))
  await expect(dataset.resolveAppendFiles(conn, 'wave-first', 17)).rejects.toThrow('Catalog unavailable')
})

it('refuses a retained historical append after current replacement', async () => {
  const { conn, metadata } = fixture()
  await dataset.appendBatches(conn, () => [[{ site_id: 17, url: '/old' }]], { appendId: 'old' })
  const historical = [...metadata.snapshots]
  metadata.snapshots = []
  delete metadata['current-snapshot-id']
  await dataset.appendBatches(conn, () => [[{ site_id: 17, url: '/new' }]], { appendId: 'new' })
  metadata.snapshots.unshift(...historical)
  expect(await dataset.resolveAppendFiles(conn, 'old', 17)).toEqual({ _tag: 'Err', reason: 'append-unavailable' })
})

it('bounds a request resolver and refreshes metadata in the next request', async () => {
  const { conn, metadata } = fixture()
  for (let day = 0; day < 56; day++)
    await dataset.appendBatches(conn, () => [[{ site_id: 17, url: `/day-${day}` }]], { appendId: `day-${day}` })
  const fetcher = vi.mocked(globalThis.fetch)
  fetcher.mockClear()
  let reads = 0
  const reader = conn.resolver.reader
  conn.resolver.reader = async (...args) => {
    reads++
    return reader(...args)
  }
  const resolve = await dataset.createAppendFileResolver(conn)
  for (let day = 0; day < 56; day++)
    expect(await resolve(`day-${day}`, 17)).toMatchObject({ _tag: 'Ok' })
  expect(fetcher).toHaveBeenCalledTimes(1)
  expect(reads).toBeLessThan(200)
  const historical = [...metadata.snapshots]
  metadata.snapshots = []
  delete metadata['current-snapshot-id']
  await dataset.appendBatches(conn, () => [[{ site_id: 17, url: '/replacement' }]], { appendId: 'replacement' })
  metadata.snapshots.unshift(...historical)
  const next = await dataset.createAppendFileResolver(conn)
  expect(await next('day-0', 17)).toEqual({ _tag: 'Err', reason: 'append-unavailable' })
})

it('exposes unknown current files without attributing them to the selected append', async () => {
  const { conn } = fixture()
  await dataset.appendBatches(conn, () => [[{ site_id: 17, url: '/selected' }]], { appendId: 'selected' })
  await dataset.appendBatches(conn, () => [[{ site_id: 17, url: '/unrecorded' }]], { appendId: 'unrecorded' })
  const resolve = await dataset.createAppendFileResolver(conn)
  const selected = await resolve('selected', 17)
  const current = resolve.currentFiles(17)
  expect(selected).toMatchObject({ _tag: 'Ok', files: [{ rowCount: 1 }] })
  expect(current).toMatchObject({ _tag: 'Ok' })
  if (selected._tag === 'Ok' && current._tag === 'Ok') {
    expect(current.files).toHaveLength(2)
    expect(current.files.filter(file => !selected.files.some(known => known.objectKey === file.objectKey))).toHaveLength(1)
  }
})

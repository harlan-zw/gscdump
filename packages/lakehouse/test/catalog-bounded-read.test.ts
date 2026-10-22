import type { IcebergConnection, ResolveIcebergDataFilesOptions } from '../src/catalog'
import { createStorage } from 'unstorage'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { compressed, encode, entrySchema, fixture, limits, record } from './bounded-avro-fixtures'
import { multiMonthFixture, multiMonthLimits } from './catalog-bounded-fixture'

const { restCatalogLoadTable } = vi.hoisted(() => ({ restCatalogLoadTable: vi.fn() }))
vi.mock('icebird/src/catalog/rest.js', () => ({ restCatalogConnect: vi.fn(async ({ url }: { url: string }) => ({ type: 'rest', url, prefix: '', defaults: {}, overrides: {} })), restCatalogCreateNamespace: vi.fn(), restCatalogListTables: vi.fn(), restCatalogLoadTable }))
const { connectIcebergCatalog, resolveIcebergDataFiles } = await import('../src/catalog')
const { defineIcebergDataset } = await import('../src/dataset')

const partitionSpec = [
  { sourceColumn: 'site_id', transform: 'identity' as const, name: 'site_id' },
  { sourceColumn: 'date', transform: 'month' as const, name: 'date_month' },
]
const range = { start: '2026-10-01', end: '2026-10-31' }
function setup(count = 2, deflate = false) {
  const f = fixture(count, 4, deflate)
  restCatalogLoadTable.mockResolvedValue({ metadata: f.metadata })
  const conn: IcebergConnection = { catalog: {} as never, namespace: 'gsc', resolver: f.resolver }
  const options: ResolveIcebergDataFilesOptions = {
    namespace: 'gsc',
    table: 'dates',
    partitionSpec,
    matches: [{ field: 'site_id', value: 7, encoding: 'int32' }],
    range,
  }
  return { ...f, conn, options }
}

describe('bounded file resolution through the actual Avro parser', () => {
  beforeEach(() => {
    restCatalogLoadTable.mockReset()
  })

  it.each([false, true])('preserves ordered files and scope, with one walk (deflate: %s)', async (deflate) => {
    const f = setup(2, deflate)
    const normal = await resolveIcebergDataFiles(f.conn, f.options)
    expect(normal).toHaveLength(8)
    f.reads.length = 0
    expect(await resolveIcebergDataFiles(f.conn, { ...f.options, readLimits: limits })).toEqual(normal)
    expect(f.reads).toHaveLength(3)
    expect(await resolveIcebergDataFiles(f.conn, { ...f.options, matches: [{ field: 'site_id', value: 8, encoding: 'int32' }], readLimits: limits })).toEqual([])
    expect(await resolveIcebergDataFiles(f.conn, { ...f.options, range: { start: '2026-11-01', end: '2026-11-30' }, readLimits: limits })).toEqual([])
  })

  it('does not let old exact-file/month caches bypass stricter limits, but keeps metadata caching', async () => {
    const f = setup()
    const cache = { storage: createStorage() }
    const normal = await resolveIcebergDataFiles(f.conn, { ...f.options, cache })
    f.reads.length = 0
    expect(await resolveIcebergDataFiles(f.conn, { ...f.options, cache })).toEqual(normal)
    expect(f.reads).toHaveLength(0)
    const get = vi.spyOn(cache.storage, 'getItem')
    const put = vi.spyOn(cache.storage, 'setItem')
    await expect(resolveIcebergDataFiles(f.conn, { ...f.options, cache, readLimits: { ...limits, maxObjectBytes: 16 } })).rejects.toThrow('objectBytes')
    expect(f.reads).toHaveLength(0)
    expect(restCatalogLoadTable).toHaveBeenCalledTimes(1)
    expect(get.mock.calls.every(([key]) => !key.startsWith('lh-files') && !key.startsWith('lh-month'))).toBe(true)
    expect(put).not.toHaveBeenCalled()
    expect(await resolveIcebergDataFiles(f.conn, { ...f.options, cache, readLimits: limits })).toEqual(normal)
    expect(f.reads).toHaveLength(3)
    f.reads.length = 0
    expect(await resolveIcebergDataFiles(f.conn, { ...f.options, cache, readLimits: limits })).toEqual(normal)
    expect(f.reads).toHaveLength(3)
  })

  it('enforces aggregate source and manifest counts before further reads', async () => {
    const f = setup(3)
    const sourceLimit = f.objects.get('memory://list')!.byteLength + f.objects.get('memory://manifest-0')!.byteLength
    await expect(resolveIcebergDataFiles(f.conn, { ...f.options, readLimits: { ...limits, maxTotalObjectBytes: sourceLimit } })).rejects.toThrow('objectBytes')
    expect(f.reads.map(r => r.path)).toEqual(['memory://list', 'memory://manifest-0'])
    f.reads.length = 0
    await expect(resolveIcebergDataFiles(f.conn, { ...f.options, readLimits: { ...limits, maxManifests: 2 } })).rejects.toThrow('manifests')
    expect(f.reads.map(r => r.path)).toEqual(['memory://list'])
  })

  it('does not reuse an unbounded concurrent reader\'s decoded manifest cache', async () => {
    const f = setup(1)
    const conn = await connectIcebergCatalog({
      catalogUri: 'https://catalog.invalid',
      warehouse: 'synthetic',
      namespace: 'gsc',
      catalogToken: 'test',
      s3: { endpoint: 'https://s3.invalid', accessKeyId: 'test', secretAccessKey: 'test' },
    })
    conn.resolver = f.resolver
    let release!: () => void
    let entered!: () => void
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    const started = new Promise<void>((resolve) => {
      entered = resolve
    })
    const original = f.resolver.reader
    f.resolver.reader = async (path) => {
      const reader = await original(path)
      if (path !== 'memory://manifest-0')
        return reader
      return { byteLength: reader.byteLength, slice: async (start, end) => {
        entered()
        await held
        return reader.slice(start, end)
      } }
    }
    const pending = resolveIcebergDataFiles(conn, f.options)
    await started
    const limited = resolveIcebergDataFiles(conn, { ...f.options, readLimits: { ...limits, maxObjectBytes: 16 } })
    const result = expect(limited).rejects.toThrow('objectBytes')
    release()
    await result
    expect(await pending).toHaveLength(4)
    expect(restCatalogLoadTable).toHaveBeenCalledTimes(1)
  })

  it('refuses compressed amplification through the public resolver, without changing default decoding', async () => {
    const f = setup(1)
    const row = record(0)
    f.objects.set('memory://manifest-0', compressed(encode(entrySchema, [{ ...row, data_file: { ...row.data_file, file_path: `s3://synthetic/${'x'.repeat(1024 * 1024)}` } }])))
    f.metadata.snapshots = [{ 'snapshot-id': f.metadata['current-snapshot-id'], 'manifests': ['memory://manifest-0'] }] as typeof f.metadata.snapshots
    expect(await resolveIcebergDataFiles(f.conn, f.options)).toHaveLength(1)
    await expect(resolveIcebergDataFiles(f.conn, { ...f.options, readLimits: { ...limits, maxInflatedBlockBytes: 65536 } })).rejects.toThrow('output byte limit')
  })

  it.each([
    { ...limits, maxEntries: NaN },
    { ...limits, maxObjectBytes: 0 },
    { ...limits, maxSchemaDepth: 129 },
    { ...limits, maxDecodedValues: 1.5 },
    { ...limits, ignoredOverride: 1 },
  ])('validates the entire policy before catalog work or empty-table returns', async (readLimits) => {
    const f = setup(0)
    await expect(resolveIcebergDataFiles(f.conn, { ...f.options, readLimits })).rejects.toThrow(/manifest|Manifest/)
    expect(restCatalogLoadTable).not.toHaveBeenCalled()
    expect(f.reads).toHaveLength(0)
  })

  it('captures limits before a held metadata read', async () => {
    const f = setup()
    const policy = { ...limits, maxObjectBytes: 16 }
    let release!: () => void
    restCatalogLoadTable.mockImplementation(async () => {
      await new Promise<void>((resolve) => {
        release = resolve
      })
      return { metadata: f.metadata }
    })
    const pending = resolveIcebergDataFiles(f.conn, { ...f.options, readLimits: policy })
    const result = expect(pending).rejects.toThrow('objectBytes')
    policy.maxObjectBytes = limits.maxObjectBytes
    release()
    await result
    expect(f.reads).toHaveLength(0)
  })

  it('captures the dataset option before its lazy runtime import', async () => {
    const f = setup()
    const dataset = defineIcebergDataset({
      namespace: 'gsc',
      table: 'dates',
      identity: { kind: 'site-int', encoding: 'int' },
      naturalKey: ['date'],
      columns: [{ name: 'date', type: 'DATE', required: true }],
      partition: partitionSpec,
    })
    const policy = { ...limits, maxObjectBytes: 16 }
    const pending = dataset.resolveDataFiles(f.conn, 7, range, undefined, { readLimits: policy })
    const result = expect(pending).rejects.toThrow('objectBytes')
    policy.maxObjectBytes = limits.maxObjectBytes
    await result
    expect(f.reads).toHaveLength(0)
  })

  it.each([false, true])('preserves the 13-month synthetic fanout and exposes warm-cache read cost (deflate: %s)', async (deflate) => {
    const f = multiMonthFixture(deflate)
    restCatalogLoadTable.mockResolvedValue({ metadata: f.metadata })
    const conn: IcebergConnection = { catalog: {} as never, namespace: 'gsc', resolver: f.resolver }
    const cache = { storage: createStorage() }
    const options: ResolveIcebergDataFilesOptions = {
      namespace: 'gsc',
      table: 'dates',
      partitionSpec,
      matches: [{ field: 'site_id', value: 7, encoding: 'int32' }],
      range: { start: '2025-10-01', end: '2026-10-31' },
      cache,
    }
    const normal = await resolveIcebergDataFiles(conn, options)
    expect(normal).toHaveLength(93)
    f.reads.length = 0
    expect(await resolveIcebergDataFiles(conn, options)).toEqual(normal)
    expect(f.reads).toHaveLength(0)
    const adjacentRange = { ...options, range: { start: '2025-10-02', end: '2026-10-30' } }
    expect(await resolveIcebergDataFiles(conn, adjacentRange)).toEqual(normal)
    expect(f.reads.map(r => r.path)).toEqual(['memory://list'])
    f.reads.length = 0
    expect(await resolveIcebergDataFiles(conn, { ...adjacentRange, readLimits: multiMonthLimits })).toEqual(normal)
    expect(f.reads).toHaveLength(165)
    expect(f.reads.reduce((n, r) => n + r.bytes, 0)).toBe([...f.objects.values()].reduce((n, bytes) => n + bytes.byteLength, 0))
  })
})

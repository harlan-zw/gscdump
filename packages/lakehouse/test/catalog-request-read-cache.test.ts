import { createStorage } from 'unstorage'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fakeManifestWalker } from './manifest-mock'

const restCatalogConnect = vi.fn(async ({ url }: { url: string }) => ({ type: 'rest', url, prefix: '', defaults: {}, overrides: {} }))
const restCatalogLoadTable = vi.fn()
const icebergManifests = vi.fn()

vi.mock('icebird/src/catalog/rest.js', () => ({ restCatalogConnect, restCatalogLoadTable, restCatalogCreateNamespace: vi.fn(), restCatalogListTables: vi.fn() }))
vi.mock('icebird/src/manifest.js', () => ({ icebergManifests }))

const { catalogCacheScope, connectIcebergCatalog, resolveIcebergDataFiles } = await import('../src/catalog')

function config(warehouse: string) {
  return {
    catalogUri: `https://catalog.example/${warehouse}`,
    warehouse,
    namespace: 'gsc',
    catalogToken: 'token',
    s3: { endpoint: 'https://r2.example', accessKeyId: 'key', secretAccessKey: 'secret' },
  }
}
const month = (2026 - 1970) * 12 + 4
const partitionSpec = [
  { sourceColumn: 'site_id', transform: 'identity' as const, name: 'site_id' },
  { sourceColumn: 'date', transform: 'month' as const, name: 'date_month' },
]
const range = { start: '2026-05-01', end: '2026-05-31' }
function options(siteId: number) {
  return {
    namespace: 'gsc',
    table: 'dates',
    partitionSpec,
    matches: [{ field: 'site_id', value: siteId, encoding: 'int32' as const }],
    range,
  }
}

function entry(siteId: number, suffix: string) {
  return {
    status: 1,
    data_file: {
      content: 0,
      file_path: `s3://bucket/gsc/dates/${suffix}.parquet`,
      file_size_in_bytes: 100,
      record_count: 1,
      partition: { site_id: siteId, date_month: month },
    },
  }
}

describe('connection read batch', () => {
  beforeEach(() => {
    restCatalogConnect.mockClear()
    restCatalogLoadTable.mockReset()
    icebergManifests.mockReset()
  })

  it('shares one table snapshot and decoded manifest across concurrent sites, then reloads for a later read', async () => {
    let snapshot = 1
    let loads = 0
    let decodes = 0
    restCatalogLoadTable.mockImplementation(async () => {
      loads++
      await new Promise(resolve => setTimeout(resolve, 5))
      return { metadata: { 'current-snapshot-id': snapshot, 'snapshots': [{ 'snapshot-id': snapshot }] } }
    })
    icebergManifests.mockImplementation(async ({ metadata, partitionFilter, manifestCache }: {
      metadata: { 'current-snapshot-id': number }
      partitionFilter: (partitions: undefined, specId: number, manifest: { manifest_path: string }) => boolean
      manifestCache?: { entries: Map<string, Promise<unknown>> }
    }) => {
      const path = `manifest-${metadata['current-snapshot-id']}`
      if (partitionFilter(undefined, 0, { manifest_path: path }) === false)
        return []
      const read = async () => {
        decodes++
        await new Promise(resolve => setTimeout(resolve, 5))
        return { url: path, entries: [entry(1, `${path}-one`), entry(2, `${path}-two`)] }
      }
      const existing = manifestCache?.entries.get(path)
      const pending = existing ?? read()
      if (!existing)
        manifestCache?.entries.set(path, pending)
      return [await pending]
    })

    const conn = await connectIcebergCatalog(config('bucket'))
    const [one, two] = await Promise.all([
      resolveIcebergDataFiles(conn, options(1)),
      resolveIcebergDataFiles(conn, options(2)),
    ])
    expect(one.map(file => file.objectKey)).toEqual(['gsc/dates/manifest-1-one.parquet'])
    expect(two.map(file => file.objectKey)).toEqual(['gsc/dates/manifest-1-two.parquet'])
    expect({ loads, decodes }).toEqual({ loads: 1, decodes: 1 })

    snapshot = 2
    const later = await resolveIcebergDataFiles(conn, options(1))
    expect(later.map(file => file.objectKey)).toEqual(['gsc/dates/manifest-2-one.parquet'])
    expect({ loads, decodes }).toEqual({ loads: 2, decodes: 2 })
  })

  it('does not share reads across catalog connections', async () => {
    restCatalogLoadTable.mockImplementation(async (catalog: { url: string }) => ({ metadata: { 'current-snapshot-id': catalog.url } }))
    icebergManifests.mockImplementation(async ({ metadata }: { metadata: { 'current-snapshot-id': string } }) => [{
      url: 'manifest',
      entries: [entry(1, metadata['current-snapshot-id'])],
    }])
    const a = await connectIcebergCatalog(config('a'))
    const b = await connectIcebergCatalog(config('b'))
    const [fromA, fromB] = await Promise.all([
      resolveIcebergDataFiles(a, options(1)),
      resolveIcebergDataFiles(b, options(1)),
    ])
    expect(fromA[0]?.objectKey).toContain('/a.parquet')
    expect(fromB[0]?.objectKey).toContain('/b.parquet')
    expect(restCatalogLoadTable).toHaveBeenCalledTimes(2)
  })

  it('shares a forced metadata load after a cached pointer lacks metadata', async () => {
    const cache = { storage: createStorage() }
    const cfg = config('bucket')
    const scope = catalogCacheScope(cfg)
    await cache.storage.setItem(`lh-snapref\0${scope}\0gsc\0dates`, { v: 'snap-1', exp: Date.now() + 60_000 })
    restCatalogLoadTable.mockImplementation(async () => {
      await new Promise(resolve => setTimeout(resolve, 5))
      return { metadata: { 'current-snapshot-id': 'snap-2' } }
    })
    icebergManifests.mockImplementation(fakeManifestWalker([{
      path: 'manifest',
      entries: [entry(1, 'snap-2'), entry(2, 'snap-2')],
    }]))

    const conn = await connectIcebergCatalog(cfg)
    const [one, two] = await Promise.all([
      resolveIcebergDataFiles(conn, { ...options(1), cache }),
      resolveIcebergDataFiles(conn, { ...options(2), cache }),
    ])
    expect(one[0]?.objectKey).toContain('/snap-2.parquet')
    expect(two[0]?.objectKey).toContain('/snap-2.parquet')
    expect(restCatalogLoadTable).toHaveBeenCalledTimes(1)
  })

  it('evicts a failed table load so a later read can retry', async () => {
    restCatalogLoadTable
      .mockRejectedValueOnce(new Error('catalog unavailable'))
      .mockResolvedValue({ metadata: { 'current-snapshot-id': 2 } })
    icebergManifests.mockResolvedValue([{ url: 'manifest', entries: [entry(1, 'retry')] }])
    const conn = await connectIcebergCatalog(config('bucket'))

    const first = await Promise.allSettled([
      resolveIcebergDataFiles(conn, options(1)),
      resolveIcebergDataFiles(conn, options(2)),
    ])
    expect(first.map(result => result.status)).toEqual(['rejected', 'rejected'])
    const retried = await resolveIcebergDataFiles(conn, options(1))
    expect(retried[0]?.objectKey).toContain('/retry.parquet')
    expect(restCatalogLoadTable).toHaveBeenCalledTimes(2)
  })

  it('keeps exact day filters separate when a shared manifest has both days', async () => {
    const bound = (date: string) => {
      const bytes = new Uint8Array(4)
      new DataView(bytes.buffer).setInt32(0, Math.floor(Date.parse(`${date}T00:00:00Z`) / 86_400_000), true)
      return [{ key: 3, value: bytes }]
    }
    const early = entry(1, 'early')
    const late = entry(1, 'late')
    Object.assign(early.data_file, { lower_bounds: bound('2026-05-03'), upper_bounds: bound('2026-05-03') })
    Object.assign(late.data_file, { lower_bounds: bound('2026-05-20'), upper_bounds: bound('2026-05-20') })
    restCatalogLoadTable.mockResolvedValue({ metadata: {
      'current-snapshot-id': 1,
      'current-schema-id': 0,
      'schemas': [{ 'schema-id': 0, 'fields': [{ id: 3, name: 'date', type: 'date' }] }],
    } })
    icebergManifests.mockResolvedValue([{ url: 'manifest', entries: [early, late] }])
    const conn = await connectIcebergCatalog(config('bucket'))

    const [firstWeek, lastWeek] = await Promise.all([
      resolveIcebergDataFiles(conn, { ...options(1), range: { start: '2026-05-01', end: '2026-05-07' } }),
      resolveIcebergDataFiles(conn, { ...options(1), range: { start: '2026-05-15', end: '2026-05-25' } }),
    ])
    expect(firstWeek.map(file => file.objectKey)).toEqual(['gsc/dates/early.parquet'])
    expect(lastWeek.map(file => file.objectKey)).toEqual(['gsc/dates/late.parquet'])
  })
})

/**
 * Cross-isolate manifest cache (`manifest-cache-resolver.ts`), exercised
 * through `connectIcebergCatalog`'s public resolver, same style as
 * `catalog-connect-cache.test.ts` and `catalog-writer-size.test.ts`.
 *
 * `cachingResolver` is mocked as an identity pass-through (as
 * `catalog-writer-size.test.ts` does) so `conn.resolver` is exactly our
 * wrapper with no extra in-memory memoization layer — that keeps the base
 * reader call counts below a direct, deterministic signal of cache behavior.
 * Each `connectIcebergCatalog` call still models a fresh isolate: a shared
 * `unstorage` memory store simulates the cross-isolate cache, while the
 * `s3SignedResolver` mock always hands back the same reader spy so its call
 * count reflects real base-resolver fetches regardless of which connection
 * made the read.
 */

import { createStorage } from 'unstorage'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const cachingResolver = vi.fn((resolver: unknown) => resolver)
const restCatalogConnect = vi.fn(async () => ({
  type: 'rest' as const,
  url: 'https://catalog.example/acct/warehouse',
  prefix: 'warehouse-prefix',
  defaults: {},
  overrides: {},
}))
const restCatalogLoadTable = vi.fn()
const s3SignedResolver = vi.fn()
const icebergManifests = vi.fn()

vi.mock('icebird/src/catalog/rest.js', () => ({ restCatalogConnect, restCatalogCreateNamespace: vi.fn(), restCatalogListTables: vi.fn(), restCatalogLoadTable }))
vi.mock('icebird/src/fetch.js', () => ({ cachingResolver }))
vi.mock('icebird/src/s3.js', () => ({ s3SignedResolver }))
vi.mock('icebird/src/manifest.js', () => ({ icebergManifests }))

const { connectIcebergCatalog, resolveIcebergDataFiles } = await import('../src/catalog')

const CONFIG = {
  catalogUri: 'https://catalog.example/acct/warehouse',
  warehouse: 'acct_bucket',
  namespace: 'gsc',
  catalogToken: 'token',
  s3: {
    endpoint: 'https://acct.r2.cloudflarestorage.com',
    accessKeyId: 'access',
    secretAccessKey: 'secret',
  },
}

const MANIFEST_PATH = 's3://acct_bucket/gsc/queries/metadata/1111-1111-m0.avro'
const DATA_FILE_PATH = 's3://acct_bucket/gsc/queries/data/site_id=1/a.parquet'

const MANIFEST_LIST_PATH = 's3://acct_bucket/gsc/queries/metadata/snap-1-1-abcd.avro'
const WALK_MANIFEST_PATHS = [
  's3://acct_bucket/gsc/queries/metadata/2222-2222-m0.avro',
  's3://acct_bucket/gsc/queries/metadata/3333-3333-m0.avro',
]
const RANGE = { start: '2026-05-01', end: '2026-05-31' }
const MAY_2026 = monthVal('2026-05')

function monthVal(ym: string): number {
  const [y, m] = ym.split('-').map(Number)
  return (y - 1970) * 12 + (m - 1)
}

function fakeReader(readerSpy: ReturnType<typeof vi.fn>) {
  return { reader: readerSpy }
}

function asyncBufferOf(bytes: Uint8Array) {
  return {
    byteLength: bytes.byteLength,
    async slice(start = 0, end = bytes.byteLength) {
      return bytes.buffer.slice(bytes.byteOffset + start, bytes.byteOffset + end)
    },
  }
}

function bytesOf(...values: number[]): Uint8Array {
  return new Uint8Array(values)
}

async function readAll(resolver: { reader: (path: string, byteLength?: number) => Promise<{ byteLength: number, slice: (start?: number, end?: number) => Promise<ArrayBuffer> | ArrayBuffer }> }, path: string) {
  const ab = await resolver.reader(path)
  return new Uint8Array(await ab.slice(0, ab.byteLength))
}

describe('connectIcebergCatalog manifest cache', () => {
  beforeEach(() => {
    cachingResolver.mockClear()
    restCatalogConnect.mockClear()
    restCatalogLoadTable.mockReset()
    s3SignedResolver.mockReset()
    icebergManifests.mockReset()
  })

  it('persists a defer-less manifest put before the read resolves, then serves it warm', async () => {
    const bytes = bytesOf(1, 2, 3, 4, 5)
    const readerSpy = vi.fn(async () => asyncBufferOf(bytes))
    s3SignedResolver.mockReturnValue(fakeReader(readerSpy))
    const storage = createStorage()
    // Simulate real write latency, for the manifest key only: the config put
    // inside connect is awaited by design, and the manifest put must be
    // awaited inline too — a defer-less cache (no ctx.waitUntil) has a pending
    // write cut off the moment the Worker response returns.
    let writeSettled = false
    const originalSetItem = storage.setItem.bind(storage)
    storage.setItem = async (key, value, options) => {
      if (!String(key).includes('lh-manifest'))
        return originalSetItem(key, value, options)
      await new Promise(resolve => setTimeout(resolve, 20))
      await originalSetItem(key, value, options)
      writeSettled = true
    }

    const conn1 = await connectIcebergCatalog(CONFIG, { cache: { storage }, clock: () => 1_000 })
    const first = await readAll(conn1.resolver, MANIFEST_PATH)
    expect(first).toEqual(bytes)

    // The write landed synchronously with the read — not fire-and-forget.
    expect(writeSettled).toBe(true)
    const keys = await storage.getKeys()
    expect(keys.some(k => k.includes('lh-manifest'))).toBe(true)

    const conn2 = await connectIcebergCatalog(CONFIG, { cache: { storage }, clock: () => 2_000 })
    const second = await readAll(conn2.resolver, MANIFEST_PATH)

    expect(readerSpy).toHaveBeenCalledTimes(1)
    expect(second).toEqual(bytes)
  })

  it('coalesces concurrent manifest reads into one batched storage lookup', async () => {
    const bytes = bytesOf(1, 2)
    const readerSpy = vi.fn(async () => asyncBufferOf(bytes))
    s3SignedResolver.mockReturnValue(fakeReader(readerSpy))
    const storage = createStorage()
    const batches: string[][] = []
    const originalGetItems = storage.getItems.bind(storage)
    storage.getItems = async (items, options) => {
      batches.push(items.map(item => typeof item === 'string' ? item : item.key))
      return originalGetItems(items, options)
    }

    const conn = await connectIcebergCatalog(CONFIG, { cache: { storage }, clock: () => 1_000 })
    await Promise.all([MANIFEST_PATH, ...WALK_MANIFEST_PATHS].map(path => readAll(conn.resolver, path)))

    expect(readerSpy).toHaveBeenCalledTimes(3)
    expect(batches).toHaveLength(1)
    expect(batches[0]).toHaveLength(3)
  })

  it('never caches a path that is not a metadata/*.avro object', async () => {
    const bytes = bytesOf(9, 9, 9)
    const readerSpy = vi.fn(async () => asyncBufferOf(bytes))
    s3SignedResolver.mockReturnValue(fakeReader(readerSpy))
    const storage = createStorage()

    const conn1 = await connectIcebergCatalog(CONFIG, { cache: { storage }, clock: () => 1_000 })
    await readAll(conn1.resolver, DATA_FILE_PATH)

    const conn2 = await connectIcebergCatalog(CONFIG, { cache: { storage }, clock: () => 2_000 })
    await readAll(conn2.resolver, DATA_FILE_PATH)

    expect(readerSpy).toHaveBeenCalledTimes(2)
    const keys = await storage.getKeys()
    expect(keys.some(k => k.includes('lh-manifest'))).toBe(false)
  })

  it('reads an object over 1 MiB normally and does not cache it', async () => {
    const bytes = new Uint8Array(1024 * 1024 + 1).fill(7)
    const readerSpy = vi.fn(async () => asyncBufferOf(bytes))
    s3SignedResolver.mockReturnValue(fakeReader(readerSpy))
    const storage = createStorage()

    const conn1 = await connectIcebergCatalog(CONFIG, { cache: { storage }, clock: () => 1_000 })
    await readAll(conn1.resolver, MANIFEST_PATH)

    const conn2 = await connectIcebergCatalog(CONFIG, { cache: { storage }, clock: () => 2_000 })
    const second = await readAll(conn2.resolver, MANIFEST_PATH)

    expect(readerSpy).toHaveBeenCalledTimes(2)
    expect(second).toEqual(bytes)
  })

  it('does not cache a base reader rejection, so the next read retries the base', async () => {
    const bytes = bytesOf(4, 2)
    const readerSpy = vi.fn()
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce(asyncBufferOf(bytes))
    s3SignedResolver.mockReturnValue(fakeReader(readerSpy))
    const storage = createStorage()

    const conn = await connectIcebergCatalog(CONFIG, { cache: { storage }, clock: () => 1_000 })
    await expect(readAll(conn.resolver, MANIFEST_PATH)).rejects.toThrow('boom')

    const retried = await readAll(conn.resolver, MANIFEST_PATH)
    expect(readerSpy).toHaveBeenCalledTimes(2)
    expect(retried).toEqual(bytes)
  })

  it('without opts.cache, calls the base reader on every connection', async () => {
    const bytes = bytesOf(1, 1, 1)
    const readerSpy = vi.fn(async () => asyncBufferOf(bytes))
    s3SignedResolver.mockReturnValue(fakeReader(readerSpy))

    const conn1 = await connectIcebergCatalog(CONFIG)
    await readAll(conn1.resolver, MANIFEST_PATH)

    const conn2 = await connectIcebergCatalog(CONFIG)
    await readAll(conn2.resolver, MANIFEST_PATH)

    expect(readerSpy).toHaveBeenCalledTimes(2)
  })

  it('emits manifest cache hit/miss counts for the walk into the profiler span', async () => {
    const readerSpy = vi.fn(async (_path: string) => asyncBufferOf(bytesOf(1, 2, 3)))
    s3SignedResolver.mockReturnValue(fakeReader(readerSpy))
    const storage = createStorage()
    const deferred: Promise<unknown>[] = []
    const cache = {
      storage,
      defer: (write: Promise<unknown>) => { deferred.push(write) },
    }
    const spans: { name: string, meta?: Record<string, string | number | boolean> }[] = []
    const profiler = {
      start: (name: string) => (meta?: Record<string, string | number | boolean>) => { spans.push({ name, meta }) },
    }

    icebergManifests.mockImplementation(async ({ resolver }: { resolver: { reader: (path: string) => Promise<unknown> } }) => {
      await Promise.all([MANIFEST_LIST_PATH, ...WALK_MANIFEST_PATHS].map(path => resolver.reader(path)))
      return [{
        entries: [{
          status: 1,
          data_file: {
            content: 0,
            file_path: 's3://acct_bucket/gsc/queries/data/site_id=1/a.parquet',
            file_size_in_bytes: 100,
            record_count: 1,
            partition: { site_id: 1, date_month: MAY_2026 },
          },
        }],
      }]
    })
    restCatalogLoadTable.mockResolvedValue({ metadata: { 'current-snapshot-id': 'snap-1' } })

    const conn1 = await connectIcebergCatalog(CONFIG, { cache, clock: () => 1_000 })
    await resolveIcebergDataFiles(conn1, {
      namespace: 'gsc',
      table: 'queries',
      partitionSpec: [
        { sourceColumn: 'site_id', transform: 'identity', name: 'site_id' },
        { sourceColumn: 'date', transform: 'month', name: 'date_month' },
      ],
      matches: [{ field: 'site_id', value: 1, encoding: 'int32' }],
      range: RANGE,
      cache,
      profiler,
    })

    const coldWalk = spans.filter(span => span.name === 'iceberg.walk')
    expect(coldWalk).toHaveLength(1)
    expect(coldWalk[0]!.meta).toMatchObject({ manifestCacheHits: 0, manifestCacheMisses: 3 })
    expect(readerSpy).toHaveBeenCalledTimes(3)

    await Promise.all(deferred)
    deferred.length = 0
    spans.length = 0

    const conn2 = await connectIcebergCatalog(CONFIG, { cache, clock: () => 2_000 })
    const out = await resolveIcebergDataFiles(conn2, {
      namespace: 'gsc',
      table: 'queries',
      partitionSpec: [
        { sourceColumn: 'site_id', transform: 'identity', name: 'site_id' },
        { sourceColumn: 'date', transform: 'month', name: 'date_month' },
      ],
      matches: [{ field: 'site_id', value: 1, encoding: 'int32' }],
      range: { start: '2026-06-01', end: '2026-06-30' },
      cache,
      profiler,
    })
    expect(out).toEqual([])

    const warmWalk = spans.filter(span => span.name === 'iceberg.walk')
    expect(warmWalk).toHaveLength(1)
    expect(warmWalk[0]!.meta).toMatchObject({ manifestCacheHits: 3, manifestCacheMisses: 0 })
    expect(readerSpy).toHaveBeenCalledTimes(3)
  })
})

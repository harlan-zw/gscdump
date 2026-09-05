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
const s3SignedResolver = vi.fn()

vi.mock('icebird/src/catalog/rest.js', () => ({ restCatalogConnect, restCatalogCreateNamespace: vi.fn(), restCatalogListTables: vi.fn(), restCatalogLoadTable: vi.fn() }))
vi.mock('icebird/src/fetch.js', () => ({ cachingResolver }))
vi.mock('icebird/src/s3.js', () => ({ s3SignedResolver }))

const { connectIcebergCatalog } = await import('../src/catalog')

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
    s3SignedResolver.mockReset()
  })

  it('serves a manifest object from cache on a second connection with zero base-reader calls', async () => {
    const bytes = bytesOf(1, 2, 3, 4, 5)
    const readerSpy = vi.fn(async () => asyncBufferOf(bytes))
    s3SignedResolver.mockReturnValue(fakeReader(readerSpy))
    const storage = createStorage()

    const conn1 = await connectIcebergCatalog(CONFIG, { cache: { storage }, clock: () => 1_000 })
    const first = await readAll(conn1.resolver, MANIFEST_PATH)
    expect(readerSpy).toHaveBeenCalledTimes(1)
    expect(first).toEqual(bytes)

    const conn2 = await connectIcebergCatalog(CONFIG, { cache: { storage }, clock: () => 2_000 })
    const second = await readAll(conn2.resolver, MANIFEST_PATH)

    expect(readerSpy).toHaveBeenCalledTimes(1)
    expect(second).toEqual(bytes)
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
})

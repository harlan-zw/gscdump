/**
 * Catalog resolver write-size invariant.
 *
 * icebird stamps Iceberg `data_file.file_size_in_bytes` from `writer.offset`
 * after `finish()`. The R2/S3 writer uploads the buffered `getBytes()` body, so
 * lakehouse reconciles buffered writers at the resolver seam before icebird
 * builds manifests. This prevents browser OPFS loads from receiving a manifest
 * size that is shorter than the actual Parquet object.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

const cachingResolver = vi.fn((resolver: unknown) => resolver)
const restCatalogConnect = vi.fn(async () => ({
  type: 'rest' as const,
  url: 'https://catalog.example',
  prefix: 'warehouse',
  defaults: {},
  overrides: {},
}))
const s3SignedResolver = vi.fn()

vi.mock('icebird', () => ({
  cachingResolver,
  icebergAppend: vi.fn(),
  icebergCreateTable: vi.fn(),
  icebergDropTable: vi.fn(),
  icebergManifests: vi.fn(),
  restCatalogConnect,
  restCatalogCreateNamespace: vi.fn(),
  restCatalogListTables: vi.fn(),
  restCatalogLoadTable: vi.fn(),
  s3SignedResolver,
}))

const { connectIcebergCatalog } = await import('../src/catalog')

const CONFIG = {
  catalogUri: 'https://catalog.example/acct/warehouse',
  warehouse: 'acct_bucket',
  namespace: 'gsc',
  catalogToken: 'tok',
  s3: {
    endpoint: 'https://acct.r2.cloudflarestorage.com',
    accessKeyId: 'ak',
    secretAccessKey: 'sk',
  },
}

function bufferedWriter(offset: number, bytes: number, flush = false) {
  return {
    offset,
    finish: vi.fn(async () => {}),
    getBytes: vi.fn(() => new Uint8Array(bytes)),
    ...(flush ? { flush: vi.fn() } : {}),
  }
}

describe('connectIcebergCatalog writer byte lengths', () => {
  beforeEach(() => {
    cachingResolver.mockClear()
    restCatalogConnect.mockClear()
    s3SignedResolver.mockReset()
  })

  it('corrects buffered writer offset to the actual uploaded byte length', async () => {
    const writer = bufferedWriter(171_499, 171_510)
    s3SignedResolver.mockReturnValue({ reader: vi.fn(), writer: vi.fn(() => writer) })

    const conn = await connectIcebergCatalog(CONFIG)
    const w = conn.resolver.writer!('s3://bucket/data/file.parquet')
    await w.finish()

    expect(w.offset).toBe(171_510)
  })

  it('does not reconcile flushing writers whose buffer may be only a tail segment', async () => {
    const writer = bufferedWriter(100, 4, true)
    s3SignedResolver.mockReturnValue({ reader: vi.fn(), writer: vi.fn(() => writer) })

    const conn = await connectIcebergCatalog(CONFIG)
    const w = conn.resolver.writer!('s3://bucket/data/file.parquet')
    await w.finish()

    expect(w.offset).toBe(100)
  })
})

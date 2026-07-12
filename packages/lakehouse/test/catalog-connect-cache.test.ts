/**
 * Cross-instance cache contract for the R2 Data Catalog `/v1/config` probe.
 *
 * Each call below represents a fresh Worker sink/isolate: there is no shared
 * connection promise or module-local map. The only shared state is the
 * injected storage, matching a Cloudflare KV-backed `CatalogCache` in hosts.
 */

import { createStorage } from 'unstorage'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const cachingResolver = vi.fn((resolver: unknown) => resolver)
const restCatalogConnect = vi.fn(async () => ({
  type: 'rest' as const,
  url: 'https://catalog.example/acct/warehouse',
  prefix: 'warehouse-prefix',
  defaults: { region: 'auto' },
  overrides: {},
}))
const s3SignedResolver = vi.fn(() => ({ reader: vi.fn(), writer: vi.fn() }))

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
  catalogToken: 'token',
  s3: {
    endpoint: 'https://acct.r2.cloudflarestorage.com',
    accessKeyId: 'access',
    secretAccessKey: 'secret',
  },
}

describe('connectIcebergCatalog shared config cache', () => {
  beforeEach(() => {
    restCatalogConnect.mockClear()
    cachingResolver.mockClear()
    s3SignedResolver.mockClear()
  })

  it('serves fresh connection instances from one durable config probe', async () => {
    const storage = createStorage()
    const firstIsolateCache = { storage }
    const secondIsolateCache = { storage }

    const first = await connectIcebergCatalog(CONFIG, { cache: firstIsolateCache, clock: () => 1_000 })
    const second = await connectIcebergCatalog(CONFIG, { cache: secondIsolateCache, clock: () => 2_000 })

    expect(restCatalogConnect).toHaveBeenCalledTimes(1)
    expect(first).not.toBe(second)
    expect(second.catalog).toMatchObject({
      url: 'https://catalog.example/acct/warehouse',
      prefix: 'warehouse-prefix',
      requestInit: { headers: { Authorization: 'Bearer token' } },
    })
  })
})

/**
 * Tests for the pluggable cache on `listIcebergDataFiles`. Uses a REAL unstorage
 * memory driver as the injected cache, with `icebird` mocked so we can assert
 * exactly when `restCatalogLoadTable` (the snapshot round-trip) and
 * `icebergManifests` (the walk) are hit vs skipped.
 */

import type { CatalogCache } from '../src/iceberg/catalog-cache'
import { createStorage } from 'unstorage'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { collectSpans } from '../src/profile'

const restCatalogLoadTable = vi.fn()
const icebergManifests = vi.fn()
const restCatalogConnect = vi.fn()
const s3SignedResolver = vi.fn(() => ({ reader: vi.fn() }))

vi.mock('icebird', () => ({
  cachingResolver: (r: unknown) => r,
  icebergAppend: vi.fn(),
  icebergCreateTable: vi.fn(),
  icebergDropTable: vi.fn(),
  icebergManifests,
  restCatalogConnect,
  restCatalogCreateNamespace: vi.fn(),
  restCatalogListTables: vi.fn(),
  restCatalogLoadTable,
  s3SignedResolver,
}))

const { listIcebergDataFiles, connectIcebergCatalog } = await import('../src/iceberg/catalog')

const CONN = { catalog: {} as never, resolver: {} as never, namespace: 'gsc' }
const RANGE = { start: '2026-05-01', end: '2026-05-31' }

function monthVal(ym: string): number {
  const [y, m] = ym.split('-').map(Number)
  return (y - 1970) * 12 + (m - 1)
}

function dataFile(file_path = 's3://gscdump-analytics/gsc/pages/a.parquet') {
  return {
    status: 1,
    data_file: {
      content: 0,
      file_path,
      file_size_in_bytes: 1024,
      record_count: 10,
      partition: { site_id: 's1', search_type: 'web', date_month: monthVal('2026-05') },
    },
  }
}

function withSnapshot(snapshotId: string | null = 'snap-1') {
  restCatalogLoadTable.mockResolvedValue({ metadata: { 'current-snapshot-id': snapshotId } })
  icebergManifests.mockResolvedValue([{ entries: [dataFile()] }])
}

function opts(extra: Partial<Parameters<typeof listIcebergDataFiles>[1]> = {}) {
  return { table: 'pages' as const, siteId: 's1', searchType: 'web', range: RANGE, ...extra }
}

describe('listIcebergDataFiles cache', () => {
  beforeEach(() => {
    restCatalogLoadTable.mockReset()
    icebergManifests.mockReset()
  })
  afterEach(() => vi.restoreAllMocks())

  it('a second identical call skips both the loadTable round-trip and the manifest walk', async () => {
    withSnapshot()
    const cache: CatalogCache = { storage: createStorage() }

    const out1 = await listIcebergDataFiles(CONN, opts({ cache }))
    expect(out1).toHaveLength(1)
    expect(restCatalogLoadTable).toHaveBeenCalledTimes(1)
    expect(icebergManifests).toHaveBeenCalledTimes(1)

    const out2 = await listIcebergDataFiles(CONN, opts({ cache }))
    expect(out2).toEqual(out1)
    // snapshot-ref hit → no reload; resolved-files hit → no walk.
    expect(restCatalogLoadTable).toHaveBeenCalledTimes(1)
    expect(icebergManifests).toHaveBeenCalledTimes(1)
  })

  it('hands the manifest list a partition filter that prunes a non-matching manifest', async () => {
    withSnapshot()
    const cache: CatalogCache = { storage: createStorage() }
    await listIcebergDataFiles(CONN, opts({ cache, siteId: 's1', encoding: 'string' }))

    const arg = icebergManifests.mock.calls[0]![0] as { partitionFilter?: (p: unknown) => boolean }
    expect(typeof arg.partitionFilter).toBe('function')
    // A summary whose site range is entirely above 's1' must be pruned.
    const aboveRange = [
      { contains_null: false, lower_bound: new TextEncoder().encode('s8'), upper_bound: new TextEncoder().encode('s9') },
      { contains_null: false },
      { contains_null: false },
    ]
    expect(arg.partitionFilter!(aboveRange)).toBe(false)
  })

  it('reloads the snapshot after the ref TTL expires, but still serves the file list from cache', async () => {
    withSnapshot()
    let t = 1_000
    const cache: CatalogCache = { storage: createStorage() }

    await listIcebergDataFiles(CONN, opts({ cache, clock: () => t }))
    expect(restCatalogLoadTable).toHaveBeenCalledTimes(1)
    expect(icebergManifests).toHaveBeenCalledTimes(1)

    // Past the 30min snapshot-ref TTL, but well inside the 24h file-list TTL.
    t = 1_000 + 30 * 60_000 + 1_000
    await listIcebergDataFiles(CONN, opts({ cache, clock: () => t }))
    // snapshot-ref expired → one reload; resolved-files still valid → no walk.
    expect(restCatalogLoadTable).toHaveBeenCalledTimes(2)
    expect(icebergManifests).toHaveBeenCalledTimes(1)
  })

  it('a resolved-files MISS with a warm pointer recovers metadata from cache, skipping the loadTable reload', async () => {
    withSnapshot()
    const cache: CatalogCache = { storage: createStorage() }

    // Call 1 warms the snapshot-ref pointer, the snapshotId-keyed metadata, and
    // resolved-files for the May range.
    await listIcebergDataFiles(CONN, opts({ cache }))
    expect(restCatalogLoadTable).toHaveBeenCalledTimes(1)
    expect(icebergManifests).toHaveBeenCalledTimes(1)

    // Call 2 with a DIFFERENT range → resolved-files MISS, but the snapshot
    // pointer is still warm (so `loadSnapshotId` returns metadata=null). The
    // metadata cache (keyed by the immutable snapshotId) supplies it for the
    // walk, so there is NO second loadTable round-trip — only a fresh walk.
    await listIcebergDataFiles(CONN, opts({ cache, range: { start: '2026-04-01', end: '2026-04-30' } }))
    expect(restCatalogLoadTable).toHaveBeenCalledTimes(1) // the fix: reload avoided
    expect(icebergManifests).toHaveBeenCalledTimes(2)
  })

  it('routes cache writes through the defer hook when provided', async () => {
    withSnapshot()
    const deferred: Promise<unknown>[] = []
    const cache: CatalogCache = { storage: createStorage(), defer: p => deferred.push(p) }

    await listIcebergDataFiles(CONN, opts({ cache }))
    // snapshot-ref write + resolved-files write both deferred off the response.
    expect(deferred.length).toBeGreaterThanOrEqual(2)
    await Promise.all(deferred)
  })

  it('caches an empty table without ever walking manifests', async () => {
    withSnapshot(null)
    const cache: CatalogCache = { storage: createStorage() }

    const out1 = await listIcebergDataFiles(CONN, opts({ cache }))
    expect(out1).toEqual([])
    expect(icebergManifests).not.toHaveBeenCalled()

    const out2 = await listIcebergDataFiles(CONN, opts({ cache }))
    expect(out2).toEqual([])
    // snapshot-ref cached `null` → no second loadTable.
    expect(restCatalogLoadTable).toHaveBeenCalledTimes(1)
  })
})

describe('listIcebergDataFiles profiler', () => {
  beforeEach(() => {
    restCatalogLoadTable.mockReset()
    icebergManifests.mockReset()
  })
  afterEach(() => vi.restoreAllMocks())

  const names = (spans: { name: string }[]): string[] => spans.map(s => s.name)
  const meta = (spans: { name: string, meta?: unknown }[], n: string): unknown =>
    spans.find(s => s.name === n)?.meta

  it('emits snapshot + walk (with manifest/file counts) on a cold no-cache read', async () => {
    withSnapshot()
    const { profiler, spans } = collectSpans()

    const out = await listIcebergDataFiles(CONN, opts({ profiler }))
    expect(out).toHaveLength(1)
    // No cache → no `iceberg.cache` span; snapshot loaded fresh, then walked.
    expect(names(spans)).toEqual(['iceberg.snapshot', 'iceberg.walk'])
    expect(meta(spans, 'iceberg.snapshot')).toEqual({ cached: false })
    expect(meta(spans, 'iceberg.walk')).toEqual({ manifests: 1, files: 1 })
  })

  it('on a warm cache hit emits snapshot(cached) + cache(hit) and skips the walk', async () => {
    withSnapshot()
    const cache: CatalogCache = { storage: createStorage() }
    await listIcebergDataFiles(CONN, opts({ cache })) // prime

    const { profiler, spans } = collectSpans()
    await listIcebergDataFiles(CONN, opts({ cache, profiler }))

    expect(names(spans)).toEqual(['iceberg.snapshot', 'iceberg.cache'])
    expect(meta(spans, 'iceberg.snapshot')).toEqual({ cached: true })
    expect(meta(spans, 'iceberg.cache')).toEqual({ hit: true })
  })
})

const CATALOG_CONFIG = {
  catalogUri: 'https://catalog.example/acct/wh',
  warehouse: 'acct_wh',
  namespace: 'gsc',
  catalogToken: 'secret-token',
  s3: { endpoint: 'https://acct.r2.example', accessKeyId: 'ak', secretAccessKey: 'sk' },
}

describe('connectIcebergCatalog cache', () => {
  beforeEach(() => {
    restCatalogConnect.mockReset().mockResolvedValue(Object.freeze({
      type: 'rest',
      url: 'https://catalog.example/acct/wh',
      prefix: 'acct/wh',
      defaults: {},
      overrides: { prefix: 'acct/wh' },
      requestInit: { headers: { Authorization: 'Bearer secret-token' } },
    }))
  })
  afterEach(() => vi.restoreAllMocks())

  it('skips the /v1/config probe on the second connect with a warm cache', async () => {
    const cache: CatalogCache = { storage: createStorage() }
    const a = await connectIcebergCatalog(CATALOG_CONFIG, { cache })
    expect(restCatalogConnect).toHaveBeenCalledTimes(1)

    const b = await connectIcebergCatalog(CATALOG_CONFIG, { cache })
    expect(restCatalogConnect).toHaveBeenCalledTimes(1) // served from cache
    expect(b.catalog.url).toBe(a.catalog.url)
    expect(b.catalog.prefix).toBe('acct/wh')
    // Bearer is rebuilt from config, never read from cache.
    expect(b.catalog.requestInit).toEqual({ headers: { Authorization: 'Bearer secret-token' } })
  })

  it('never writes the bearer token into the cache', async () => {
    const storage = createStorage()
    const cache: CatalogCache = { storage }
    await connectIcebergCatalog(CATALOG_CONFIG, { cache })
    const keys = await storage.getKeys()
    for (const key of keys) {
      const raw = JSON.stringify(await storage.getItem(key))
      expect(raw).not.toContain('secret-token')
      expect(raw).not.toContain('Authorization')
    }
  })

  it('re-probes after the config TTL expires', async () => {
    let t = 1_000
    const cache: CatalogCache = { storage: createStorage() }
    await connectIcebergCatalog(CATALOG_CONFIG, { cache, clock: () => t })
    expect(restCatalogConnect).toHaveBeenCalledTimes(1)

    t = 1_000 + 61 * 60 * 1000 // past the 1h TTL
    await connectIcebergCatalog(CATALOG_CONFIG, { cache, clock: () => t })
    expect(restCatalogConnect).toHaveBeenCalledTimes(2)
  })
})

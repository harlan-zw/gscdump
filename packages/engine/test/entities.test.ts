import type { InspectionRecord } from '../src/entities'
import type { DataSource } from '../src/storage'
import { describe, expect, it } from 'vitest'
import {
  createEmptyTypesStore,
  createInspectionStore,
  createSitemapStore,
  emptyTypesKey,
  hashUrl,
  inspectionHistoryKey,
  inspectionIndexKey,
  inspectionParquetKey,
  sitemapHistoryKey,
  sitemapIndexKey,
} from '../src/entities'
import { decodeParquetToRows } from '../src/adapters/hyparquet'

function makeFakeDataSource(): {
  ds: DataSource
  store: Map<string, Uint8Array>
} {
  const store = new Map<string, Uint8Array>()
  const ds: DataSource = {
    async read(key) {
      const b = store.get(key)
      if (!b)
        throw new Error(`not found: ${key}`)
      return b
    },
    async write(key, bytes) {
      store.set(key, bytes)
    },
    async delete(keys) {
      for (const k of keys) store.delete(k)
    },
    async list(prefix) {
      return Array.from(store.keys()).filter(k => k.startsWith(prefix))
    },
  }
  return { ds, store }
}

function rec(url: string, partial: Partial<InspectionRecord> = {}): InspectionRecord {
  return {
    url,
    inspectedAt: '2026-04-22T10:00:00Z',
    indexStatus: 'PASS',
    ...partial,
  }
}

describe('hashUrl', () => {
  it('produces a stable 16-char hex digest', () => {
    const h = hashUrl('https://example.com/foo')
    expect(h).toMatch(/^[0-9a-f]{16}$/)
    expect(hashUrl('https://example.com/foo')).toBe(h)
  })

  it('different URLs hash to different digests', () => {
    expect(hashUrl('https://example.com/a')).not.toBe(hashUrl('https://example.com/b'))
  })
})

describe('inspectionIndexKey / inspectionHistoryKey', () => {
  it('encodes tenant + site path', () => {
    expect(inspectionIndexKey({ userId: 'u1', siteId: 's1' }))
      .toBe('u_u1/s1/entities/inspections/index.json')
    expect(inspectionHistoryKey({ userId: 'u1', siteId: 's1' }, '2026-04'))
      .toBe('u_u1/s1/entities/inspections/history/2026-04.json')
  })

  it('omits the site segment when no siteId', () => {
    expect(inspectionIndexKey({ userId: 'u1' }))
      .toBe('u_u1/entities/inspections/index.json')
  })
})

describe('createInspectionStore: writeBatch + getLatest', () => {
  it('persists inspection results into the index keyed by URL hash', async () => {
    const { ds, store } = makeFakeDataSource()
    const inspector = createInspectionStore({ dataSource: ds })

    await inspector.writeBatch({ userId: 'u1', siteId: 's1' }, [
      rec('https://example.com/a', { indexStatus: 'PASS' }),
      rec('https://example.com/b', { indexStatus: 'NEUTRAL' }),
    ])

    expect(store.has('u_u1/s1/entities/inspections/index.json')).toBe(true)
    expect(store.has('u_u1/s1/entities/inspections/history/2026-04.json')).toBe(true)

    const a = await inspector.getLatest({ userId: 'u1', siteId: 's1' }, 'https://example.com/a')
    expect(a?.indexStatus).toBe('PASS')

    const b = await inspector.getLatest({ userId: 'u1', siteId: 's1' }, 'https://example.com/b')
    expect(b?.indexStatus).toBe('NEUTRAL')
  })

  it('writeBatch on the same URL updates the index latest record', async () => {
    const { ds } = makeFakeDataSource()
    const inspector = createInspectionStore({ dataSource: ds })
    const ctx = { userId: 'u1', siteId: 's1' }

    await inspector.writeBatch(ctx, [rec('https://x.com/a', { indexStatus: 'PASS', inspectedAt: '2026-04-01T00:00:00Z' })])
    await inspector.writeBatch(ctx, [rec('https://x.com/a', { indexStatus: 'FAIL', inspectedAt: '2026-04-22T00:00:00Z' })])

    const latest = await inspector.getLatest(ctx, 'https://x.com/a')
    expect(latest?.indexStatus).toBe('FAIL')
    expect(latest?.inspectedAt).toBe('2026-04-22T00:00:00Z')

    const index = await inspector.loadIndex(ctx)
    expect(Object.keys(index.records)).toHaveLength(1)
  })

  it('history shards bucket records by inspectedAt YYYY-MM', async () => {
    const { ds } = makeFakeDataSource()
    const inspector = createInspectionStore({ dataSource: ds })
    const ctx = { userId: 'u1', siteId: 's1' }

    await inspector.writeBatch(ctx, [
      rec('https://x.com/a', { inspectedAt: '2026-04-22T00:00:00Z' }),
      rec('https://x.com/b', { inspectedAt: '2026-05-01T00:00:00Z' }),
      rec('https://x.com/c', { inspectedAt: '2026-04-15T00:00:00Z' }),
    ])

    const apr = await inspector.loadHistory(ctx, '2026-04')
    expect(apr?.records).toHaveLength(2)

    const may = await inspector.loadHistory(ctx, '2026-05')
    expect(may?.records).toHaveLength(1)
  })

  it('history shards are append-only across writeBatch calls', async () => {
    const { ds } = makeFakeDataSource()
    const inspector = createInspectionStore({ dataSource: ds })
    const ctx = { userId: 'u1', siteId: 's1' }

    await inspector.writeBatch(ctx, [rec('https://x.com/a', { inspectedAt: '2026-04-01T00:00:00Z' })])
    await inspector.writeBatch(ctx, [rec('https://x.com/a', { inspectedAt: '2026-04-15T00:00:00Z' })])
    await inspector.writeBatch(ctx, [rec('https://x.com/a', { inspectedAt: '2026-04-22T00:00:00Z' })])

    const apr = await inspector.loadHistory(ctx, '2026-04')
    expect(apr?.records).toHaveLength(3)
  })

  it('writeBatch with empty array is a no-op (no I/O)', async () => {
    const { ds, store } = makeFakeDataSource()
    const inspector = createInspectionStore({ dataSource: ds })
    await inspector.writeBatch({ userId: 'u1', siteId: 's1' }, [])
    expect(store.size).toBe(0)
  })

  it('getLatest returns undefined for unknown URL', async () => {
    const { ds } = makeFakeDataSource()
    const inspector = createInspectionStore({ dataSource: ds })
    const result = await inspector.getLatest(
      { userId: 'u1', siteId: 's1' },
      'https://never-inspected.example.com/',
    )
    expect(result).toBeUndefined()
  })

  it('loadIndex returns an empty index when nothing has been written', async () => {
    const { ds } = makeFakeDataSource()
    const inspector = createInspectionStore({ dataSource: ds })
    const index = await inspector.loadIndex({ userId: 'u1', siteId: 's1' })
    expect(index.version).toBe(1)
    expect(index.records).toEqual({})
  })

  it('records with malformed inspectedAt land in the `unknown` shard', async () => {
    const { ds } = makeFakeDataSource()
    const inspector = createInspectionStore({ dataSource: ds })
    const ctx = { userId: 'u1', siteId: 's1' }
    await inspector.writeBatch(ctx, [{ url: 'https://x.com/a', inspectedAt: 'not-a-date' }])
    const shard = await inspector.loadHistory(ctx, 'unknown')
    expect(shard?.records).toHaveLength(1)
  })
})

describe('emptyTypesKey', () => {
  it('encodes tenant + site path', () => {
    expect(emptyTypesKey({ userId: 'u1', siteId: 's1' }))
      .toBe('u_u1/s1/entities/empty-types.json')
  })

  it('omits the site segment when no siteId', () => {
    expect(emptyTypesKey({ userId: 'u1' }))
      .toBe('u_u1/entities/empty-types.json')
  })
})

describe('createEmptyTypesStore', () => {
  it('load returns an empty doc when nothing has been written', async () => {
    const { ds } = makeFakeDataSource()
    const store = createEmptyTypesStore({ dataSource: ds })
    const doc = await store.load({ userId: 'u1', siteId: 's1' })
    expect(doc).toEqual({ version: 1, emptyTypes: [], markedAt: {} })
  })

  it('mark persists types + timestamps, sorted and de-duplicated', async () => {
    const { ds, store: raw } = makeFakeDataSource()
    const store = createEmptyTypesStore({ dataSource: ds, now: () => 1_700_000_000_000 })
    const ctx = { userId: 'u1', siteId: 's1' }

    await store.mark(ctx, ['news', 'discover'])
    await store.mark(ctx, ['news', 'image'])

    const doc = await store.load(ctx)
    expect(doc.emptyTypes).toEqual(['discover', 'image', 'news'])
    expect(doc.markedAt.news).toBe(1_700_000_000_000)
    expect(doc.markedAt.discover).toBe(1_700_000_000_000)
    expect(doc.markedAt.image).toBe(1_700_000_000_000)
    expect(raw.has('u_u1/s1/entities/empty-types.json')).toBe(true)
  })

  it('mark is a no-op when all types are already present', async () => {
    const { ds, store: raw } = makeFakeDataSource()
    const store = createEmptyTypesStore({ dataSource: ds, now: () => 1 })
    const ctx = { userId: 'u1', siteId: 's1' }

    await store.mark(ctx, ['news'])
    const firstBytes = raw.get('u_u1/s1/entities/empty-types.json')!
    await store.mark(ctx, ['news'])
    const secondBytes = raw.get('u_u1/s1/entities/empty-types.json')!
    expect(secondBytes).toBe(firstBytes)
  })

  it('mark with empty array does not write', async () => {
    const { ds, store: raw } = makeFakeDataSource()
    const store = createEmptyTypesStore({ dataSource: ds })
    await store.mark({ userId: 'u1', siteId: 's1' }, [])
    expect(raw.size).toBe(0)
  })

  it('clear removes types and their markedAt stamps', async () => {
    const { ds } = makeFakeDataSource()
    const store = createEmptyTypesStore({ dataSource: ds })
    const ctx = { userId: 'u1', siteId: 's1' }

    await store.mark(ctx, ['news', 'discover', 'image'])
    const after = await store.clear(ctx, ['news', 'image'])
    expect(after.emptyTypes).toEqual(['discover'])
    expect(after.markedAt.news).toBeUndefined()
    expect(after.markedAt.image).toBeUndefined()
    expect(after.markedAt.discover).toBeDefined()
  })

  it('clear is a no-op when nothing matches', async () => {
    const { ds, store: raw } = makeFakeDataSource()
    const store = createEmptyTypesStore({ dataSource: ds })
    const ctx = { userId: 'u1', siteId: 's1' }

    await store.mark(ctx, ['news'])
    const snap = raw.get('u_u1/s1/entities/empty-types.json')!
    await store.clear(ctx, ['discover'])
    expect(raw.get('u_u1/s1/entities/empty-types.json')).toBe(snap)
  })
})

describe('sitemapIndexKey / sitemapHistoryKey', () => {
  it('encodes tenant + site path', () => {
    expect(sitemapIndexKey({ userId: 'u1', siteId: 's1' }))
      .toBe('u_u1/s1/entities/sitemaps/index.json')
    expect(sitemapHistoryKey({ userId: 'u1', siteId: 's1' }, 'abcdef', 1700000000000))
      .toBe('u_u1/s1/entities/sitemaps/history/abcdef__1700000000000.json')
  })
})

describe('createSitemapStore', () => {
  const baseRecord = {
    path: 'https://example.com/sitemap.xml',
    capturedAt: '2026-04-22T10:00:00Z',
    lastDownloaded: '2026-04-20T03:30:00Z',
    type: 'sitemap',
    isPending: false,
    isSitemapsIndex: false,
    errors: '0',
    warnings: '0',
  }

  it('writeSnapshot persists index + one history doc per record', async () => {
    const { ds, store: raw } = makeFakeDataSource()
    const sitemaps = createSitemapStore({ dataSource: ds, now: () => 1_700_000_000_000 })
    const ctx = { userId: 'u1', siteId: 's1' }

    await sitemaps.writeSnapshot(ctx, [
      { ...baseRecord, path: 'https://example.com/sitemap.xml' },
      { ...baseRecord, path: 'https://example.com/news.xml' },
    ])

    expect(raw.has('u_u1/s1/entities/sitemaps/index.json')).toBe(true)
    const histKeys = Array.from(raw.keys()).filter(k => k.includes('/history/'))
    expect(histKeys).toHaveLength(2)
    for (const k of histKeys) expect(k).toContain('__1700000000000.json')
  })

  it('loadIndex returns latest record per feedpath', async () => {
    const { ds } = makeFakeDataSource()
    const sitemaps = createSitemapStore({ dataSource: ds })
    const ctx = { userId: 'u1', siteId: 's1' }
    await sitemaps.writeSnapshot(ctx, [
      { ...baseRecord, path: 'https://example.com/sitemap.xml', lastDownloaded: '2026-04-01T00:00:00Z' },
    ])
    await sitemaps.writeSnapshot(ctx, [
      { ...baseRecord, path: 'https://example.com/sitemap.xml', lastDownloaded: '2026-04-20T00:00:00Z' },
    ])

    const latest = await sitemaps.getLatest(ctx, 'https://example.com/sitemap.xml')
    expect(latest?.lastDownloaded).toBe('2026-04-20T00:00:00Z')

    const index = await sitemaps.loadIndex(ctx)
    expect(Object.keys(index.records)).toHaveLength(1)
  })

  it('history docs are immutable: two snapshots produce two history files for the same feedpath', async () => {
    const { ds, store: raw } = makeFakeDataSource()
    let now = 1_000_000
    const sitemaps = createSitemapStore({ dataSource: ds, now: () => now })
    const ctx = { userId: 'u1', siteId: 's1' }

    await sitemaps.writeSnapshot(ctx, [{ ...baseRecord }])
    now = 2_000_000
    await sitemaps.writeSnapshot(ctx, [{ ...baseRecord }])

    const histKeys = Array.from(raw.keys()).filter(k => k.includes('/history/'))
    expect(histKeys).toHaveLength(2)
    expect(histKeys.some(k => k.endsWith('__1000000.json'))).toBe(true)
    expect(histKeys.some(k => k.endsWith('__2000000.json'))).toBe(true)
  })

  it('writeSnapshot with empty array is a no-op', async () => {
    const { ds, store: raw } = makeFakeDataSource()
    const sitemaps = createSitemapStore({ dataSource: ds })
    await sitemaps.writeSnapshot({ userId: 'u1', siteId: 's1' }, [])
    expect(raw.size).toBe(0)
  })

  it('getLatest returns undefined for unknown feedpath', async () => {
    const { ds } = makeFakeDataSource()
    const sitemaps = createSitemapStore({ dataSource: ds })
    const rec = await sitemaps.getLatest(
      { userId: 'u1', siteId: 's1' },
      'https://never-snapshotted.example.com/sitemap.xml',
    )
    expect(rec).toBeUndefined()
  })
})

describe('inspectionParquetKey', () => {
  it('encodes tenant + site path', () => {
    expect(inspectionParquetKey({ userId: 'u1', siteId: 's1' }))
      .toBe('u_u1/s1/entities/inspections/index.parquet')
    expect(inspectionParquetKey({ userId: 'u1' }))
      .toBe('u_u1/entities/inspections/index.parquet')
  })
})

describe('createInspectionStore: materialize', () => {
  it('writes a parquet sidecar of the current index sorted by urlHash', async () => {
    const { ds, store } = makeFakeDataSource()
    const inspector = createInspectionStore({ dataSource: ds })
    const ctx = { userId: 'u1', siteId: 's1' }
    await inspector.writeBatch(ctx, [
      rec('https://example.com/a', { indexStatus: 'PASS' }),
      rec('https://example.com/b', {
        indexStatus: 'FAIL',
        coverageState: 'Crawled - currently not indexed',
        raw: { schedule: { nextAt: 1234567890, consecutiveUnchanged: 2, policyVersion: 1 } },
      }),
    ])
    const result = await inspector.materialize(ctx)
    expect(result.key).toBe('u_u1/s1/entities/inspections/index.parquet')
    expect(result.rowCount).toBe(2)
    expect(result.bytes).toBeGreaterThan(0)
    const bytes = store.get(result.key)!
    expect(bytes.byteLength).toBe(result.bytes)
    const rows = await decodeParquetToRows(bytes)
    expect(rows).toHaveLength(2)
    // Sorted by urlHash ascending.
    const hashes = rows.map(r => r.urlHash as string)
    expect([...hashes].sort()).toEqual(hashes)
    const byUrl = new Map(rows.map(r => [r.url, r]))
    const a = byUrl.get('https://example.com/a')!
    expect(a.indexStatus).toBe('PASS')
    expect(a.scheduleNextAt).toBeNull()
    const b = byUrl.get('https://example.com/b')!
    expect(b.indexStatus).toBe('FAIL')
    expect(b.coverageState).toBe('Crawled - currently not indexed')
    expect(Number(b.scheduleNextAt)).toBe(1234567890)
    expect(b.scheduleConsecutiveUnchanged).toBe(2)
    expect(b.schedulePolicyVersion).toBe(1)
  })

  it('writes an empty parquet when the index has no records', async () => {
    const { ds, store } = makeFakeDataSource()
    const inspector = createInspectionStore({ dataSource: ds })
    const ctx = { userId: 'u1', siteId: 's1' }
    const result = await inspector.materialize(ctx)
    expect(result.rowCount).toBe(0)
    expect(store.has(result.key)).toBe(true)
    const rows = await decodeParquetToRows(store.get(result.key)!)
    expect(rows).toEqual([])
  })
})

describe('createInspectionStore: parquetUri', () => {
  it('returns the underlying DataSource URI when supported', () => {
    const { ds } = makeFakeDataSource()
    const dsWithUri: DataSource = {
      ...ds,
      uri: (key: string) => `r2://bucket/${key}`,
    }
    const inspector = createInspectionStore({ dataSource: dsWithUri })
    expect(inspector.parquetUri({ userId: 'u1', siteId: 's1' }))
      .toBe('r2://bucket/u_u1/s1/entities/inspections/index.parquet')
  })

  it('returns undefined when the DataSource has no native URI shape', () => {
    const { ds } = makeFakeDataSource()
    const inspector = createInspectionStore({ dataSource: ds })
    expect(inspector.parquetUri({ userId: 'u1', siteId: 's1' })).toBeUndefined()
  })
})

describe('createInspectionStore: hash override', () => {
  it('uses a caller-provided hash when supplied', async () => {
    const { ds, store } = makeFakeDataSource()
    const inspector = createInspectionStore({
      dataSource: ds,
      hash: () => 'fixed-hash',
    })
    await inspector.writeBatch({ userId: 'u1', siteId: 's1' }, [
      rec('https://x.com/a'),
      rec('https://x.com/b'),
    ])
    const indexBytes = store.get('u_u1/s1/entities/inspections/index.json')!
    const index = JSON.parse(new TextDecoder().decode(indexBytes))
    // Both URLs collide onto the fixed hash; second write wins.
    expect(Object.keys(index.records)).toEqual(['fixed-hash'])
    expect(index.records['fixed-hash'].url).toBe('https://x.com/b')
  })
})

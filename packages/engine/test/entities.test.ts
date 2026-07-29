import type {
  ColumnDef,
} from '@gscdump/contracts'
import type {
  InspectionEventRow,
  InspectionParquetRow,
  InspectionRecord,
} from '../src/entities'
import type { DataSource } from '../src/storage'
import { describe, expect, it } from 'vitest'
import { decodeParquetToRows, encodeRowsToParquetFlex } from '../src/adapters/hyparquet'
import {
  createEmptyTypesStore,
  createInspectionStore,
  emptyTypesKey,
  hashUrl,
  INSPECTION_HISTORY_MAX_BYTES,
  inspectionBaseKey,
  inspectionEventKey,
  inspectionEventsPrefix,
  inspectionHistoryPrefix,
  inspectionHistoryShardKey,
  inspectionIndexKey,
  inspectionParquetKey,
  inspectionTransitionsMonthKey,
} from '../src/entities'

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

describe('inspectionIndexKey / inspectionHistoryPrefix / inspectionHistoryShardKey', () => {
  it('encodes tenant + site path', () => {
    expect(inspectionIndexKey({ userId: 'u1', siteId: 's1' }))
      .toBe('u_u1/s1/entities/inspections/index.json')
    expect(inspectionHistoryPrefix({ userId: 'u1', siteId: 's1' }, '2026-04'))
      .toBe('u_u1/s1/entities/inspections/history/2026-04')
    expect(inspectionHistoryShardKey({ userId: 'u1', siteId: 's1' }, '2026-04', 'abc-123'))
      .toBe('u_u1/s1/entities/inspections/history/2026-04/abc-123.json')
  })

  it('omits the site segment when no siteId', () => {
    expect(inspectionIndexKey({ userId: 'u1' }))
      .toBe('u_u1/entities/inspections/index.json')
  })
})

describe('createInspectionStore: appendHistory + loadHistory', () => {
  it('writes a UUID-keyed shard per month, never reads the existing index', async () => {
    const { ds, store } = makeFakeDataSource()
    const reads: string[] = []
    const ds2: DataSource = {
      ...ds,
      async read(k) {
        reads.push(k)
        return ds.read(k)
      },
    }
    const inspector = createInspectionStore({ dataSource: ds2 })

    await inspector.appendHistory({ userId: 'u1', siteId: 's1' }, [
      rec('https://example.com/a', { indexStatus: 'PASS' }),
      rec('https://example.com/b', { indexStatus: 'NEUTRAL' }),
    ], { batchId: 'batch-1' })

    expect(store.has('u_u1/s1/entities/inspections/history/2026-04/batch-1.json')).toBe(true)
    expect(reads).toHaveLength(0) // no read-before-write
  })

  it('groups by month — multiple shards per call when months differ', async () => {
    const { ds, store } = makeFakeDataSource()
    const inspector = createInspectionStore({ dataSource: ds })
    const ctx = { userId: 'u1', siteId: 's1' }

    await inspector.appendHistory(ctx, [
      rec('https://x.com/a', { inspectedAt: '2026-04-22T00:00:00Z' }),
      rec('https://x.com/b', { inspectedAt: '2026-05-01T00:00:00Z' }),
      rec('https://x.com/c', { inspectedAt: '2026-04-15T00:00:00Z' }),
    ], { batchId: 'b1' })

    expect(store.has('u_u1/s1/entities/inspections/history/2026-04/b1.json')).toBe(true)
    expect(store.has('u_u1/s1/entities/inspections/history/2026-05/b1.json')).toBe(true)
  })

  it('retries write distinct shards under different batchIds — idempotency seam', async () => {
    const { ds, store } = makeFakeDataSource()
    const inspector = createInspectionStore({ dataSource: ds })
    const ctx = { userId: 'u1', siteId: 's1' }

    await inspector.appendHistory(ctx, [rec('https://x.com/a')], { batchId: 'b1' })
    await inspector.appendHistory(ctx, [rec('https://x.com/a')], { batchId: 'b2' })

    const aprKeys = Array.from(store.keys()).filter(k => k.includes('/history/2026-04/'))
    expect(aprKeys).toHaveLength(2)
  })

  it('loadHistory concatenates every shard in a month directory', async () => {
    const { ds } = makeFakeDataSource()
    const inspector = createInspectionStore({ dataSource: ds })
    const ctx = { userId: 'u1', siteId: 's1' }

    await inspector.appendHistory(ctx, [rec('https://x.com/a', { inspectedAt: '2026-04-01T00:00:00Z' })], { batchId: 'b1' })
    await inspector.appendHistory(ctx, [rec('https://x.com/b', { inspectedAt: '2026-04-15T00:00:00Z' })], { batchId: 'b2' })
    await inspector.appendHistory(ctx, [rec('https://x.com/c', { inspectedAt: '2026-04-22T00:00:00Z' })], { batchId: 'b3' })

    const apr = await inspector.loadHistory(ctx, '2026-04')
    expect(apr?.records).toHaveLength(3)
  })

  it('loads independent history shards concurrently', async () => {
    const { ds } = makeFakeDataSource()
    const ctx = { userId: 'u1', siteId: 's1' }
    const writer = createInspectionStore({ dataSource: ds })
    for (let i = 0; i < 3; i++)
      await writer.appendHistory(ctx, [rec(`https://x.com/${i}`)], { batchId: `b${i}` })

    let active = 0
    let maxActive = 0
    let release!: () => void
    let reachedThree!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const threeActive = new Promise<void>((resolve) => {
      reachedThree = resolve
    })
    const reader = createInspectionStore({ dataSource: {
      ...ds,
      async read(key) {
        active++
        maxActive = Math.max(maxActive, active)
        if (active === 3)
          reachedThree()
        await gate
        try {
          return await ds.read(key)
        }
        finally {
          active--
        }
      },
    } })

    const pending = reader.loadHistory(ctx, '2026-04')
    await threeActive
    expect(maxActive).toBe(3)
    release()
    await expect(pending).resolves.toMatchObject({ records: expect.any(Array) })
  })

  it('loadHistory returns undefined when the month has no shards', async () => {
    const { ds } = makeFakeDataSource()
    const inspector = createInspectionStore({ dataSource: ds })
    const result = await inspector.loadHistory({ userId: 'u1', siteId: 's1' }, '2099-01')
    expect(result).toBeUndefined()
  })

  it('appendHistory with empty array is a no-op (no I/O)', async () => {
    const { ds, store } = makeFakeDataSource()
    const inspector = createInspectionStore({ dataSource: ds })
    await inspector.appendHistory({ userId: 'u1', siteId: 's1' }, [])
    expect(store.size).toBe(0)
  })

  it('records with malformed inspectedAt land in the `unknown` shard', async () => {
    const { ds } = makeFakeDataSource()
    const inspector = createInspectionStore({ dataSource: ds })
    const ctx = { userId: 'u1', siteId: 's1' }
    await inspector.appendHistory(ctx, [{ url: 'https://x.com/a', inspectedAt: 'not-a-date' }], { batchId: 'b1' })
    const shard = await inspector.loadHistory(ctx, 'unknown')
    expect(shard?.records).toHaveLength(1)
  })

  it('rejects payloads exceeding INSPECTION_HISTORY_MAX_BYTES', async () => {
    const { ds } = makeFakeDataSource()
    const inspector = createInspectionStore({ dataSource: ds })
    // 6 MB of duplicated URL records — well past the 5 MB cap.
    const huge = 'x'.repeat(60_000)
    const bigBatch = Array.from({ length: 100 }, (_, i) => rec(`https://example.com/${huge}-${i}`))
    await expect(
      inspector.appendHistory({ userId: 'u1', siteId: 's1' }, bigBatch, { batchId: 'b1' }),
    ).rejects.toThrow(/exceeds/i)
    expect(INSPECTION_HISTORY_MAX_BYTES).toBe(5 * 1024 * 1024)
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

describe('inspectionParquetKey', () => {
  it('encodes tenant + site path', () => {
    expect(inspectionParquetKey({ userId: 'u1', siteId: 's1' }))
      .toBe('u_u1/s1/entities/inspections/index.parquet')
    expect(inspectionParquetKey({ userId: 'u1' }))
      .toBe('u_u1/entities/inspections/index.parquet')
  })
})

describe('createInspectionStore: materialize', () => {
  function row(partial: Partial<InspectionParquetRow> & Pick<InspectionParquetRow, 'url' | 'inspectedAt'>): InspectionParquetRow {
    return {
      urlHash: hashUrl(partial.url),
      indexStatus: null,
      lastCrawlTime: null,
      googleCanonical: null,
      userCanonical: null,
      coverageState: null,
      robotsTxtState: null,
      indexingState: null,
      pageFetchState: null,
      mobileUsabilityVerdict: null,
      richResultsVerdict: null,
      scheduleNextAt: null,
      scheduleConsecutiveUnchanged: null,
      schedulePolicyVersion: null,
      ...partial,
    }
  }

  it('writes a parquet sidecar of caller-provided rows sorted by urlHash', async () => {
    const { ds, store } = makeFakeDataSource()
    const inspector = createInspectionStore({ dataSource: ds })
    const ctx = { userId: 'u1', siteId: 's1' }
    const result = await inspector.materialize(ctx, [
      row({ url: 'https://example.com/a', inspectedAt: '2026-04-22T10:00:00Z', indexStatus: 'PASS' }),
      row({
        url: 'https://example.com/b',
        inspectedAt: '2026-04-22T10:00:00Z',
        indexStatus: 'FAIL',
        coverageState: 'Crawled - currently not indexed',
        scheduleNextAt: 1234567890,
        scheduleConsecutiveUnchanged: 2,
        schedulePolicyVersion: 1,
      }),
    ])
    expect(result.key).toBe('u_u1/s1/entities/inspections/index.parquet')
    expect(result.rowCount).toBe(2)
    expect(result.bytes).toBeGreaterThan(0)
    const bytes = store.get(result.key)!
    expect(bytes.byteLength).toBe(result.bytes)
    const rows = await decodeParquetToRows(bytes)
    expect(rows).toHaveLength(2)
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

  it('writes an empty parquet when the caller passes no rows', async () => {
    const { ds, store } = makeFakeDataSource()
    const inspector = createInspectionStore({ dataSource: ds })
    const ctx = { userId: 'u1', siteId: 's1' }
    const result = await inspector.materialize(ctx, [])
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
describe('inspectionEventsPrefix / inspectionEventKey / inspectionBaseKey', () => {
  it('encodes tenant + site path', () => {
    expect(inspectionEventsPrefix({ userId: 'u1', siteId: 's1' }))
      .toBe('u_u1/s1/entities/inspections/events')
    expect(inspectionEventKey({ userId: 'u1', siteId: 's1' }, '2026-04', 'b1'))
      .toBe('u_u1/s1/entities/inspections/events/2026-04/b1.parquet')
    expect(inspectionBaseKey({ userId: 'u1', siteId: 's1' }))
      .toBe('u_u1/s1/entities/inspections/base.parquet')
  })

  it('omits the site segment when no siteId', () => {
    expect(inspectionEventsPrefix({ userId: 'u1' }))
      .toBe('u_u1/entities/inspections/events')
    expect(inspectionBaseKey({ userId: 'u1' }))
      .toBe('u_u1/entities/inspections/base.parquet')
  })
})

describe('createInspectionStore: appendInspectionEvents + compactInspections', () => {
  const ctx = { userId: 'u1', siteId: 's1' }

  function event(
    partial: Partial<InspectionEventRow> & Pick<InspectionEventRow, 'url' | 'inspectedAt'>,
  ): InspectionEventRow {
    return {
      urlHash: hashUrl(partial.url),
      indexStatus: null,
      lastCrawlTime: null,
      googleCanonical: null,
      userCanonical: null,
      coverageState: null,
      robotsTxtState: null,
      indexingState: null,
      pageFetchState: null,
      mobileUsabilityVerdict: null,
      richResultsVerdict: null,
      scheduleNextAt: null,
      scheduleConsecutiveUnchanged: null,
      schedulePolicyVersion: null,
      crawlingUserAgent: null,
      richResultsItems: null,
      sitemaps: null,
      referringUrls: null,
      mobileIssues: null,
      inspectionResultLink: null,
      firstCheckedAt: null,
      checkCount: null,
      nextCheckAfter: null,
      nextCheckPriority: null,
      canonicalMismatchKind: 'none',
      ...partial,
    }
  }

  it('writes an immutable per-batch parquet under events/<month>/<batchId>, no read-before-write', async () => {
    const { ds, store } = makeFakeDataSource()
    const reads: string[] = []
    const ds2: DataSource = { ...ds, async read(k) {
      reads.push(k)
      return ds.read(k)
    } }
    const inspector = createInspectionStore({ dataSource: ds2 })

    const res = await inspector.appendInspectionEvents(ctx, [
      event({ url: 'https://e.com/a', inspectedAt: '2026-04-22T10:00:00Z', indexStatus: 'PASS' }),
      event({ url: 'https://e.com/b', inspectedAt: '2026-04-22T11:00:00Z', indexStatus: 'FAIL' }),
    ], { batchId: 'b1' })

    expect(res.rowCount).toBe(2)
    expect(res.keys).toEqual(['u_u1/s1/entities/inspections/events/2026-04/b1.parquet'])
    expect(store.has('u_u1/s1/entities/inspections/events/2026-04/b1.parquet')).toBe(true)
    expect(reads).toHaveLength(0)
  })

  it('groups one call into multiple month files', async () => {
    const { ds, store } = makeFakeDataSource()
    const inspector = createInspectionStore({ dataSource: ds })
    await inspector.appendInspectionEvents(ctx, [
      event({ url: 'https://e.com/a', inspectedAt: '2026-04-30T10:00:00Z' }),
      event({ url: 'https://e.com/b', inspectedAt: '2026-05-01T10:00:00Z' }),
    ], { batchId: 'b1' })
    expect(store.has('u_u1/s1/entities/inspections/events/2026-04/b1.parquet')).toBe(true)
    expect(store.has('u_u1/s1/entities/inspections/events/2026-05/b1.parquet')).toBe(true)
  })

  it('idempotent under retry: same batchId overwrites the same key', async () => {
    const { ds, store } = makeFakeDataSource()
    const inspector = createInspectionStore({ dataSource: ds })
    await inspector.appendInspectionEvents(ctx, [event({ url: 'https://e.com/a', inspectedAt: '2026-04-22T10:00:00Z' })], { batchId: 'b1' })
    await inspector.appendInspectionEvents(ctx, [event({ url: 'https://e.com/a', inspectedAt: '2026-04-22T10:00:00Z' })], { batchId: 'b1' })
    const keys = Array.from(store.keys()).filter(k => k.includes('/events/'))
    expect(keys).toHaveLength(1)
  })

  it('empty input is a no-op', async () => {
    const { ds, store } = makeFakeDataSource()
    const inspector = createInspectionStore({ dataSource: ds })
    const res = await inspector.appendInspectionEvents(ctx, [])
    expect(res).toEqual({ keys: [], rowCount: 0 })
    expect(store.size).toBe(0)
  })

  it('round-trips the full fidelity column set (JSON string columns)', async () => {
    const { ds, store } = makeFakeDataSource()
    const inspector = createInspectionStore({ dataSource: ds })
    await inspector.appendInspectionEvents(ctx, [
      event({
        url: 'https://e.com/a',
        inspectedAt: '2026-04-22T10:00:00Z',
        crawlingUserAgent: 'DESKTOP',
        richResultsItems: JSON.stringify([{ type: 'Article', issues: [] }]),
        sitemaps: JSON.stringify(['https://e.com/sitemap.xml']),
        referringUrls: JSON.stringify(['https://e.com/']),
        mobileIssues: JSON.stringify([]),
        inspectionResultLink: 'https://search.google.com/x',
        firstCheckedAt: '2026-01-01T00:00:00Z',
        checkCount: 5,
        nextCheckAfter: 1771417381,
        nextCheckPriority: 'high',
      }),
    ], { batchId: 'b1' })
    const rows = await decodeParquetToRows(store.get('u_u1/s1/entities/inspections/events/2026-04/b1.parquet')!)
    expect(rows).toHaveLength(1)
    const r = rows[0]
    expect(r.crawlingUserAgent).toBe('DESKTOP')
    expect(JSON.parse(r.richResultsItems as string)).toEqual([{ type: 'Article', issues: [] }])
    expect(JSON.parse(r.sitemaps as string)).toEqual(['https://e.com/sitemap.xml'])
    expect(r.inspectionResultLink).toBe('https://search.google.com/x')
    expect(r.firstCheckedAt).toBe('2026-01-01T00:00:00Z')
    expect(r.checkCount).toBe(5)
    expect(Number(r.nextCheckAfter)).toBe(1771417381)
    expect(r.nextCheckPriority).toBe('high')
  })

  it('compactInspections is a no-op when there are no events', async () => {
    const { ds, store } = makeFakeDataSource()
    const inspector = createInspectionStore({ dataSource: ds })
    const res = await inspector.compactInspections(ctx)
    expect(res).toEqual({ baseRowCount: 0, eventsFolded: 0, eventFilesDeleted: 0, transitionsWritten: 0 })
    expect(store.has(inspectionBaseKey(ctx))).toBe(false)
  })

  it('backfills canonical kinds into a legacy base without waiting for reinspection', async () => {
    const { ds, store } = makeFakeDataSource()
    const inspector = createInspectionStore({ dataSource: ds })
    const baseKey = inspectionBaseKey(ctx)
    const legacyColumns: readonly ColumnDef[] = [
      { name: 'urlHash', type: 'VARCHAR', nullable: false },
      { name: 'url', type: 'VARCHAR', nullable: false },
      { name: 'inspectedAt', type: 'VARCHAR', nullable: false },
      { name: 'userCanonical', type: 'VARCHAR', nullable: true },
      { name: 'googleCanonical', type: 'VARCHAR', nullable: true },
    ]
    store.set(baseKey, encodeRowsToParquetFlex([
      {
        urlHash: hashUrl('https://e.com/formatting'),
        url: 'https://e.com/formatting',
        inspectedAt: '2026-04-01T00:00:00Z',
        userCanonical: 'https://www.e.com/formatting/',
        googleCanonical: 'http://e.com/formatting',
      },
      {
        urlHash: hashUrl('https://e.com/path'),
        url: 'https://e.com/path',
        inspectedAt: '2026-04-01T00:00:00Z',
        userCanonical: 'https://e.com/path',
        googleCanonical: 'https://e.com/other',
      },
    ], { columns: legacyColumns, sortKey: ['urlHash'] }))

    const result = await inspector.backfillCanonicalMismatchKinds(ctx)

    expect(result).toEqual({ baseRowCount: 2, rowsBackfilled: 2, rewritten: true })
    const rows = await decodeParquetToRows(store.get(baseKey)!)
    const kinds = Object.fromEntries(rows.map(row => [row.url, row.canonicalMismatchKind]))
    expect(kinds).toEqual({
      'https://e.com/formatting': 'formatting',
      'https://e.com/path': 'path',
    })
  })

  it('folds events into base (newest-wins by inspectedAt) and deletes consumed events', async () => {
    const { ds, store } = makeFakeDataSource()
    const inspector = createInspectionStore({ dataSource: ds })
    // Two observations of /a (older PASS, newer FAIL) + one of /b.
    await inspector.appendInspectionEvents(ctx, [
      event({ url: 'https://e.com/a', inspectedAt: '2026-04-01T00:00:00Z', indexStatus: 'PASS' }),
    ], { batchId: 'b1' })
    await inspector.appendInspectionEvents(ctx, [
      event({ url: 'https://e.com/a', inspectedAt: '2026-04-20T00:00:00Z', indexStatus: 'FAIL' }),
      event({ url: 'https://e.com/b', inspectedAt: '2026-04-20T00:00:00Z', indexStatus: 'PASS' }),
    ], { batchId: 'b2' })

    const res = await inspector.compactInspections(ctx)
    expect(res.baseRowCount).toBe(2)
    expect(res.eventsFolded).toBe(3)
    expect(res.eventFilesDeleted).toBe(2)
    // Events gone, base present.
    expect(Array.from(store.keys()).filter(k => k.includes('/events/'))).toHaveLength(0)
    expect(store.has(inspectionBaseKey(ctx))).toBe(true)

    const rows = await decodeParquetToRows(store.get(inspectionBaseKey(ctx))!)
    const byUrl = new Map(rows.map(r => [r.url, r]))
    expect(byUrl.get('https://e.com/a')!.indexStatus).toBe('FAIL') // newest wins
    expect(byUrl.get('https://e.com/b')!.indexStatus).toBe('PASS')
    // Sorted by urlHash for prunable row-group stats.
    const hashes = rows.map(r => r.urlHash as string)
    expect([...hashes].sort()).toEqual(hashes)
  })

  it('preserves the earliest firstCheckedAt across the fold', async () => {
    const { ds, store } = makeFakeDataSource()
    const inspector = createInspectionStore({ dataSource: ds })
    await inspector.appendInspectionEvents(ctx, [
      event({ url: 'https://e.com/a', inspectedAt: '2026-04-01T00:00:00Z', firstCheckedAt: '2026-01-15T00:00:00Z' }),
    ], { batchId: 'b1' })
    await inspector.appendInspectionEvents(ctx, [
      // Newest observation, but its firstCheckedAt is LATER — must not overwrite.
      event({ url: 'https://e.com/a', inspectedAt: '2026-04-20T00:00:00Z', firstCheckedAt: '2026-02-01T00:00:00Z' }),
    ], { batchId: 'b2' })

    await inspector.compactInspections(ctx)
    const rows = await decodeParquetToRows(store.get(inspectionBaseKey(ctx))!)
    expect(rows[0].firstCheckedAt).toBe('2026-01-15T00:00:00Z')
  })

  it('merges fresh events into an existing base + is idempotent on re-run', async () => {
    const { ds, store } = makeFakeDataSource()
    const inspector = createInspectionStore({ dataSource: ds })
    await inspector.appendInspectionEvents(ctx, [event({ url: 'https://e.com/a', inspectedAt: '2026-04-01T00:00:00Z', indexStatus: 'PASS' })], { batchId: 'b1' })
    await inspector.compactInspections(ctx)

    // Second round: a newer /a + a new /c land as events, then compact again.
    await inspector.appendInspectionEvents(ctx, [
      event({ url: 'https://e.com/a', inspectedAt: '2026-05-01T00:00:00Z', indexStatus: 'FAIL' }),
      event({ url: 'https://e.com/c', inspectedAt: '2026-05-01T00:00:00Z', indexStatus: 'PASS' }),
    ], { batchId: 'b2' })
    const res = await inspector.compactInspections(ctx)
    expect(res.baseRowCount).toBe(2)

    const rows = await decodeParquetToRows(store.get(inspectionBaseKey(ctx))!)
    const byUrl = new Map(rows.map(r => [r.url, r.indexStatus]))
    expect(byUrl.get('https://e.com/a')).toBe('FAIL')
    expect(byUrl.get('https://e.com/c')).toBe('PASS')

    // Re-running with no new events leaves the base unchanged.
    const before = store.get(inspectionBaseKey(ctx))!
    const res2 = await inspector.compactInspections(ctx)
    expect(res2).toEqual({ baseRowCount: 0, eventsFolded: 0, eventFilesDeleted: 0, transitionsWritten: 0 })
    expect(store.get(inspectionBaseKey(ctx))).toBe(before)
  })

  it('propagates a real read failure on the existing base (never rebuilds from events alone)', async () => {
    const { ds, store } = makeFakeDataSource()
    const inspector = createInspectionStore({ dataSource: ds })
    await inspector.appendInspectionEvents(ctx, [event({ url: 'https://e.com/a', inspectedAt: '2026-04-01T00:00:00Z' })], { batchId: 'b1' })
    await inspector.compactInspections(ctx)
    await inspector.appendInspectionEvents(ctx, [event({ url: 'https://e.com/b', inspectedAt: '2026-05-01T00:00:00Z' })], { batchId: 'b2' })

    const baseKey = inspectionBaseKey(ctx)
    const failing = createInspectionStore({ dataSource: { ...ds, async read(k) {
      if (k === baseKey)
        throw new Error('R2 GET 503: transient backend failure')
      return ds.read(k)
    } } })
    await expect(failing.compactInspections(ctx)).rejects.toThrow(/503/)
    // Base left intact; events not deleted.
    expect(store.has(baseKey)).toBe(true)
    expect(Array.from(store.keys()).some(k => k.includes('/events/2026-05/'))).toBe(true)
  })
})

describe('createInspectionStore: transition capture', () => {
  const ctx = { userId: 'u1', siteId: 's1' }

  function ev(url: string, inspectedAt: string, extra: Partial<InspectionEventRow> = {}): InspectionEventRow {
    return {
      urlHash: hashUrl(url),
      url,
      inspectedAt,
      indexStatus: null,
      lastCrawlTime: null,
      googleCanonical: null,
      userCanonical: null,
      coverageState: null,
      robotsTxtState: null,
      indexingState: null,
      pageFetchState: null,
      mobileUsabilityVerdict: null,
      richResultsVerdict: null,
      scheduleNextAt: null,
      scheduleConsecutiveUnchanged: null,
      schedulePolicyVersion: null,
      crawlingUserAgent: null,
      richResultsItems: null,
      sitemaps: null,
      referringUrls: null,
      mobileIssues: null,
      inspectionResultLink: null,
      firstCheckedAt: null,
      checkCount: null,
      nextCheckAfter: null,
      nextCheckPriority: null,
      canonicalMismatchKind: 'none',
      ...extra,
    } as InspectionEventRow
  }

  async function transitionsFor(store: Map<string, Uint8Array>, month: string) {
    const key = inspectionTransitionsMonthKey(ctx, month)
    return store.has(key) ? await decodeParquetToRows(store.get(key)!) : []
  }

  it('writes nothing when the flag is off', async () => {
    // Default-off so the published minor is inert until a canary opts in.
    const { ds, store } = makeFakeDataSource()
    const inspector = createInspectionStore({ dataSource: ds })
    await inspector.appendInspectionEvents(ctx, [ev('https://e.com/a', '2026-04-01T00:00:00Z', { indexStatus: 'PASS' })], { batchId: 'b1' })
    await inspector.compactInspections(ctx)
    await inspector.appendInspectionEvents(ctx, [ev('https://e.com/a', '2026-04-20T00:00:00Z', { indexStatus: 'FAIL' })], { batchId: 'b2' })
    const res = await inspector.compactInspections(ctx)
    expect(res.transitionsWritten).toBe(0)
    expect(Array.from(store.keys()).some(k => k.includes('/transitions/'))).toBe(false)
  })

  it('records a verdict change as an interval, never a point in time', async () => {
    const { ds, store } = makeFakeDataSource()
    const inspector = createInspectionStore({ dataSource: ds })
    await inspector.appendInspectionEvents(ctx, [ev('https://e.com/a', '2026-04-01T00:00:00Z', { indexStatus: 'PASS', coverageState: 'Submitted and indexed' })], { batchId: 'b1' })
    await inspector.compactInspections(ctx, { transitions: true })
    await inspector.appendInspectionEvents(ctx, [ev('https://e.com/a', '2026-04-20T00:00:00Z', { indexStatus: 'FAIL', coverageState: 'Crawled - currently not indexed' })], { batchId: 'b2' })
    const res = await inspector.compactInspections(ctx, { transitions: true })

    expect(res.transitionsWritten).toBe(1)
    const rows = await transitionsFor(store, '2026-04')
    expect(rows).toHaveLength(1)
    const t = rows[0]!
    expect(t.url).toBe('https://e.com/a')
    expect(t.fromIndexStatus).toBe('PASS')
    expect(t.toIndexStatus).toBe('FAIL')
    expect(t.fromCoverageState).toBe('Submitted and indexed')
    expect(t.toCoverageState).toBe('Crawled - currently not indexed')
    // The change happened SOMEWHERE in this half-open interval. Emitting a
    // `changedAt` would assert a precision the sampler cannot support.
    expect(t.changedAfter).toBe('2026-04-01T00:00:00Z')
    expect(t.changedBefore).toBe('2026-04-20T00:00:00Z')
    expect(Object.keys(t)).not.toContain('changedAt')
  })

  it('ignores a re-observation that changed nothing', async () => {
    const { ds, store } = makeFakeDataSource()
    const inspector = createInspectionStore({ dataSource: ds })
    await inspector.appendInspectionEvents(ctx, [ev('https://e.com/a', '2026-04-01T00:00:00Z', { indexStatus: 'PASS' })], { batchId: 'b1' })
    await inspector.compactInspections(ctx, { transitions: true })
    await inspector.appendInspectionEvents(ctx, [ev('https://e.com/a', '2026-04-20T00:00:00Z', { indexStatus: 'PASS' })], { batchId: 'b2' })
    const res = await inspector.compactInspections(ctx, { transitions: true })
    expect(res.transitionsWritten).toBe(0)
    expect(await transitionsFor(store, '2026-04')).toHaveLength(0)
  })

  it('does not treat a lastCrawlTime bump as a transition', async () => {
    // Google re-crawls far more often than verdicts change; keying on crawl
    // time would make every observation a transition and destroy the ratio the
    // storage budget depends on.
    const { ds, store } = makeFakeDataSource()
    const inspector = createInspectionStore({ dataSource: ds })
    await inspector.appendInspectionEvents(ctx, [ev('https://e.com/a', '2026-04-01T00:00:00Z', { indexStatus: 'PASS', lastCrawlTime: '2026-03-01T00:00:00Z' })], { batchId: 'b1' })
    await inspector.compactInspections(ctx, { transitions: true })
    await inspector.appendInspectionEvents(ctx, [ev('https://e.com/a', '2026-04-20T00:00:00Z', { indexStatus: 'PASS', lastCrawlTime: '2026-04-18T00:00:00Z' })], { batchId: 'b2' })
    const res = await inspector.compactInspections(ctx, { transitions: true })
    expect(res.transitionsWritten).toBe(0)
    // No empty month file either — an existence check must mean "something changed".
    expect(Array.from(store.keys()).some(k => k.includes('/transitions/'))).toBe(false)
  })

  it('emits nothing for a first observation — there is no prior to differ from', async () => {
    const { ds, store } = makeFakeDataSource()
    const inspector = createInspectionStore({ dataSource: ds })
    await inspector.appendInspectionEvents(ctx, [ev('https://e.com/new', '2026-04-01T00:00:00Z', { indexStatus: 'PASS' })], { batchId: 'b1' })
    const res = await inspector.compactInspections(ctx, { transitions: true })
    expect(res.transitionsWritten).toBe(0)
    expect(await transitionsFor(store, '2026-04')).toHaveLength(0)
  })

  it('accumulates into the month file across compactions without losing prior rows', async () => {
    const { ds, store } = makeFakeDataSource()
    const inspector = createInspectionStore({ dataSource: ds })
    await inspector.appendInspectionEvents(ctx, [ev('https://e.com/a', '2026-04-01T00:00:00Z', { indexStatus: 'PASS' })], { batchId: 'b1' })
    await inspector.compactInspections(ctx, { transitions: true })
    await inspector.appendInspectionEvents(ctx, [ev('https://e.com/a', '2026-04-10T00:00:00Z', { indexStatus: 'FAIL' })], { batchId: 'b2' })
    await inspector.compactInspections(ctx, { transitions: true })
    await inspector.appendInspectionEvents(ctx, [ev('https://e.com/a', '2026-04-20T00:00:00Z', { indexStatus: 'PASS' })], { batchId: 'b3' })
    await inspector.compactInspections(ctx, { transitions: true })

    const rows = await transitionsFor(store, '2026-04')
    expect(rows).toHaveLength(2)
    expect(rows.map(r => `${r.fromIndexStatus}->${r.toIndexStatus}`)).toEqual(['PASS->FAIL', 'FAIL->PASS'])
  })

  it('orders several outstanding observations by inspectedAt, not random batch ID', async () => {
    const { ds, store } = makeFakeDataSource()
    const inspector = createInspectionStore({ dataSource: ds })
    await inspector.appendInspectionEvents(ctx, [ev('https://e.com/a', '2026-04-01T00:00:00Z', { indexStatus: 'PASS' })], { batchId: 'base' })
    await inspector.compactInspections(ctx, { transitions: true })

    // Lexical key order is intentionally the reverse of observation order.
    await inspector.appendInspectionEvents(ctx, [ev('https://e.com/a', '2026-04-10T00:00:00Z', { indexStatus: 'FAIL' })], { batchId: 'z-older' })
    await inspector.appendInspectionEvents(ctx, [ev('https://e.com/a', '2026-04-20T00:00:00Z', { indexStatus: 'PASS' })], { batchId: 'a-newer' })
    const res = await inspector.compactInspections(ctx, { transitions: true })

    expect(res.transitionsWritten).toBe(2)
    const rows = await transitionsFor(store, '2026-04')
    expect(rows.map(r => `${r.fromIndexStatus}->${r.toIndexStatus}`)).toEqual(['PASS->FAIL', 'FAIL->PASS'])
  })

  it('is idempotent — a re-run of the same fold does not duplicate a transition', async () => {
    // Compaction can re-run after a crash between the base write and the
    // delete; a duplicated transition would double-count a regression.
    const { ds, store } = makeFakeDataSource()
    const inspector = createInspectionStore({ dataSource: ds })
    await inspector.appendInspectionEvents(ctx, [ev('https://e.com/a', '2026-04-01T00:00:00Z', { indexStatus: 'PASS' })], { batchId: 'b1' })
    await inspector.compactInspections(ctx, { transitions: true })
    await inspector.appendInspectionEvents(ctx, [ev('https://e.com/a', '2026-04-20T00:00:00Z', { indexStatus: 'FAIL' })], { batchId: 'b2' })
    await inspector.compactInspections(ctx, { transitions: true })
    // Same observation arrives again (replayed batch).
    await inspector.appendInspectionEvents(ctx, [ev('https://e.com/a', '2026-04-20T00:00:00Z', { indexStatus: 'FAIL' })], { batchId: 'b2-replay' })
    await inspector.compactInspections(ctx, { transitions: true })

    expect(await transitionsFor(store, '2026-04')).toHaveLength(1)
  })

  it('preserves the prior base and source events when a transition write fails', async () => {
    const { ds, store } = makeFakeDataSource()
    const inspector = createInspectionStore({ dataSource: ds })
    await inspector.appendInspectionEvents(ctx, [ev('https://e.com/a', '2026-04-01T00:00:00Z', { indexStatus: 'PASS' })], { batchId: 'b1' })
    await inspector.compactInspections(ctx, { transitions: true })
    await inspector.appendInspectionEvents(ctx, [ev('https://e.com/a', '2026-04-20T00:00:00Z', { indexStatus: 'FAIL' })], { batchId: 'b2' })

    const transitionKey = inspectionTransitionsMonthKey(ctx, '2026-04')
    const failing = createInspectionStore({ dataSource: {
      ...ds,
      async write(key, bytes) {
        if (key === transitionKey)
          throw new Error('R2 PUT 503: transient transition failure')
        return ds.write(key, bytes)
      },
    } })
    await expect(failing.compactInspections(ctx, { transitions: true })).rejects.toThrow(/transition failure/)

    const rowsAfterFailure = await decodeParquetToRows(store.get(inspectionBaseKey(ctx))!)
    expect(rowsAfterFailure[0]?.indexStatus).toBe('PASS')
    expect(Array.from(store.keys()).some(k => k.includes('/events/2026-04/b2.parquet'))).toBe(true)

    const retry = await inspector.compactInspections(ctx, { transitions: true })
    expect(retry.transitionsWritten).toBe(1)
    expect((await transitionsFor(store, '2026-04')).map(r => `${r.fromIndexStatus}->${r.toIndexStatus}`))
      .toEqual(['PASS->FAIL'])
  })

  it('never deletes the transitions file while folding events', async () => {
    const { ds, store } = makeFakeDataSource()
    const inspector = createInspectionStore({ dataSource: ds })
    await inspector.appendInspectionEvents(ctx, [ev('https://e.com/a', '2026-04-01T00:00:00Z', { indexStatus: 'PASS' })], { batchId: 'b1' })
    await inspector.compactInspections(ctx, { transitions: true })
    await inspector.appendInspectionEvents(ctx, [ev('https://e.com/a', '2026-04-20T00:00:00Z', { indexStatus: 'FAIL' })], { batchId: 'b2' })
    await inspector.compactInspections(ctx, { transitions: true })
    await inspector.appendInspectionEvents(ctx, [ev('https://e.com/b', '2026-04-21T00:00:00Z', { indexStatus: 'PASS' })], { batchId: 'b3' })
    await inspector.compactInspections(ctx, { transitions: true })
    // The whole point: events are disposable, transitions are not.
    expect(Array.from(store.keys()).filter(k => k.includes('/events/'))).toHaveLength(0)
    expect(await transitionsFor(store, '2026-04')).toHaveLength(1)
  })
})

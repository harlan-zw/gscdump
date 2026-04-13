import type { Row, WriteCtx } from '../../src/analytics'
import type { BuilderState } from '../../src/query/types'
import { describe, expect, it } from 'vitest'
import {
  createInMemoryDataSource,
  createInMemoryManifestStore,
  createJsonCodec,
  createStorageEngine,
  createUnionExecutor,
  dayPartition,
} from '../../src/analytics'
import { createFixedSizeCodec } from '../../src/analytics/adapters/in-memory'

function makeCtx(partial: Partial<WriteCtx> = {}): WriteCtx {
  return {
    userId: 'u1',
    siteId: 's1',
    table: 'pages',
    date: '2026-04-10',
    ...partial,
  }
}

function pageRow(url: string, date: string, clicks = 1, impressions = 10): Row {
  return { url, date, clicks, impressions, sum_position: impressions * 5 }
}

function stateForDay(date: string): BuilderState {
  return {
    dimensions: ['page'],
    filter: {
      _filters: [{
        dimension: 'date',
        operator: 'between',
        expression: date,
        expression2: date,
      }],
    } as any,
  }
}

function stateForRange(start: string, end: string): BuilderState {
  return {
    dimensions: ['page'],
    filter: {
      _filters: [{
        dimension: 'date',
        operator: 'between',
        expression: start,
        expression2: end,
      }],
    } as any,
  }
}

function makeEngine(opts: { shardBytes?: number, now?: () => number } = {}) {
  const dataSource = createInMemoryDataSource()
  const manifestStore = createInMemoryManifestStore()
  const codec = createJsonCodec()
  const executor = createUnionExecutor(codec)
  const engine = createStorageEngine({
    dataSource,
    manifestStore,
    codec,
    executor,
    shardBytes: opts.shardBytes,
    now: opts.now,
  })
  return { engine, dataSource, manifestStore, codec, executor }
}

describe('storageEngine.writeDay', () => {
  it('writes a single shard for a small day and registers one live manifest entry', async () => {
    const { engine, manifestStore, dataSource } = makeEngine()
    const ctx = makeCtx()
    await engine.writeDay(ctx, [pageRow('/', '2026-04-10'), pageRow('/about', '2026-04-10')])

    const live = manifestStore.snapshot()
    expect(live).toHaveLength(1)
    expect(live[0].partition).toBe(dayPartition('2026-04-10'))
    expect(live[0].rowCount).toBe(2)
    expect(live[0].retiredAt).toBeUndefined()

    const bytes = await dataSource.read(live[0].objectKey)
    expect(bytes.byteLength).toBe(live[0].bytes)
  })

  it('object keys include content-addressable __v{ts} suffix', async () => {
    const { engine, manifestStore } = makeEngine({ now: () => 1700000000000 })
    await engine.writeDay(makeCtx(), [pageRow('/', '2026-04-10')])
    const [entry] = manifestStore.snapshot()
    expect(entry.objectKey).toMatch(/__v1700000000000\.parquet$/)
  })

  it('registers new version and retires superseded entries with old key intact on disk (A1 race)', async () => {
    const { engine, manifestStore, dataSource } = makeEngine()
    const ctx = makeCtx()
    await engine.writeDay({ ...ctx, now: () => 1000 }, [pageRow('/', '2026-04-10', 1)])
    const [oldEntry] = manifestStore.snapshot()

    // Reader pins to old version
    const pinnedKey = oldEntry.objectKey

    // Writer registers new version
    await engine.writeDay({ ...ctx, now: () => 2000 }, [pageRow('/', '2026-04-10', 99)])

    const liveAfter = manifestStore.snapshot()
    expect(liveAfter).toHaveLength(1)
    expect(liveAfter[0].objectKey).not.toBe(pinnedKey)

    // The old object is still readable — no cross-version corruption
    const oldBytes = await dataSource.read(pinnedKey)
    expect(oldBytes.byteLength).toBeGreaterThan(0)

    const all = manifestStore.all()
    const retired = all.find(e => e.objectKey === pinnedKey)
    expect(retired?.retiredAt).toBe(2000)
  })

  it('shard overflow: write with bytes > shardBytes produces multiple entries under the same partition', async () => {
    const codec = createFixedSizeCodec(100)
    const dataSource = createInMemoryDataSource()
    const manifestStore = createInMemoryManifestStore()
    const executor = createUnionExecutor(codec)
    const engine = createStorageEngine({
      dataSource,
      manifestStore,
      codec,
      executor,
      shardBytes: 500,
    })

    const rows: Row[] = []
    for (let i = 0; i < 20; i++) rows.push(pageRow(`/p${i}`, '2026-04-10'))

    await engine.writeDay(makeCtx(), rows)
    const live = manifestStore.snapshot()
    expect(live.length).toBeGreaterThan(1)
    expect(live.every(e => e.partition === dayPartition('2026-04-10'))).toBe(true)

    const totalRows = live.reduce((s, e) => s + e.rowCount, 0)
    expect(totalRows).toBe(20)

    // All shards are atomically live (no retiredAt)
    expect(live.every(e => e.retiredAt === undefined)).toBe(true)

    // Each shard has distinct objectKey with shard-N suffix
    const shardSuffixes = live.map(e => /__shard-(\d+)__/.exec(e.objectKey)?.[1])
    expect(new Set(shardSuffixes).size).toBe(live.length)
  })

  it('writing into a partition that already has multi-shard version retires all old shards atomically', async () => {
    const codec = createFixedSizeCodec(100)
    const dataSource = createInMemoryDataSource()
    const manifestStore = createInMemoryManifestStore()
    const executor = createUnionExecutor(codec)
    const engine = createStorageEngine({
      dataSource,
      manifestStore,
      codec,
      executor,
      shardBytes: 500,
    })

    const manyRows: Row[] = []
    for (let i = 0; i < 20; i++) manyRows.push(pageRow(`/p${i}`, '2026-04-10'))
    await engine.writeDay({ ...makeCtx(), now: () => 1000 }, manyRows)

    const oldCount = manifestStore.snapshot().length
    expect(oldCount).toBeGreaterThan(1)

    await engine.writeDay({ ...makeCtx(), now: () => 2000 }, [pageRow('/single', '2026-04-10')])

    const live = manifestStore.snapshot()
    expect(live).toHaveLength(1)
    expect(live[0].createdAt).toBe(2000)

    const retired = manifestStore.all().filter(e => e.retiredAt !== undefined)
    expect(retired).toHaveLength(oldCount)
    expect(retired.every(e => e.retiredAt === 2000)).toBe(true)
  })
})

describe('storageEngine.query', () => {
  it('reads only live keys pinned at listLive time (concurrent writer does not poison reader)', async () => {
    const { engine, manifestStore, dataSource } = makeEngine()
    const ctx = makeCtx()
    await engine.writeDay({ ...ctx, now: () => 1000 }, [pageRow('/', '2026-04-10', 1)])

    // Simulate a reader that has already resolved its manifest but not yet fetched bytes
    const liveAtReadStart = await manifestStore.listLive({
      userId: 'u1',
      siteId: 's1',
      table: 'pages',
      partitions: [dayPartition('2026-04-10')],
    })
    expect(liveAtReadStart).toHaveLength(1)
    const pinnedKey = liveAtReadStart[0].objectKey

    // Writer lands a new version mid-read
    await engine.writeDay({ ...ctx, now: () => 2000 }, [pageRow('/', '2026-04-10', 99)])

    // Pinned reader fetches its bytes — must still succeed against the old object
    const bytes = await dataSource.read(pinnedKey)
    expect(bytes.byteLength).toBeGreaterThan(0)

    // A fresh query now sees the new version only
    const result = await engine.query({ userId: 'u1', siteId: 's1' }, stateForDay('2026-04-10'))
    expect(result.objectKeys).toHaveLength(1)
    expect(result.objectKeys[0]).not.toBe(pinnedKey)
  })

  it('query across a date range unions daily + monthly partitions', async () => {
    const { engine } = makeEngine({ now: () => 1000 })
    await engine.writeDay(makeCtx({ date: '2026-03-15' }), [pageRow('/march', '2026-03-15')])
    await engine.writeDay(makeCtx({ date: '2026-04-05' }), [pageRow('/april', '2026-04-05')])

    const state = stateForRange('2026-03-10', '2026-04-10')
    const result = await engine.query({ userId: 'u1', siteId: 's1' }, state)
    expect(result.objectKeys.length).toBe(2)
  })
})

describe('storageEngine.compactDay', () => {
  it('collapses N shards into 1 entry, retires the shards, writes new file', async () => {
    const codec = createFixedSizeCodec(100)
    const dataSource = createInMemoryDataSource()
    const manifestStore = createInMemoryManifestStore()
    const executor = createUnionExecutor(codec)
    const engine = createStorageEngine({
      dataSource,
      manifestStore,
      codec,
      executor,
      shardBytes: 500,
    })

    const rows: Row[] = []
    for (let i = 0; i < 20; i++) rows.push(pageRow(`/p${i}`, '2026-04-10'))
    await engine.writeDay({ ...makeCtx(), now: () => 1000 }, rows)

    const shards = manifestStore.snapshot()
    expect(shards.length).toBeGreaterThan(1)

    await engine.compactDay({ ...makeCtx(), now: () => 2000 }, shards)

    const live = manifestStore.snapshot()
    expect(live).toHaveLength(1)
    expect(live[0].rowCount).toBe(20)
    expect(live[0].createdAt).toBe(2000)

    // Shards retired, not deleted from bytes yet (gc handles that)
    const retired = manifestStore.all().filter(e => e.retiredAt !== undefined)
    expect(retired).toHaveLength(shards.length)
    for (const r of retired)
      expect(await dataSource.read(r.objectKey)).toBeDefined()
  })

  it('compactDay is safe to re-run after a crash between write and manifest-swap (no double count)', async () => {
    const codec = createFixedSizeCodec(100)
    const dataSource = createInMemoryDataSource()
    const manifestStore = createInMemoryManifestStore()
    const executor = createUnionExecutor(codec)
    const engine = createStorageEngine({
      dataSource,
      manifestStore,
      codec,
      executor,
      shardBytes: 500,
    })

    const rows: Row[] = []
    for (let i = 0; i < 20; i++) rows.push(pageRow(`/p${i}`, '2026-04-10'))
    await engine.writeDay({ ...makeCtx(), now: () => 1000 }, rows)

    const shards = manifestStore.snapshot()
    expect(shards.length).toBeGreaterThan(1)

    // Simulate crash: compaction wrote the merged object bytes but manifest
    // registration did not happen. An orphan parquet file exists on dataSource.
    // This is modeled by directly writing a phantom object and leaving shards live.
    await dataSource.write('u_u1/s1/pages/daily/2026-04-10__v1500.parquet', new Uint8Array([1, 2, 3]))

    // Re-run compaction — must not double count
    await engine.compactDay({ ...makeCtx(), now: () => 2000 }, shards)

    const live = manifestStore.snapshot()
    expect(live).toHaveLength(1)
    expect(live[0].rowCount).toBe(20)

    // Orphan pre-crash object remains on dataSource (gc will clean it later)
    const snap = dataSource.snapshot()
    expect(snap.has('u_u1/s1/pages/daily/2026-04-10__v1500.parquet')).toBe(true)
  })

  it('compactDay with a single shard is a no-op', async () => {
    const { engine, manifestStore } = makeEngine()
    await engine.writeDay({ ...makeCtx(), now: () => 1000 }, [pageRow('/', '2026-04-10')])
    const shards = manifestStore.snapshot()
    await engine.compactDay({ ...makeCtx(), now: () => 2000 }, shards)

    const live = manifestStore.snapshot()
    expect(live).toHaveLength(1)
    expect(live[0].createdAt).toBe(1000)
  })
})

describe('storageEngine.compactMonth', () => {
  it('rolls all daily files in a closed month into one monthly file, retires dailies', async () => {
    const { engine, manifestStore } = makeEngine()
    for (const day of ['2026-03-01', '2026-03-15', '2026-03-31']) {
      await engine.writeDay(
        { ...makeCtx({ date: day }), now: () => 1000 },
        [pageRow(`/${day}`, day)],
      )
    }

    const liveBefore = manifestStore.snapshot()
    expect(liveBefore).toHaveLength(3)

    await engine.compactMonth({ ...makeCtx(), now: () => 5000 }, '2026-03')

    const liveAfter = manifestStore.snapshot()
    expect(liveAfter).toHaveLength(1)
    expect(liveAfter[0].partition).toBe('monthly/2026-03')
    expect(liveAfter[0].rowCount).toBe(3)

    const retired = manifestStore.all().filter(e => e.retiredAt !== undefined)
    expect(retired).toHaveLength(3)
  })

  it('compactMonth is a no-op if there is nothing to compact', async () => {
    const { engine, manifestStore } = makeEngine()
    await engine.compactMonth(makeCtx(), '2026-03')
    expect(manifestStore.snapshot()).toHaveLength(0)
  })
})

describe('storageEngine.gcOrphans', () => {
  it('deletes retired entries older than graceMs and leaves recent retirements intact', async () => {
    const { engine, manifestStore, dataSource } = makeEngine()
    const ctx = makeCtx()

    // Write v1, then v2 at t=2000 retires v1
    await engine.writeDay({ ...ctx, now: () => 1000 }, [pageRow('/', '2026-04-10', 1)])
    const v1Key = manifestStore.snapshot()[0].objectKey
    await engine.writeDay({ ...ctx, now: () => 2000 }, [pageRow('/', '2026-04-10', 2)])

    // Retirement happened at t=2000. GC at t=2500 with grace=1h should NOT delete.
    await engine.gcOrphans({ now: () => 2500 }, 60 * 60 * 1000)
    expect(dataSource.snapshot().has(v1Key)).toBe(true)

    // GC at t=2000 + 2h with grace=1h DOES delete.
    const res = await engine.gcOrphans({ now: () => 2000 + 2 * 60 * 60 * 1000 }, 60 * 60 * 1000)
    expect(res.deleted).toBe(1)
    expect(dataSource.snapshot().has(v1Key)).toBe(false)
    expect(manifestStore.all().some(e => e.objectKey === v1Key)).toBe(false)
  })

  it('gcOrphans: retired 500ms ago with graceMs=1h is not deleted', async () => {
    const { engine, manifestStore } = makeEngine()
    await engine.writeDay({ ...makeCtx(), now: () => 1000 }, [pageRow('/', '2026-04-10')])
    await engine.writeDay({ ...makeCtx(), now: () => 2000 }, [pageRow('/', '2026-04-10')])
    const retiredAt = manifestStore.all().find(e => e.retiredAt !== undefined)!.retiredAt!
    const res = await engine.gcOrphans({ now: () => retiredAt + 500 }, 60 * 60 * 1000)
    expect(res.deleted).toBe(0)
  })

  it('gcOrphans: list-based sweep deletes crashed-write files not tracked in manifest', async () => {
    const { engine, dataSource } = makeEngine()
    // Simulate a crashed write: bytes on disk, no manifest entry
    const orphanKey = 'u_u1/s1/pages/daily/2026-04-10__v1000.parquet'
    await dataSource.write(orphanKey, new Uint8Array([1, 2, 3]))

    // With no tenant in ctx, list-based sweep is skipped
    const nTenant = await engine.gcOrphans({ now: () => 2_000_000 }, 0)
    expect(nTenant.deleted).toBe(0)
    expect(dataSource.snapshot().has(orphanKey)).toBe(true)

    // With tenant in ctx, the orphan is swept once past the grace window
    const res = await engine.gcOrphans({ userId: 'u1', siteId: 's1', now: () => 2_000_000 }, 0)
    expect(res.deleted).toBe(1)
    expect(dataSource.snapshot().has(orphanKey)).toBe(false)
  })

  it('gcOrphans: list-based sweep respects grace window for orphan files', async () => {
    const { engine, dataSource } = makeEngine()
    const orphanKey = 'u_u1/s1/pages/daily/2026-04-10__v1500.parquet'
    await dataSource.write(orphanKey, new Uint8Array([1]))

    // now=2000, grace=1000 → cutoff=1000 → orphan v=1500 is NOT yet past grace
    const res1 = await engine.gcOrphans({ userId: 'u1', siteId: 's1', now: () => 2000 }, 1000)
    expect(res1.deleted).toBe(0)
    expect(dataSource.snapshot().has(orphanKey)).toBe(true)

    // now=3000, grace=1000 → cutoff=2000 → orphan v=1500 IS past grace
    const res2 = await engine.gcOrphans({ userId: 'u1', siteId: 's1', now: () => 3000 }, 1000)
    expect(res2.deleted).toBe(1)
  })
})

describe('schema evolution', () => {
  it('reading a partition with fewer columns than current schema returns nulls for missing cols', async () => {
    const codec = createJsonCodec()
    const dataSource = createInMemoryDataSource()
    const manifestStore = createInMemoryManifestStore()

    // Custom executor: uses codec.decode, but simulates column-by-column access
    const executor = {
      async execute({ files }: { files: Array<{ key: string, bytes: Uint8Array }> }) {
        const rows: Row[] = []
        for (const f of files) {
          const decoded = await codec.decode(f.bytes)
          for (const r of decoded) {
            // Simulate union_by_name=true: missing column presents as null
            rows.push({
              url: r.url ?? null,
              date: r.date ?? null,
              clicks: r.clicks ?? null,
              impressions: r.impressions ?? null,
              sum_position: r.sum_position ?? null,
              future_col: (r as any).future_col ?? null,
            })
          }
        }
        return rows
      },
    }

    const engine = createStorageEngine({ dataSource, manifestStore, codec, executor })

    // Write a row with an old subset schema (no future_col)
    await engine.writeDay(makeCtx(), [pageRow('/', '2026-04-10')])

    const result = await engine.query({ userId: 'u1', siteId: 's1' }, stateForDay('2026-04-10'))
    expect(result.rows).toHaveLength(1)
    expect(result.rows[0].future_col).toBeNull()
    expect(result.rows[0].url).toBe('/')
  })
})

describe('manifest listLive filtering', () => {
  it('filters by userId + table + partitions', async () => {
    const { engine, manifestStore } = makeEngine()
    await engine.writeDay(makeCtx({ userId: 'u1', date: '2026-04-01' }), [pageRow('/', '2026-04-01')])
    await engine.writeDay(makeCtx({ userId: 'u2', date: '2026-04-01' }), [pageRow('/', '2026-04-01')])
    await engine.writeDay(makeCtx({ userId: 'u1', table: 'keywords', date: '2026-04-01' }), [{ query: 'foo', date: '2026-04-01', clicks: 1, impressions: 10, sum_position: 50 }])

    const u1pages = await manifestStore.listLive({ userId: 'u1', table: 'pages', partitions: [dayPartition('2026-04-01')] })
    expect(u1pages).toHaveLength(1)
    expect(u1pages[0].userId).toBe('u1')
    expect(u1pages[0].table).toBe('pages')
  })
})

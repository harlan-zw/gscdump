import type { BuilderState } from 'gscdump/query'
import type { Row, WriteCtx } from '../src/index'
import { describe, expect, it } from 'vitest'
import {
  createStorageEngine,
  dayPartition,
} from '../src/index'
import {
  createInMemoryDataSource,
  createInMemoryManifestStore,
  createJsonCodec,
  createUnionExecutor,
} from './helpers/in-memory'

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

function makeEngine(opts: { now?: () => number } = {}) {
  const dataSource = createInMemoryDataSource()
  const manifestStore = createInMemoryManifestStore()
  const codec = createJsonCodec()
  const executor = createUnionExecutor(codec)
  const engine = createStorageEngine({
    dataSource,
    manifestStore,
    codec,
    executor,
    now: opts.now,
  })
  return { engine, dataSource, manifestStore, codec, executor }
}

describe('storageEngine.writeDay', () => {
  it('writes a single file per day and registers one live manifest entry', async () => {
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

  it('stamps the table schema version on every entry', async () => {
    const { engine, manifestStore } = makeEngine()
    await engine.writeDay(makeCtx(), [pageRow('/', '2026-04-10')])
    const [entry] = manifestStore.snapshot()
    expect(entry.schemaVersion).toBe(1)
  })

  it('registers new version and retires superseded entries with old key intact on disk (A1 race)', async () => {
    const { engine, manifestStore, dataSource } = makeEngine()
    const ctx = makeCtx()
    await engine.writeDay({ ...ctx, now: () => 1000 }, [pageRow('/', '2026-04-10', 1)])
    const [oldEntry] = manifestStore.snapshot()

    const pinnedKey = oldEntry.objectKey

    await engine.writeDay({ ...ctx, now: () => 2000 }, [pageRow('/', '2026-04-10', 99)])

    const liveAfter = manifestStore.snapshot()
    expect(liveAfter).toHaveLength(1)
    expect(liveAfter[0].objectKey).not.toBe(pinnedKey)

    const oldBytes = await dataSource.read(pinnedKey)
    expect(oldBytes.byteLength).toBeGreaterThan(0)

    const all = manifestStore.all()
    const retired = all.find(e => e.objectKey === pinnedKey)
    expect(retired?.retiredAt).toBe(2000)
  })
})

describe('storageEngine.query', () => {
  it('reads only live keys pinned at listLive time (concurrent writer does not poison reader)', async () => {
    const { engine, manifestStore, dataSource } = makeEngine()
    const ctx = makeCtx()
    await engine.writeDay({ ...ctx, now: () => 1000 }, [pageRow('/', '2026-04-10', 1)])

    const liveAtReadStart = await manifestStore.listLive({
      userId: 'u1',
      siteId: 's1',
      table: 'pages',
      partitions: [dayPartition('2026-04-10')],
    })
    expect(liveAtReadStart).toHaveLength(1)
    const pinnedKey = liveAtReadStart[0].objectKey

    await engine.writeDay({ ...ctx, now: () => 2000 }, [pageRow('/', '2026-04-10', 99)])

    const bytes = await dataSource.read(pinnedKey)
    expect(bytes.byteLength).toBeGreaterThan(0)

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

describe('storageEngine.compactTiered', () => {
  const TODAY = Date.UTC(2026, 4, 1) // 2026-05-01

  it('rolls all-tier ladder for dailies in one ISO week into a single monthly file', async () => {
    const { engine, manifestStore } = makeEngine({ now: () => TODAY })

    // Three days inside the ISO week starting Mon 2026-03-09.
    for (const day of ['2026-03-09', '2026-03-10', '2026-03-11']) {
      await engine.writeDay(
        { ...makeCtx({ date: day }), now: () => Date.parse(`${day}T00:00:00Z`) },
        [pageRow(`/${day}`, day)],
      )
    }

    const liveBefore = manifestStore.snapshot()
    expect(liveBefore).toHaveLength(3)

    // Force all three tier transitions with the same recent cutoff.
    await engine.compactTiered({ ...makeCtx(), now: () => TODAY }, { raw: 15, d7: 15, d30: 999 })

    const liveAfter = manifestStore.snapshot()
    expect(liveAfter).toHaveLength(1)
    expect(liveAfter[0].partition).toBe('monthly/2026-03')
    expect(liveAfter[0].tier).toBe('d30')
    expect(liveAfter[0].rowCount).toBe(3)

    // 3 raw + 1 intermediate weekly file get retired.
    const retired = manifestStore.all().filter(e => e.retiredAt !== undefined)
    expect(retired.length).toBeGreaterThanOrEqual(3)
  })

  it('leaves recent days at raw tier and only ages out qualifying buckets', async () => {
    const { engine, manifestStore } = makeEngine({ now: () => TODAY })

    await engine.writeDay(
      { ...makeCtx({ date: '2026-04-30' }), now: () => Date.parse('2026-04-30T00:00:00Z') },
      [pageRow('/today', '2026-04-30')],
    )
    await engine.writeDay(
      { ...makeCtx({ date: '2026-03-09' }), now: () => Date.parse('2026-03-09T00:00:00Z') },
      [pageRow('/old', '2026-03-09')],
    )

    await engine.compactTiered({ ...makeCtx(), now: () => TODAY }, { raw: 15, d7: 15, d30: 999 })

    const live = manifestStore.snapshot()
    expect(live).toHaveLength(2)
    const partitions = live.map(e => e.partition).sort()
    expect(partitions).toEqual(['daily/2026-04-30', 'monthly/2026-03'])
  })

  it('no-op when nothing qualifies', async () => {
    const { engine, manifestStore } = makeEngine({ now: () => TODAY })
    await engine.compactTiered({ ...makeCtx(), now: () => TODAY })
    expect(manifestStore.snapshot()).toHaveLength(0)
  })

  it('re-running compactTiered is idempotent (existing monthly is left alone)', async () => {
    const { engine, manifestStore } = makeEngine({ now: () => TODAY })

    for (const day of ['2026-03-09', '2026-03-10']) {
      await engine.writeDay(
        { ...makeCtx({ date: day }), now: () => Date.parse(`${day}T00:00:00Z`) },
        [pageRow(`/${day}`, day)],
      )
    }

    await engine.compactTiered({ ...makeCtx(), now: () => TODAY }, { raw: 15, d7: 15, d30: 999 })
    const firstPass = manifestStore.snapshot()
    expect(firstPass).toHaveLength(1)
    expect(firstPass[0].partition).toBe('monthly/2026-03')

    await engine.compactTiered({ ...makeCtx(), now: () => TODAY + 60_000 }, { raw: 15, d7: 15, d30: 999 })
    const secondPass = manifestStore.snapshot()
    expect(secondPass).toHaveLength(1)
    expect(secondPass[0].objectKey).toBe(firstPass[0].objectKey)
  })

  it('promotes a single raw daily through every tier when its bucket ages out', async () => {
    const { engine, manifestStore } = makeEngine({ now: () => TODAY })
    await engine.writeDay(
      { ...makeCtx({ date: '2026-03-10' }), now: () => Date.parse('2026-03-10T00:00:00Z') },
      [pageRow('/p', '2026-03-10')],
    )

    await engine.compactTiered({ ...makeCtx(), now: () => TODAY }, { raw: 15, d7: 15, d30: 999 })
    const live = manifestStore.snapshot()
    expect(live).toHaveLength(1)
    expect(live[0].tier).toBe('d30')
    expect(live[0].partition).toBe('monthly/2026-03')
  })

  it('compaction merges by (bucket, searchType) — different types never combine', async () => {
    const { engine, manifestStore } = makeEngine({ now: () => TODAY })
    for (const day of ['2026-03-09', '2026-03-10', '2026-03-11']) {
      await engine.writeDay(
        { ...makeCtx({ date: day }), now: () => Date.parse(`${day}T00:00:00Z`), searchType: 'web' },
        [pageRow(`/${day}-web`, day)],
      )
      await engine.writeDay(
        { ...makeCtx({ date: day }), now: () => Date.parse(`${day}T00:00:00Z`) + 1, searchType: 'discover' },
        [pageRow(`/${day}-disc`, day)],
      )
    }
    expect(manifestStore.snapshot()).toHaveLength(6)

    await engine.compactTiered({ ...makeCtx(), now: () => TODAY }, { raw: 15, d7: 15, d30: 999 })

    const live = manifestStore.snapshot()
    expect(live).toHaveLength(2)
    const partitions = live.map(e => e.partition).sort()
    expect(partitions).toEqual(['monthly/2026-03', 'monthly/2026-03'])
    const types = live.map(e => e.searchType ?? 'web').sort()
    expect(types).toEqual(['discover', 'web'])

    // The discover monthly file's object key carries the type segment;
    // the web monthly file uses the legacy path.
    const webEntry = live.find(e => (e.searchType ?? 'web') === 'web')!
    const discoverEntry = live.find(e => e.searchType === 'discover')!
    expect(webEntry.objectKey).not.toContain('/discover/')
    expect(discoverEntry.objectKey).toContain('/pages/discover/monthly/')
    expect(webEntry.rowCount).toBe(3)
    expect(discoverEntry.rowCount).toBe(3)
  })

  it('refuses to compact a bucket whose latest day is inside the GSC pending window', async () => {
    // Simulate: April just ended, sync is still backfilling the last 3 days,
    // someone runs compactTiered with aggressive overrides. The April monthly
    // must NOT be created — otherwise re-sync of April 28-30 produces
    // daily/2026-04-{28,29,30} alongside monthly/2026-04 and the resolver
    // double-counts.
    const MAY_FIRST = Date.UTC(2026, 4, 1, 6) // 2026-05-01 06:00 UTC
    const { engine, manifestStore } = makeEngine({ now: () => MAY_FIRST })

    for (const day of ['2026-04-27', '2026-04-28', '2026-04-29', '2026-04-30']) {
      await engine.writeDay(
        { ...makeCtx({ date: day }), now: () => Date.parse(`${day}T00:00:00Z`) },
        [pageRow(`/${day}`, day)],
      )
    }

    await engine.compactTiered(
      { ...makeCtx(), now: () => MAY_FIRST },
      { raw: 0, d7: 0, d30: 0 },
    )

    const live = manifestStore.snapshot()
    const partitions = live.map(e => e.partition).sort()
    // All four April dailies remain at the raw tier; nothing rolled up.
    expect(partitions).toEqual([
      'daily/2026-04-27',
      'daily/2026-04-28',
      'daily/2026-04-29',
      'daily/2026-04-30',
    ])
  })

  it('compacts a bucket once the pending window has cleared', async () => {
    // Same shape as the previous test but `now` is May 10 — past the 4-day
    // floor for both the ISO week ending May 3 (raw→d7) AND the April month
    // (d7→d30). April should now be eligible and roll all the way to monthly
    // via the d7=0/d30=999 overrides.
    const MAY_TENTH = Date.UTC(2026, 4, 10, 6)
    const { engine, manifestStore } = makeEngine({ now: () => MAY_TENTH })

    for (const day of ['2026-04-27', '2026-04-28', '2026-04-29', '2026-04-30']) {
      await engine.writeDay(
        { ...makeCtx({ date: day }), now: () => Date.parse(`${day}T00:00:00Z`) },
        [pageRow(`/${day}`, day)],
      )
    }

    await engine.compactTiered(
      { ...makeCtx(), now: () => MAY_TENTH },
      { raw: 0, d7: 0, d30: 999 },
    )

    const live = manifestStore.snapshot()
    expect(live).toHaveLength(1)
    expect(live[0].partition).toBe('monthly/2026-04')
    expect(live[0].rowCount).toBe(4)
  })
})

describe('storageEngine.gcOrphans', () => {
  it('deletes retired entries older than graceMs and leaves recent retirements intact', async () => {
    const { engine, manifestStore, dataSource } = makeEngine()
    const ctx = makeCtx()

    await engine.writeDay({ ...ctx, now: () => 1000 }, [pageRow('/', '2026-04-10', 1)])
    const v1Key = manifestStore.snapshot()[0].objectKey
    await engine.writeDay({ ...ctx, now: () => 2000 }, [pageRow('/', '2026-04-10', 2)])

    await engine.gcOrphans({ now: () => 2500 }, 60 * 60 * 1000)
    expect(dataSource.snapshot().has(v1Key)).toBe(true)

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
    const orphanKey = 'u_u1/s1/pages/daily/2026-04-10__v1000.parquet'
    await dataSource.write(orphanKey, new Uint8Array([1, 2, 3]))

    const nTenant = await engine.gcOrphans({ now: () => 2_000_000 }, 0)
    expect(nTenant.deleted).toBe(0)
    expect(dataSource.snapshot().has(orphanKey)).toBe(true)

    const res = await engine.gcOrphans({ userId: 'u1', siteId: 's1', now: () => 2_000_000 }, 0)
    expect(res.deleted).toBe(1)
    expect(dataSource.snapshot().has(orphanKey)).toBe(false)
  })

  it('gcOrphans: list-based sweep respects grace window for orphan files', async () => {
    const { engine, dataSource } = makeEngine()
    const orphanKey = 'u_u1/s1/pages/daily/2026-04-10__v1500.parquet'
    await dataSource.write(orphanKey, new Uint8Array([1]))

    const res1 = await engine.gcOrphans({ userId: 'u1', siteId: 's1', now: () => 2000 }, 1000)
    expect(res1.deleted).toBe(0)
    expect(dataSource.snapshot().has(orphanKey)).toBe(true)

    const res2 = await engine.gcOrphans({ userId: 'u1', siteId: 's1', now: () => 3000 }, 1000)
    expect(res2.deleted).toBe(1)
  })

  it('gcOrphans: re-checks manifest under lock and spares a key that got registered mid-sweep', async () => {
    // Write a file + pre-register its manifest entry in separate calls to
    // simulate "GC lists keys → key gets registered before lock is taken".
    const { engine, manifestStore, dataSource } = makeEngine()
    const ctx = makeCtx()
    const lateKey = 'u_u1/s1/pages/daily/2026-04-10__v500.parquet'
    await dataSource.write(lateKey, new Uint8Array([9]))

    // Register AFTER the GC sweep would have classified it as orphan, but
    // BEFORE the lock-serialized delete pass runs. We emulate this by having
    // withLock do the registration synchronously — the adapter exposes this
    // via a regular registerVersion call interleaved with the sweep.
    const origWithLock = manifestStore.withLock.bind(manifestStore)
    let registered = false
    manifestStore.withLock = async (scope, fn) => {
      return origWithLock(scope, async () => {
        if (!registered) {
          registered = true
          await manifestStore.registerVersion({
            userId: ctx.userId,
            siteId: ctx.siteId,
            table: ctx.table,
            partition: dayPartition('2026-04-10'),
            objectKey: lateKey,
            rowCount: 1,
            bytes: 1,
            createdAt: 500,
          })
        }
        return fn()
      })
    }

    const res = await engine.gcOrphans({ userId: 'u1', siteId: 's1', now: () => 2_000_000 }, 0)
    expect(res.deleted).toBe(0)
    expect(dataSource.snapshot().has(lateKey)).toBe(true)
  })
})

describe('storageEngine locking', () => {
  it('concurrent writeDay calls on the same scope serialize — no lost entries', async () => {
    const { engine, manifestStore } = makeEngine()
    const ctx = makeCtx()
    // Two writes to the same day racing — last-write-wins by createdAt,
    // but both must complete without corruption.
    const w1 = engine.writeDay({ ...ctx, now: () => 1000 }, [pageRow('/', '2026-04-10', 1)])
    const w2 = engine.writeDay({ ...ctx, now: () => 2000 }, [pageRow('/', '2026-04-10', 2)])
    await Promise.all([w1, w2])

    const live = manifestStore.snapshot()
    expect(live).toHaveLength(1)
    const all = manifestStore.all()
    expect(all).toHaveLength(2)
    expect(all.some(e => e.retiredAt !== undefined)).toBe(true)
  })
})

describe('schema evolution', () => {
  it('reading a partition with fewer columns than current schema returns nulls for missing cols', async () => {
    const codec = createJsonCodec()
    const dataSource = createInMemoryDataSource()
    const manifestStore = createInMemoryManifestStore()

    const executor = {
      async execute({ sql, fileKeys, dataSource }: { sql: string, fileKeys: Record<string, string[]>, dataSource: typeof dataSource }) {
        const rows: Row[] = []
        const seen = new Set<string>()
        for (const keys of Object.values(fileKeys)) {
          for (const key of keys) {
            if (seen.has(key))
              continue
            seen.add(key)
            const decoded = await codec.readRows({ table: 'pages' }, key, dataSource)
            for (const r of decoded) {
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
        }
        return { rows, sql }
      },
    }

    const engine = createStorageEngine({ dataSource, manifestStore, codec, executor })

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
    await engine.writeDay(makeCtx({ userId: 'u1', table: 'queries', date: '2026-04-01' }), [{ query: 'foo', date: '2026-04-01', clicks: 1, impressions: 10, sum_position: 50 }])

    const u1pages = await manifestStore.listLive({ userId: 'u1', table: 'pages', partitions: [dayPartition('2026-04-01')] })
    expect(u1pages).toHaveLength(1)
    expect(u1pages[0].userId).toBe('u1')
    expect(u1pages[0].table).toBe('pages')
  })
})

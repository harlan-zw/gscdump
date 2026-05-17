import type { searchTypeSchema } from '@gscdump/contracts'
import type { SearchType } from 'gscdump/query'
import type { z } from 'zod'
import type { Row, WriteCtx } from '../src/index'
import { describe, expect, expectTypeOf, it } from 'vitest'
import {
  createStorageEngine,
  inferSearchType,
  objectKey,
} from '../src/index'
import {
  createInMemoryDataSource,
  createInMemoryManifestStore,
  createJsonCodec,
  createUnionExecutor,
} from './helpers/in-memory'

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

describe('searchType drift guard', () => {
  // The schema in `@gscdump/contracts` is hand-authored (contracts can't depend
  // on `gscdump`), so a new GSC slice added to `SearchTypes` would silently
  // diverge from the validator. Bidirectional type check fails the build the
  // moment that drift appears.
  it('searchTypeSchema infers the same union as gscdump/query SearchType', () => {
    expectTypeOf<z.infer<typeof searchTypeSchema>>().toEqualTypeOf<SearchType>()
  })
})

describe('objectKey: searchType in path', () => {
  it('omits the type segment for web (default), preserving legacy paths', () => {
    const key = objectKey(
      { userId: 'u1', siteId: 's1' },
      'pages',
      'daily/2026-04-10',
      1700,
      'web',
    )
    expect(key).toBe('u_u1/s1/pages/daily/2026-04-10__v1700.parquet')
  })

  it('omits the type segment when searchType is undefined', () => {
    const key = objectKey(
      { userId: 'u1', siteId: 's1' },
      'pages',
      'daily/2026-04-10',
      1700,
    )
    expect(key).toBe('u_u1/s1/pages/daily/2026-04-10__v1700.parquet')
  })

  it('inserts a type segment for non-web searchType', () => {
    const key = objectKey(
      { userId: 'u1', siteId: 's1' },
      'pages',
      'daily/2026-04-10',
      1700,
      'discover',
    )
    expect(key).toBe('u_u1/s1/pages/discover/daily/2026-04-10__v1700.parquet')
  })

  it.each(['discover', 'news', 'googleNews', 'image', 'video'] as const)(
    'inserts a type segment for %s',
    (type) => {
      const key = objectKey(
        { userId: 'u1', siteId: 's1' },
        'pages',
        'daily/2026-04-10',
        1700,
        type,
      )
      expect(key).toContain(`/${type}/daily/`)
    },
  )
})

describe('inferSearchType', () => {
  it('returns web for entries missing the field (legacy data)', () => {
    expect(inferSearchType({})).toBe('web')
  })

  it('returns the explicit value when set', () => {
    expect(inferSearchType({ searchType: 'discover' })).toBe('discover')
  })
})

describe('listLiveFilter.searchType', () => {
  it('returns only the web slice (including legacy/undefined entries) when filter is web', async () => {
    const { engine, manifestStore } = makeEngine()
    // Different days so the two web writes don't supersede each other.
    await engine.writeDay(
      { ...makeCtx(), date: '2026-04-09', now: () => 1000, searchType: 'web' },
      [pageRow('/web-explicit', '2026-04-09', 1)],
    )
    await engine.writeDay(
      { ...makeCtx(), date: '2026-04-10', now: () => 1500 },
      [pageRow('/web-legacy', '2026-04-10', 2)],
    )
    await engine.writeDay(
      { ...makeCtx(), date: '2026-04-10', now: () => 2000, searchType: 'discover' },
      [pageRow('/discover', '2026-04-10', 3)],
    )

    const web = await manifestStore.listLive({
      userId: 'u1',
      siteId: 's1',
      table: 'pages',
      searchType: 'web',
    })
    expect(web).toHaveLength(2)
    expect(web.every(e => inferSearchType(e) === 'web')).toBe(true)

    const discover = await manifestStore.listLive({
      userId: 'u1',
      siteId: 's1',
      table: 'pages',
      searchType: 'discover',
    })
    expect(discover).toHaveLength(1)
    expect(discover[0].objectKey).toContain('/discover/')

    // Undefined filter preserves the cross-type union (admin/GC semantics).
    const all = await manifestStore.listLive({
      userId: 'u1',
      siteId: 's1',
      table: 'pages',
    })
    expect(all).toHaveLength(3)
  })

  it('compaction never merges mixed-searchType entries into the same parquet', async () => {
    const { engine, dataSource, manifestStore } = makeEngine()
    // Write a web + discover daily for each of three consecutive days; all
    // older than the raw→d7 cutoff so the first stage will pick them up.
    const baseDay = Date.parse('2026-04-01T00:00:00Z')
    const days = ['2026-04-01', '2026-04-02', '2026-04-03']
    for (let i = 0; i < days.length; i++) {
      const day = days[i]!
      await engine.writeDay(
        { ...makeCtx(), date: day, now: () => baseDay + i, searchType: 'web' },
        [pageRow(`/web-${day}`, day)],
      )
      await engine.writeDay(
        { ...makeCtx(), date: day, now: () => baseDay + i + 10, searchType: 'discover' },
        [pageRow(`/discover-${day}`, day)],
      )
    }

    // Far in the future relative to the writes — every daily is past the
    // raw→d7 cutoff and the PENDING_WINDOW_DAYS floor.
    const compactAt = baseDay + 60 * 86_400_000
    await engine.compactTiered(
      { ...makeCtx(), now: () => compactAt },
    )

    // Two weekly compaction outputs: one web, one discover. Each must contain
    // only its own slice's input rows.
    // Compaction cascades raw→d7→d30→d90 in a single pass when entries are
    // far enough past the d30 cutoff. End state for these inputs is one
    // monthly entry per searchType — the regression we're testing is that
    // these two stay separate, not which tier they land at.
    const live = manifestStore.snapshot()
    expect(live).toHaveLength(2)
    const byType = new Map(live.map(e => [inferSearchType(e), e]))
    expect(byType.get('web')).toBeDefined()
    expect(byType.get('discover')).toBeDefined()
    expect(byType.get('web')!.objectKey).not.toContain('/discover/')
    expect(byType.get('discover')!.objectKey).toContain('/discover/')

    // Inspect bytes: each compacted parquet must reference only its own slice.
    const dec = new TextDecoder()
    for (const [type, entry] of byType) {
      const bytes = dataSource.snapshot().get(entry.objectKey)!
      const text = dec.decode(bytes)
      if (type === 'web') {
        expect(text).toContain('/web-2026-04-01')
        expect(text).not.toContain('/discover-')
      }
      else {
        expect(text).toContain('/discover-2026-04-01')
        expect(text).not.toContain('/web-')
      }
    }
  })
})

describe('writeDay: searchType partitioning', () => {
  it('different search types coexist in the same date partition without superseding each other', async () => {
    const { engine, manifestStore } = makeEngine()
    await engine.writeDay(
      { ...makeCtx(), now: () => 1000, searchType: 'web' },
      [pageRow('/a', '2026-04-10', 10)],
    )
    await engine.writeDay(
      { ...makeCtx(), now: () => 2000, searchType: 'discover' },
      [pageRow('/b', '2026-04-10', 5)],
    )

    const live = manifestStore.snapshot()
    expect(live).toHaveLength(2)
    const webEntry = live.find(e => inferSearchType(e) === 'web')!
    const discoverEntry = live.find(e => inferSearchType(e) === 'discover')!
    expect(webEntry.objectKey).toContain('/pages/daily/')
    expect(webEntry.objectKey).not.toContain('/discover/')
    expect(discoverEntry.objectKey).toContain('/pages/discover/daily/')
  })

  it('a same-type re-write supersedes only the prior entry of that type', async () => {
    const { engine, manifestStore } = makeEngine()
    await engine.writeDay(
      { ...makeCtx(), now: () => 1000, searchType: 'web' },
      [pageRow('/a', '2026-04-10', 10)],
    )
    await engine.writeDay(
      { ...makeCtx(), now: () => 2000, searchType: 'discover' },
      [pageRow('/b', '2026-04-10', 5)],
    )
    // Re-write web for the same day — should retire the first web entry
    // but leave the discover entry alone.
    await engine.writeDay(
      { ...makeCtx(), now: () => 3000, searchType: 'web' },
      [pageRow('/a-updated', '2026-04-10', 99)],
    )

    const live = manifestStore.snapshot()
    expect(live).toHaveLength(2)
    const all = manifestStore.all()
    const retired = all.filter(e => e.retiredAt !== undefined)
    expect(retired).toHaveLength(1)
    expect(retired[0].searchType ?? 'web').toBe('web')
    expect(retired[0].objectKey).toContain('__v1000')
  })

  it('writing discover after web for the same day leaves the web entry live (no cross-type supersede)', async () => {
    const { engine, manifestStore } = makeEngine()
    // Web first, then discover for the SAME date partition.
    await engine.writeDay(
      { ...makeCtx(), date: '2026-04-10', now: () => 1000, searchType: 'web' },
      [pageRow('/web', '2026-04-10', 7)],
    )
    await engine.writeDay(
      { ...makeCtx(), date: '2026-04-10', now: () => 2000, searchType: 'discover' },
      [pageRow('/discover', '2026-04-10', 3)],
    )

    // Both entries are live; no retiredAt stamped on either.
    const all = manifestStore.all()
    expect(all).toHaveLength(2)
    expect(all.every(e => e.retiredAt === undefined)).toBe(true)

    const live = manifestStore.snapshot()
    expect(live).toHaveLength(2)
    const types = live.map(e => inferSearchType(e)).sort()
    expect(types).toEqual(['discover', 'web'])
    // Object keys live at distinct partitions so the cross-type write cannot
    // overwrite the web bytes either.
    const webEntry = live.find(e => inferSearchType(e) === 'web')!
    const discoverEntry = live.find(e => inferSearchType(e) === 'discover')!
    expect(webEntry.objectKey).not.toBe(discoverEntry.objectKey)
    expect(webEntry.objectKey).toContain('/pages/daily/')
    expect(webEntry.objectKey).not.toContain('/discover/')
    expect(discoverEntry.objectKey).toContain('/pages/discover/daily/')
  })

  it('omitting searchType writes to the legacy (web) path', async () => {
    const { engine, manifestStore } = makeEngine()
    await engine.writeDay(makeCtx(), [pageRow('/a', '2026-04-10')])
    const live = manifestStore.snapshot()
    expect(live).toHaveLength(1)
    expect(live[0].objectKey).not.toContain('/web/')
    expect(live[0].objectKey).toContain('/pages/daily/')
    // searchType field omitted on the entry — defaults to web on read.
    expect(live[0].searchType).toBeUndefined()
    expect(inferSearchType(live[0])).toBe('web')
  })
})

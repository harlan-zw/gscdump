import type { Row, WriteCtx } from '../src/index'
import { describe, expect, it } from 'vitest'
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

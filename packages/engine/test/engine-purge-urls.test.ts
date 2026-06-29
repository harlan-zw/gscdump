import type { BuilderState } from 'gscdump/query'
import type { Row, WriteCtx } from '../src/index'
import { describe, expect, it } from 'vitest'
import { createHyparquetCodec } from '../src/adapters/hyparquet'
import {
  createStorageEngine,
} from '../src/index'
import {
  createInMemoryDataSource,
  createInMemoryManifestStore,
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

function pageKeywordRow(url: string, query: string, date: string): Row {
  return {
    url,
    query,
    date,
    clicks: 1,
    impressions: 10,
    sum_position: 50,
  }
}

function stateForRange(start: string, end: string, dimensions: BuilderState['dimensions']): BuilderState {
  return {
    dimensions,
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
  const codec = createHyparquetCodec()
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

describe('storageEngine.purgeUrls', () => {
  it('removes matching rows from pages and page_keywords and supersedes old entries', async () => {
    let clock = 1000
    const { engine, manifestStore } = makeEngine({ now: () => clock })

    await engine.writeDay(
      makeCtx({ table: 'pages', date: '2026-04-10' }),
      [
        pageRow('/keep', '2026-04-10'),
        pageRow('/deleted-page', '2026-04-10'),
        pageRow('/also-keep', '2026-04-10'),
      ],
    )
    await engine.writeDay(
      makeCtx({ table: 'pages', date: '2026-04-11' }),
      [
        pageRow('/deleted-page', '2026-04-11'),
      ],
    )
    await engine.writeDay(
      makeCtx({ table: 'page_queries', date: '2026-04-10' }),
      [
        pageKeywordRow('/keep', 'foo', '2026-04-10'),
        pageKeywordRow('/deleted-page', 'foo', '2026-04-10'),
        pageKeywordRow('/deleted-page', 'bar', '2026-04-10'),
      ],
    )

    const liveBefore = manifestStore.snapshot()
    expect(liveBefore).toHaveLength(3)

    clock = 9999
    const res = await engine.purgeUrls({ userId: 'u1', siteId: 's1' }, ['/deleted-page'])

    expect(res.urlsRequested).toBe(1)
    // 2 pages entries + 1 page_keywords entry all contained at least one row to remove.
    expect(res.entriesRewritten).toBe(3)
    // 1 row from pages 04-10, 1 from pages 04-11, 2 from page_keywords 04-10.
    expect(res.rowsRemoved).toBe(4)
    expect(res.bytesAfter).toBeGreaterThan(0)

    const liveAfter = manifestStore.snapshot()
    expect(liveAfter).toHaveLength(3)

    const pagesQuery = await engine.query(
      { userId: 'u1', siteId: 's1', table: 'pages' },
      stateForRange('2026-04-01', '2026-04-30', ['page']),
    )
    const pagesUrls = pagesQuery.rows.map(r => r.url).sort()
    expect(pagesUrls).toEqual(['/also-keep', '/keep'])

    const pkQuery = await engine.query(
      { userId: 'u1', siteId: 's1', table: 'page_queries' },
      stateForRange('2026-04-01', '2026-04-30', ['page', 'query']),
    )
    expect(pkQuery.rows).toHaveLength(1)
    expect(pkQuery.rows[0]!.url).toBe('/keep')
  })

  it('leaves entries untouched when no rows match', async () => {
    const { engine, manifestStore } = makeEngine({ now: () => 1000 })
    await engine.writeDay(makeCtx(), [pageRow('/keep', '2026-04-10')])
    const liveBefore = manifestStore.snapshot()

    const res = await engine.purgeUrls({ userId: 'u1', siteId: 's1' }, ['/never-existed'])
    expect(res.entriesRewritten).toBe(0)
    expect(res.rowsRemoved).toBe(0)

    const liveAfter = manifestStore.snapshot()
    expect(liveAfter).toEqual(liveBefore)
  })

  it('replaces an entry with an empty-rows file when all rows match', async () => {
    let clock = 1000
    const { engine, manifestStore } = makeEngine({ now: () => clock })
    await engine.writeDay(
      makeCtx(),
      [pageRow('/doomed-a', '2026-04-10'), pageRow('/doomed-b', '2026-04-10')],
    )

    clock = 2000
    const res = await engine.purgeUrls(
      { userId: 'u1', siteId: 's1' },
      ['/doomed-a', '/doomed-b'],
    )
    expect(res.rowsRemoved).toBe(2)
    expect(res.entriesRewritten).toBe(1)

    const live = manifestStore.snapshot()
    expect(live).toHaveLength(1)
    expect(live[0].rowCount).toBe(0)
    expect(live[0].bytes).toBeGreaterThan(0)

    const query = await engine.query(
      { userId: 'u1', siteId: 's1', table: 'pages' },
      stateForRange('2026-04-01', '2026-04-30', ['page']),
    )
    expect(query.rows).toHaveLength(0)
  })

  it('does not touch tables without a url column', async () => {
    const { engine, manifestStore } = makeEngine({ now: () => 1000 })
    await engine.writeDay(
      makeCtx({ table: 'queries' }),
      [{ query: 'foo', date: '2026-04-10', clicks: 1, impressions: 10, sum_position: 5 }],
    )
    const before = manifestStore.snapshot()

    const res = await engine.purgeUrls({ userId: 'u1', siteId: 's1' }, ['/anything'])
    expect(res.entriesRewritten).toBe(0)
    expect(res.rowsRemoved).toBe(0)

    const after = manifestStore.snapshot()
    expect(after).toEqual(before)
  })

  it('preserves tier and searchType on the rewritten entry', async () => {
    let clock = 1000
    const { engine, manifestStore } = makeEngine({ now: () => clock })
    await engine.writeDay(
      makeCtx({ searchType: 'discover' }),
      [pageRow('/keep', '2026-04-10'), pageRow('/gone', '2026-04-10')],
    )

    clock = 2000
    await engine.purgeUrls({ userId: 'u1', siteId: 's1' }, ['/gone'])

    const live = manifestStore.snapshot()
    expect(live).toHaveLength(1)
    expect(live[0].searchType).toBe('discover')
    expect(live[0].tier).toBe('raw')
    expect(live[0].rowCount).toBe(1)
  })

  it('scrubs the URL from every searchType slice (web + discover)', async () => {
    let clock = 1000
    const { engine, manifestStore } = makeEngine({ now: () => clock })

    // Web slice — legacy/implicit (no searchType field).
    await engine.writeDay(
      makeCtx({ date: '2026-04-10' }),
      [pageRow('/gone', '2026-04-10'), pageRow('/keep', '2026-04-10')],
    )
    clock = 1100
    // Discover slice — same site, same date partition, different slice.
    await engine.writeDay(
      makeCtx({ date: '2026-04-10', searchType: 'discover' }),
      [pageRow('/gone', '2026-04-10'), pageRow('/keep-discover', '2026-04-10')],
    )

    clock = 5000
    const result = await engine.purgeUrls({ userId: 'u1', siteId: 's1' }, ['/gone'])

    // Both entries rewritten, both retired then replaced (one per slice).
    expect(result.entriesRewritten).toBe(2)
    expect(result.rowsRemoved).toBe(2)

    const live = manifestStore.snapshot()
    expect(live).toHaveLength(2)
    const bySlice = new Map(live.map(e => [e.searchType ?? 'web', e]))
    // Web entry keeps the legacy partition path and rebuilt without /gone.
    expect(bySlice.get('web')!.objectKey).not.toContain('/discover/')
    expect(bySlice.get('web')!.rowCount).toBe(1)
    // Discover entry preserves its slice path and rebuilt without /gone.
    expect(bySlice.get('discover')!.objectKey).toContain('/discover/')
    expect(bySlice.get('discover')!.searchType).toBe('discover')
    expect(bySlice.get('discover')!.rowCount).toBe(1)
  })

  it('empty urls array is a no-op', async () => {
    const { engine, manifestStore } = makeEngine({ now: () => 1000 })
    await engine.writeDay(makeCtx(), [pageRow('/keep', '2026-04-10')])
    const before = manifestStore.snapshot()

    const res = await engine.purgeUrls({ userId: 'u1', siteId: 's1' }, [])
    expect(res.urlsRequested).toBe(0)
    expect(res.entriesRewritten).toBe(0)
    expect(manifestStore.snapshot()).toEqual(before)
  })
})

import type { CompleteSitemapGeneration, SitemapMutation } from '../src/entities'
import type { DataSource } from '../src/storage'
import { describe, expect, it } from 'vitest'
import { decodeParquetToRows, encodeRowsToParquetFlex } from '../src/adapters/hyparquet'
import {
  createSitemapReadStore,
  createSitemapStore,
  hashUrl,
  SITEMAP_PROJECTION_GRACE_MS,
  sitemapUrlsDeltaKey,
  sitemapUrlsEventKey,
  sitemapUrlsEventsPrefix,
  sitemapUrlsIndexKey,
  sitemapUrlsProjectionManifestKey,
} from '../src/entities'

const ctx = { userId: 'u1', siteId: 's1' }
const feed = 'https://example.com/sitemap.xml'
const runMutation: SitemapMutation = (_ctx, fn) => fn()

function generation(id: string, observedAt: number): CompleteSitemapGeneration {
  return { _tag: 'complete', id, observedAt }
}

function makeDataSource(): {
  dataSource: DataSource
  objects: Map<string, Uint8Array>
} {
  const objects = new Map<string, Uint8Array>()
  return {
    objects,
    dataSource: {
      read(key) {
        const bytes = objects.get(key)
        return bytes
          ? Promise.resolve(bytes)
          : Promise.reject(new Error(`not found: ${key}`))
      },
      write(key, bytes) {
        objects.set(key, bytes)
        return Promise.resolve()
      },
      delete(keys) {
        for (const key of keys)
          objects.delete(key)
        return Promise.resolve()
      },
      list(prefix) {
        return Promise.resolve([...objects.keys()].filter(key => key.startsWith(prefix)))
      },
    },
  }
}

async function events(
  store: ReturnType<typeof createSitemapReadStore>,
): Promise<Array<{ op: string, loc: string, generationId: string, observedAt: number }>> {
  const loaded: Array<{ op: string, loc: string, generationId: string, observedAt: number }> = []
  for await (const event of store.loadEvents(ctx)) {
    loaded.push({
      op: event.op,
      loc: event.loc,
      generationId: event.generationId,
      observedAt: event.observedAt,
    })
  }
  return loaded
}

describe('sitemap membership generations', () => {
  it('keeps distinct state deltas for two changes on the same UTC day', async () => {
    const { dataSource, objects } = makeDataSource()
    const store = createSitemapStore({ dataSource, withMutation: runMutation })
    const first = generation('crawl-1', Date.parse('2026-07-24T01:00:00Z'))
    const second = generation('crawl-2', Date.parse('2026-07-24T23:00:00Z'))

    await store.snapshotUrls(ctx, first, feed, [{ loc: 'https://example.com/a' }])
    await store.snapshotUrls(ctx, second, feed, [{ loc: 'https://example.com/b' }])

    const deltaKeys = [...objects.keys()].filter(key => key.includes('/urls/deltas/'))
    expect(deltaKeys).toHaveLength(2)
    expect(deltaKeys).toContain(sitemapUrlsDeltaKey(ctx, hashUrl(feed), first))
    expect(deltaKeys).toContain(sitemapUrlsDeltaKey(ctx, hashUrl(feed), second))
    const eventRows = await decodeParquetToRows(objects.get(sitemapUrlsEventKey(ctx, hashUrl(feed), first))!)
    expect(Number(eventRows[0]?.observed_at)).toBe(first.observedAt)
    expect(eventRows[0]?.at).toBeUndefined()

    const live = []
    for await (const row of store.loadUrls(ctx, feed))
      live.push(row.loc)
    expect(live).toEqual(['https://example.com/b'])
  })

  it('routes every mutation through the injected serialization hook', async () => {
    const { dataSource } = makeDataSource()
    const calls: string[] = []
    const withMutation: SitemapMutation = async (mutationCtx, fn) => {
      calls.push(`${mutationCtx.userId}/${mutationCtx.siteId}`)
      return fn()
    }
    const store = createSitemapStore({ dataSource, withMutation })
    const observed = generation('crawl-1', Date.parse('2026-07-24T01:00:00Z'))

    await store.writeSnapshot(ctx, [{ path: feed, capturedAt: '2026-07-24T01:00:00Z' }])
    await store.snapshotUrls(ctx, observed, feed, [{ loc: 'https://example.com/a' }])
    await store.compactUrls(ctx)
    await store.reconcile(ctx, generation('crawl-2', observed.observedAt + 1), { liveFeedpaths: [feed] })

    expect(calls).toEqual(['u1/s1', 'u1/s1', 'u1/s1', 'u1/s1'])
  })

  it('retains add, remove, and re-add events through state compaction', async () => {
    const { dataSource, objects } = makeDataSource()
    const store = createSitemapStore({ dataSource, withMutation: runMutation })
    const loc = 'https://example.com/a'

    await store.snapshotUrls(ctx, generation('crawl-1', 1_700_000_000_001), feed, [{ loc }])
    await store.snapshotUrls(ctx, generation('crawl-2', 1_700_000_000_002), feed, [])
    await store.compactUrls(ctx)
    await store.snapshotUrls(ctx, generation('crawl-3', 1_700_000_000_003), feed, [{ loc }])
    await store.compactUrls(ctx)

    expect(await events(store)).toEqual([
      { op: 'added', loc, generationId: 'crawl-1', observedAt: 1_700_000_000_001 },
      { op: 'removed', loc, generationId: 'crawl-2', observedAt: 1_700_000_000_002 },
      { op: 'added', loc, generationId: 'crawl-3', observedAt: 1_700_000_000_003 },
    ])
    expect([...objects.keys()].filter(key => key.includes('/urls/deltas/'))).toHaveLength(3)
    expect([...objects.keys()].filter(key => key.startsWith(`${sitemapUrlsEventsPrefix(ctx)}/`))).toHaveLength(3)
  })

  it('keeps consumed deltas readable while an in-flight current read finishes', async () => {
    const { dataSource, objects } = makeDataSource()
    let blockNextDeltaRead = false
    let releaseDeltaRead: (() => void) | undefined
    let notifyDeltaRead: (() => void) | undefined
    const deltaReadRequested = new Promise<void>((resolve) => {
      notifyDeltaRead = resolve
    })
    const deltaReadReleased = new Promise<void>((resolve) => {
      releaseDeltaRead = resolve
    })
    const tracked: DataSource = {
      ...dataSource,
      async read(key, range, signal) {
        if (blockNextDeltaRead && key.includes('/urls/deltas/')) {
          blockNextDeltaRead = false
          notifyDeltaRead?.()
          await deltaReadReleased
        }
        return dataSource.read(key, range, signal)
      },
    }
    const store = createSitemapStore({ dataSource: tracked, withMutation: runMutation })
    const loc = 'https://example.com/a'
    await store.snapshotUrls(ctx, generation('crawl-1', 1_700_000_000_001), feed, [{ loc }])

    blockNextDeltaRead = true
    const loaded = Array.fromAsync(store.loadUrls(ctx, feed))
    await deltaReadRequested
    await store.compactUrls(ctx)
    releaseDeltaRead?.()

    await expect(loaded).resolves.toEqual([
      expect.objectContaining({ loc }),
    ])
    expect([...objects.keys()].filter(key => key.includes('/urls/deltas/'))).toHaveLength(1)
  })

  it('deletes retired deltas only after the current-projection grace window', async () => {
    const { dataSource, objects } = makeDataSource()
    let currentTime = 1_700_000_000_100
    const store = createSitemapStore({
      dataSource,
      withMutation: runMutation,
      now: () => currentTime,
    })
    const observed = generation('crawl-1', currentTime)
    await store.snapshotUrls(ctx, observed, feed, [{ loc: 'https://example.com/a' }])
    await store.compactUrls(ctx)

    expect([...objects.keys()].filter(key => key.includes('/urls/deltas/'))).toHaveLength(1)
    expect(objects.has(sitemapUrlsProjectionManifestKey(ctx))).toBe(true)
    await expect(store.compactUrls(ctx)).resolves.toEqual({
      compactedFeedpaths: 0,
      remainingFeedpaths: 0,
    })

    currentTime += SITEMAP_PROJECTION_GRACE_MS + 1
    await store.compactUrls(ctx)

    expect([...objects.keys()].filter(key => key.includes('/urls/deltas/'))).toHaveLength(0)
  })

  it('writes dropped-feed removals before rewriting current state and retains them', async () => {
    const { dataSource, objects } = makeDataSource()
    const writes: string[] = []
    const tracked: DataSource = {
      ...dataSource,
      write(key, bytes) {
        writes.push(key)
        return dataSource.write(key, bytes)
      },
    }
    const store = createSitemapStore({ dataSource: tracked, withMutation: runMutation })
    const first = generation('crawl-1', 1_700_000_000_001)
    const dropped = generation('crawl-2', 1_700_000_000_002)

    await store.snapshotUrls(ctx, first, feed, [{ loc: 'https://example.com/a' }])
    await store.compactUrls(ctx)
    writes.length = 0
    await store.reconcile(ctx, dropped, { liveFeedpaths: [] })

    const eventKey = sitemapUrlsEventKey(ctx, hashUrl(feed), dropped)
    const stateKey = sitemapUrlsIndexKey(ctx, hashUrl(feed))
    expect(writes.indexOf(eventKey)).toBeGreaterThanOrEqual(0)
    expect(writes.indexOf(eventKey)).toBeLessThan(writes.indexOf(stateKey))
    expect((await events(store)).map(event => event.op)).toEqual(['added', 'removed'])
    expect(objects.has(eventKey)).toBe(true)
  })

  it('reconciliation publishes and grace-retains consumed current-state deltas', async () => {
    const { dataSource, objects } = makeDataSource()
    const store = createSitemapStore({ dataSource, withMutation: runMutation })
    const observed = generation('crawl-1', 1_700_000_000_001)
    await store.snapshotUrls(ctx, observed, feed, [{ loc: 'https://example.com/a' }])

    await store.reconcile(ctx, generation('crawl-2', observed.observedAt + 1), {
      liveFeedpaths: [],
    })

    expect([...objects.keys()].filter(key => key.includes('/urls/deltas/'))).toHaveLength(1)
    expect(objects.has(sitemapUrlsProjectionManifestKey(ctx))).toBe(true)
    await expect(Array.fromAsync(store.loadUrls(ctx, feed))).resolves.toEqual([])
  })

  it('seeds event history from an unchanged legacy base', async () => {
    const { dataSource, objects } = makeDataSource()
    const loc = 'https://example.com/existing'
    const feedpathHash = hashUrl(feed)
    objects.set(sitemapUrlsIndexKey(ctx, feedpathHash), encodeRowsToParquetFlex([{
      feedpath: feed,
      feedpath_hash: feedpathHash,
      url_hash: hashUrl(loc),
      loc,
      lastmod: null,
      first_seen_at: 1_600_000_000_000,
      last_seen_at: 1_600_000_000_000,
      removed_at: null,
    }], {
      columns: [
        { name: 'feedpath', type: 'VARCHAR', nullable: false },
        { name: 'feedpath_hash', type: 'VARCHAR', nullable: false },
        { name: 'url_hash', type: 'VARCHAR', nullable: false },
        { name: 'loc', type: 'VARCHAR', nullable: false },
        { name: 'lastmod', type: 'VARCHAR', nullable: true },
        { name: 'first_seen_at', type: 'BIGINT', nullable: false },
        { name: 'last_seen_at', type: 'BIGINT', nullable: false },
        { name: 'removed_at', type: 'BIGINT', nullable: true },
      ],
      sortKey: ['url_hash'],
    }))
    const store = createSitemapStore({ dataSource, withMutation: runMutation })
    const first = generation('first-event-generation', 1_700_000_000_000)

    const result = await store.snapshotUrls(ctx, first, feed, [{ loc }])

    expect(result.unchanged).toBe(true)
    expect(await events(store)).toEqual([{
      op: 'added',
      loc,
      generationId: first.id,
      observedAt: first.observedAt,
    }])
    expect([...objects.keys()].filter(key => key.includes('/urls/deltas/'))).toHaveLength(0)
  })

  it('reads legacy date plus feed state delta keys', async () => {
    const { dataSource, objects } = makeDataSource()
    const feedpathHash = hashUrl(feed)
    const legacyKey = `u_u1/s1/entities/sitemaps/urls/deltas/2026-07-24__${feedpathHash}.parquet`
    objects.set(legacyKey, encodeRowsToParquetFlex([{
      feedpath: feed,
      feedpath_hash: feedpathHash,
      url_hash: hashUrl('https://example.com/legacy'),
      op: 'added',
      loc: 'https://example.com/legacy',
      lastmod: null,
      at: 1_700_000_000_000,
    }], {
      columns: [
        { name: 'feedpath', type: 'VARCHAR', nullable: false },
        { name: 'feedpath_hash', type: 'VARCHAR', nullable: false },
        { name: 'url_hash', type: 'VARCHAR', nullable: false },
        { name: 'op', type: 'VARCHAR', nullable: false },
        { name: 'loc', type: 'VARCHAR', nullable: false },
        { name: 'lastmod', type: 'VARCHAR', nullable: true },
        { name: 'at', type: 'BIGINT', nullable: false },
      ],
      sortKey: ['url_hash'],
    }))

    const store = createSitemapReadStore({ dataSource })
    const loaded = []
    for await (const row of store.loadUrls(ctx, feed))
      loaded.push(row.loc)
    expect(loaded).toEqual(['https://example.com/legacy'])

    const [decoded] = await Promise.all([[...objects.values()][0]].map(bytes => decodeParquetToRows(bytes)))
    expect(decoded).toHaveLength(1)
  })

  it('repairs an event-first partial write before diffing the next generation', async () => {
    const { dataSource, objects } = makeDataSource()
    let failStateWrite = true
    const faulting: DataSource = {
      ...dataSource,
      write(key, bytes) {
        if (failStateWrite && key.includes('/urls/deltas/'))
          return Promise.reject(new Error('state projection failed'))
        return dataSource.write(key, bytes)
      },
    }
    const store = createSitemapStore({ dataSource: faulting, withMutation: runMutation })
    const first = generation('crawl-1', 1_700_000_000_001)
    const second = generation('crawl-2', 1_700_000_000_002)

    await expect(store.snapshotUrls(ctx, first, feed, [{ loc: 'https://example.com/a' }]))
      .rejects
      .toThrow('state projection failed')
    expect([...objects.keys()].filter(key => key.includes('/urls/events/'))).toHaveLength(1)
    expect([...objects.keys()].filter(key => key.includes('/urls/deltas/'))).toHaveLength(0)
    expect(await events(store)).toEqual([])

    failStateWrite = false
    await store.snapshotUrls(ctx, second, feed, [{ loc: 'https://example.com/b' }])

    const live = []
    for await (const row of store.loadUrls(ctx, feed))
      live.push(row.loc)
    expect(live).toEqual(['https://example.com/b'])
    expect((await events(store)).map(event => `${event.op}:${event.loc}`)).toEqual([
      'added:https://example.com/a',
      'removed:https://example.com/a',
      'added:https://example.com/b',
    ])
  })

  it('rejects delayed older feed and site generations', async () => {
    const { dataSource } = makeDataSource()
    const store = createSitemapStore({ dataSource, withMutation: runMutation })
    const newer = generation('crawl-newer', 1_700_000_000_002)
    const older = generation('crawl-older', 1_700_000_000_001)

    await store.snapshotUrls(ctx, newer, feed, [{ loc: 'https://example.com/newer' }])
    await expect(store.snapshotUrls(ctx, older, feed, [{ loc: 'https://example.com/older' }]))
      .rejects
      .toThrow('stale generation')

    await store.reconcile(ctx, generation('site-newer', 1_700_000_000_004), { liveFeedpaths: [feed] })
    await expect(store.reconcile(ctx, generation('site-older', 1_700_000_000_003), { liveFeedpaths: [feed] }))
      .rejects
      .toThrow('stale generation')
  })

  it('rejects divergent input when a generation id is reused', async () => {
    const { dataSource } = makeDataSource()
    const store = createSitemapStore({ dataSource, withMutation: runMutation })
    const observed = generation('crawl-1', 1_700_000_000_001)

    await store.snapshotUrls(ctx, observed, feed, [{ loc: 'https://example.com/a' }])
    await expect(store.snapshotUrls(ctx, observed, feed, [{ loc: 'https://example.com/b' }]))
      .rejects
      .toThrow('snapshot input changed')
  })
})

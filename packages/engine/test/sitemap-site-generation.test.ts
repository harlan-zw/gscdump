import type { CompleteSitemapGeneration, SitemapMutation } from '../src/entities'
import type { DataSource } from '../src/storage'
import { sitemapContentHash } from 'gscdump/sitemap-identity'
import { describe, expect, it } from 'vitest'
import { decodeParquetToRows } from '../src/adapters/hyparquet'
import {
  createSitemapStore,
  hashUrl,
  parseSitemapFeedIdentity,
  sitemapImmutableBaseKey,
  sitemapPayloadHashV1,
  sitemapSiteGenerationManifestKey,
  sitemapSiteManifestKey,
  sitemapStagedFeedKey,
  sitemapUrlsEventKey,
  sitemapUrlsEventsPrefix,
} from '../src/entities'

const ctx = { userId: 'u1', siteId: 's1' }
const feed = 'https://cdn.example.com/Sitemap.xml?x=1'
const runMutation: SitemapMutation = (_ctx, fn) => fn()

function generation(id: string, observedAt: number): CompleteSitemapGeneration {
  return { _tag: 'complete', id, observedAt }
}

function makeDataSource(failWrite?: (key: string, write: number) => boolean): {
  dataSource: DataSource
  objects: Map<string, Uint8Array>
} {
  const objects = new Map<string, Uint8Array>()
  let writes = 0
  return {
    objects,
    dataSource: {
      read(key) {
        const bytes = objects.get(key)
        return bytes ? Promise.resolve(bytes) : Promise.reject(new Error(`not found: ${key}`))
      },
      write(key, bytes) {
        writes++
        if (failWrite?.(key, writes))
          return Promise.reject(new Error(`injected write failure: ${key}`))
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

describe('sitemap site generation authority', () => {
  it('keeps exact feed identity and one canonical membership digest', async () => {
    expect(parseSitemapFeedIdentity(`${feed}#fragment`)).toEqual({ _tag: 'ok', url: feed })
    expect(parseSitemapFeedIdentity('HTTP://CDN.Example.com:80/a/../Sitemap.xml?x=1#fragment'))
      .toEqual({ _tag: 'ok', url: 'http://cdn.example.com/Sitemap.xml?x=1' })
    expect(parseSitemapFeedIdentity('https://user:pass@example.com/sitemap.xml'))
      .toEqual({ _tag: 'invalid', reason: 'credentials' })
    expect(parseSitemapFeedIdentity('ftp://example.com/sitemap.xml')).toEqual({
      _tag: 'invalid',
      reason: 'unsupported_protocol',
    })
    const membership = [
      { loc: 'https://www.Example.com/Foo/?x=1' },
      { loc: 'https://example.com/foo/' },
    ]
    expect(await sitemapContentHash(membership))
      .toMatch(/^v1:[a-f0-9]{64}$/)
    expect(sitemapPayloadHashV1([{ loc: 'https://example.com/a', lastmod: '2026-07-28' }]))
      .not
      .toBe(sitemapPayloadHashV1([{ loc: 'https://example.com/a', lastmod: '2026-07-29' }]))
  })

  it('does not expose staged feeds before the site manifest publishes last', async () => {
    const { dataSource, objects } = makeDataSource()
    const store = createSitemapStore({ dataSource, withMutation: runMutation, now: () => 200 })
    const observed = generation('site-1', 100)

    await expect(store.stageSitemapGenerationFeed(ctx, observed, feed, [
      { loc: 'https://example.com/A?x=1', lastmod: '2026-07-28' },
    ])).resolves.toMatchObject({ _tag: 'staged' })
    await expect(store.getSitemapGeneration(ctx)).resolves.toEqual({ _tag: 'unavailable', reason: 'no_generation' })
    await expect(store.iterateSitemapGenerationUrls(ctx)).resolves.toEqual({
      _tag: 'unavailable',
      reason: 'no_generation',
    })
    expect(objects.has(sitemapSiteManifestKey(ctx))).toBe(false)

    await expect(store.finalizeSitemapGeneration(ctx, observed, {
      _tag: 'complete',
      expectedFeedpaths: [feed],
    })).resolves.toMatchObject({ _tag: 'published', generationId: 'site-1' })
    await expect(store.getSitemapGeneration(ctx)).resolves.toMatchObject({
      _tag: 'available',
      manifest: {
        generationId: 'site-1',
        observedAt: 100,
        publishedAt: 200,
        completeness: { _tag: 'complete' },
      },
    })
  })

  it('preserves raw loc, records lastmod-only updates, and advances effective lastSeenAt without unchanged deltas', async () => {
    const { dataSource, objects } = makeDataSource()
    const store = createSitemapStore({ dataSource, withMutation: runMutation })
    const loc = 'https://example.com/Foo/?x=1'

    await store.stageSitemapGenerationFeed(ctx, generation('site-1', 100), feed, [{ loc, lastmod: '2026-07-28' }])
    await store.finalizeSitemapGeneration(ctx, generation('site-1', 100), { _tag: 'complete', expectedFeedpaths: [feed] })
    await store.stageSitemapGenerationFeed(ctx, generation('site-2', 200), feed, [{ loc, lastmod: '2026-07-29' }])
    await store.finalizeSitemapGeneration(ctx, generation('site-2', 200), { _tag: 'complete', expectedFeedpaths: [feed] })
    await store.stageSitemapGenerationFeed(ctx, generation('site-3', 300), feed, [{ loc, lastmod: '2026-07-29' }])
    await store.finalizeSitemapGeneration(ctx, generation('site-3', 300), { _tag: 'complete', expectedFeedpaths: [feed] })

    await expect(store.listSitemapGenerationUrls(ctx, { generationId: 'site-3', limit: 10 }))
      .resolves
      .toMatchObject({
        _tag: 'page',
        items: [{ loc, lastmod: '2026-07-29', firstSeenAt: 100, lastSeenAt: 300 }],
        generationId: 'site-3',
        nextCursor: null,
      })
    const currentManifest = JSON.parse(
      new TextDecoder().decode(objects.get(sitemapSiteManifestKey(ctx))!),
    ) as { feeds: Record<string, { baseKey: string }> }
    const [currentFeed] = Object.values(currentManifest.feeds)
    const rawRows = await decodeParquetToRows(objects.get(currentFeed!.baseKey)!)
    expect(rawRows[0]?.last_seen_at).toBe(300n)
    const events = await Array.fromAsync(store.loadEvents(ctx))
    expect(events.map(event => event.op)).toEqual(['added', 'updated'])
    expect(events.every(event => event.projectsState)).toBe(true)
    expect(events[1]).toMatchObject({
      op: 'updated',
      lastmod: '2026-07-29',
      previousLastmod: '2026-07-28',
    })
  })

  it('keeps the old manifest readable after every pre-manifest crash and repairs idempotently', async () => {
    const baseline = makeDataSource()
    const initial = createSitemapStore({ dataSource: baseline.dataSource, withMutation: runMutation })
    await initial.stageSitemapGenerationFeed(ctx, generation('site-1', 100), feed, [{ loc: 'https://example.com/a' }])
    await initial.finalizeSitemapGeneration(ctx, generation('site-1', 100), { _tag: 'complete', expectedFeedpaths: [feed] })

    let failManifest = true
    const faulting: DataSource = {
      ...baseline.dataSource,
      write(key, bytes) {
        if (failManifest && key === sitemapSiteManifestKey(ctx)) {
          failManifest = false
          return Promise.reject(new Error('manifest crash'))
        }
        return baseline.dataSource.write(key, bytes)
      },
    }
    const store = createSitemapStore({ dataSource: faulting, withMutation: runMutation })
    await store.stageSitemapGenerationFeed(ctx, generation('site-2', 200), feed, [{ loc: 'https://example.com/b' }])
    await expect(store.finalizeSitemapGeneration(ctx, generation('site-2', 200), {
      _tag: 'complete',
      expectedFeedpaths: [feed],
    })).rejects.toThrow('manifest crash')
    await expect(store.getSitemapGeneration(ctx)).resolves.toMatchObject({
      _tag: 'available',
      manifest: { generationId: 'site-1' },
    })
    await expect(store.getSitemapGeneration(ctx, 'site-2')).resolves.toEqual({
      _tag: 'unavailable',
      reason: 'generation_not_found',
    })

    await expect(store.finalizeSitemapGeneration(ctx, generation('site-2', 200), {
      _tag: 'complete',
      expectedFeedpaths: [feed],
    })).resolves.toMatchObject({ _tag: 'published', generationId: 'site-2' })
  })

  it('leaves every finalize write invisible until the mutable manifest switch', async () => {
    const baseline = makeDataSource()
    const initial = createSitemapStore({ dataSource: baseline.dataSource, withMutation: runMutation })
    const droppedFeed = 'https://cdn.example.com/dropped.xml'
    await initial.stageSitemapGenerationFeed(ctx, generation('site-1', 100), feed, [
      { loc: 'https://example.com/a' },
    ])
    await initial.stageSitemapGenerationFeed(ctx, generation('site-1', 100), droppedFeed, [
      { loc: 'https://example.com/dropped' },
    ])
    await initial.finalizeSitemapGeneration(ctx, generation('site-1', 100), {
      _tag: 'complete',
      expectedFeedpaths: [feed, droppedFeed],
    })
    await initial.stageSitemapGenerationFeed(ctx, generation('site-2', 200), feed, [
      { loc: 'https://example.com/b' },
    ])

    for (const failAt of [1, 2, 3]) {
      const faulting = makeDataSource((_key, write) => write === failAt)
      for (const [key, bytes] of baseline.objects)
        faulting.objects.set(key, bytes)
      const store = createSitemapStore({ dataSource: faulting.dataSource, withMutation: runMutation })
      await expect(store.finalizeSitemapGeneration(ctx, generation('site-2', 200), {
        _tag: 'complete',
        expectedFeedpaths: [feed],
      })).rejects.toThrow('injected write failure')
      await expect(store.getSitemapGeneration(ctx)).resolves.toMatchObject({
        _tag: 'available',
        manifest: { generationId: 'site-1' },
      })
      await expect(store.getSitemapGeneration(ctx, 'site-2')).resolves.toEqual({
        _tag: 'unavailable',
        reason: 'generation_not_found',
      })
    }
  })

  it('fences delayed writers and keeps pinned cursor pages on one generation', async () => {
    const { dataSource } = makeDataSource()
    const store = createSitemapStore({ dataSource, withMutation: runMutation })
    await store.stageSitemapGenerationFeed(ctx, generation('site-2', 200), feed, [
      { loc: 'https://example.com/a' },
      { loc: 'https://example.com/b' },
    ])
    await store.finalizeSitemapGeneration(ctx, generation('site-2', 200), { _tag: 'complete', expectedFeedpaths: [feed] })

    const first = await store.listSitemapGenerationUrls(ctx, { generationId: 'site-2', limit: 1 })
    expect(first).toMatchObject({ _tag: 'page', items: [expect.any(Object)] })
    if (first._tag !== 'page' || !first.nextCursor)
      throw new Error('expected cursor')
    const firstLoc = first.items[0]?.loc

    await store.stageSitemapGenerationFeed(ctx, generation('site-3', 300), feed, [{ loc: 'https://example.com/c' }])
    await store.finalizeSitemapGeneration(ctx, generation('site-3', 300), { _tag: 'complete', expectedFeedpaths: [feed] })
    const second = await store.listSitemapGenerationUrls(ctx, {
      generationId: 'site-2',
      cursor: first.nextCursor,
      limit: 1,
    })
    expect(second).toMatchObject({ _tag: 'page', items: [expect.any(Object)] })
    if (second._tag !== 'page')
      throw new Error('expected second page')
    expect(new Set([firstLoc, second.items[0]?.loc])).toEqual(new Set([
      'https://example.com/a',
      'https://example.com/b',
    ]))

    await store.stageSitemapGenerationFeed(ctx, generation('site-older', 250), feed, [{ loc: 'https://example.com/old' }])
    await expect(store.finalizeSitemapGeneration(ctx, generation('site-older', 250), {
      _tag: 'complete',
      expectedFeedpaths: [feed],
    })).resolves.toMatchObject({ _tag: 'conflict', reason: 'stale_generation' })
  })

  it('binds page cursors to the generation and exact feed selection', async () => {
    const { dataSource } = makeDataSource()
    const store = createSitemapStore({ dataSource, withMutation: runMutation })
    const secondFeed = 'https://cdn.example.com/second.xml?variant=exact'
    await store.stageSitemapGenerationFeed(ctx, generation('site-1', 100), feed, [
      { loc: 'https://example.com/a' },
      { loc: 'https://example.com/b' },
    ])
    await store.stageSitemapGenerationFeed(ctx, generation('site-1', 100), secondFeed, [
      { loc: 'https://example.com/c' },
      { loc: 'https://example.com/d' },
    ])
    await store.finalizeSitemapGeneration(ctx, generation('site-1', 100), {
      _tag: 'complete',
      expectedFeedpaths: [feed, secondFeed],
    })

    const unfiltered = await store.listSitemapGenerationUrls(ctx, {
      generationId: 'site-1',
      limit: 1,
    })
    if (unfiltered._tag !== 'page' || !unfiltered.nextCursor)
      throw new Error('expected unfiltered cursor')
    await expect(store.listSitemapGenerationUrls(ctx, {
      generationId: 'site-1',
      feedpath: feed,
      cursor: unfiltered.nextCursor,
      limit: 1,
    })).resolves.toEqual({ _tag: 'invalid_request', reason: 'invalid_cursor' })

    const filtered = await store.listSitemapGenerationUrls(ctx, {
      generationId: 'site-1',
      feedpath: `${feed}#ignored`,
      limit: 1,
    })
    if (filtered._tag !== 'page' || !filtered.nextCursor)
      throw new Error('expected filtered cursor')
    await expect(store.listSitemapGenerationUrls(ctx, {
      generationId: 'site-1',
      feedpath: secondFeed,
      cursor: filtered.nextCursor,
      limit: 1,
    })).resolves.toEqual({ _tag: 'invalid_request', reason: 'invalid_cursor' })
    await expect(store.listSitemapGenerationUrls(ctx, {
      generationId: 'site-1',
      feedpath: feed,
      cursor: filtered.nextCursor,
      limit: 2,
    })).resolves.toMatchObject({ _tag: 'page' })

    await store.stageSitemapGenerationFeed(ctx, generation('site-2', 200), feed, [
      { loc: 'https://example.com/new-a' },
      { loc: 'https://example.com/new-b' },
    ])
    await store.finalizeSitemapGeneration(ctx, generation('site-2', 200), {
      _tag: 'complete',
      expectedFeedpaths: [feed],
    })
    await expect(store.listSitemapGenerationUrls(ctx, {
      generationId: 'site-2',
      cursor: unfiltered.nextCursor,
      limit: 1,
    })).resolves.toEqual({ _tag: 'invalid_request', reason: 'invalid_cursor' })
  })

  it('aborts staged generations by deleting only validated descriptors and referenced objects', async () => {
    const { dataSource, objects } = makeDataSource()
    const store = createSitemapStore({ dataSource, withMutation: runMutation })
    const observed = generation('aborted-site', 400)
    const feedpathHash = hashUrl(feed)
    const stagedKey = sitemapStagedFeedKey(ctx, observed, feedpathHash)
    const baseKey = sitemapImmutableBaseKey(ctx, observed, feedpathHash)
    const eventKey = sitemapUrlsEventKey(ctx, feedpathHash, observed)
    await store.stageSitemapGenerationFeed(ctx, observed, feed, [
      { loc: 'https://example.com/aborted' },
    ])
    expect([...objects.keys()]).toEqual(expect.arrayContaining([stagedKey, baseKey, eventKey]))

    await store.abortSitemapGeneration(ctx, observed)
    expect(objects.has(stagedKey)).toBe(false)
    expect(objects.has(baseKey)).toBe(false)
    expect(objects.has(eventKey)).toBe(false)
  })

  it('rejects a corrupt staged descriptor without deleting any objects', async () => {
    const { dataSource, objects } = makeDataSource()
    const store = createSitemapStore({ dataSource, withMutation: runMutation })
    const observed = generation('corrupt-site', 500)
    const feedpathHash = hashUrl(feed)
    const stagedKey = sitemapStagedFeedKey(ctx, observed, feedpathHash)
    const baseKey = sitemapImmutableBaseKey(ctx, observed, feedpathHash)
    const eventKey = sitemapUrlsEventKey(ctx, feedpathHash, observed)
    await store.stageSitemapGenerationFeed(ctx, observed, feed, [
      { loc: 'https://example.com/corrupt' },
    ])
    const descriptor = JSON.parse(new TextDecoder().decode(objects.get(stagedKey)!))
    const victimKey = 'unrelated/immutable.parquet'
    objects.set(victimKey, new Uint8Array([1, 2, 3]))
    descriptor.feed.baseKey = victimKey
    objects.set(stagedKey, new TextEncoder().encode(JSON.stringify(descriptor)))

    await expect(store.abortSitemapGeneration(ctx, observed))
      .rejects
      .toThrow('invalid staged sitemap feed descriptor')
    expect(objects.has(victimKey)).toBe(true)
    expect(objects.has(stagedKey)).toBe(true)
    expect(objects.has(baseKey)).toBe(true)
    expect(objects.has(eventKey)).toBe(true)
  })

  it('writes the staged descriptor before immutable objects so pre-descriptor crashes cannot leak', async () => {
    const baseline = makeDataSource()
    const observed = generation('descriptor-crash', 600)
    const feedpathHash = hashUrl(feed)
    const stagedKey = sitemapStagedFeedKey(ctx, observed, feedpathHash)
    const baseKey = sitemapImmutableBaseKey(ctx, observed, feedpathHash)
    const eventKey = sitemapUrlsEventKey(ctx, feedpathHash, observed)
    const faulting: DataSource = {
      ...baseline.dataSource,
      write(key, bytes) {
        if (key === stagedKey)
          return Promise.reject(new Error('descriptor crash'))
        return baseline.dataSource.write(key, bytes)
      },
    }
    const store = createSitemapStore({ dataSource: faulting, withMutation: runMutation })

    await expect(store.stageSitemapGenerationFeed(ctx, observed, feed, [
      { loc: 'https://example.com/orphan' },
    ])).rejects.toThrow('descriptor crash')
    expect(baseline.objects.has(stagedKey)).toBe(false)
    expect(baseline.objects.has(baseKey)).toBe(false)
    expect(baseline.objects.has(eventKey)).toBe(false)
  })

  it('keeps a partial staged write unpublished and aborts every durable artifact', async () => {
    const baseline = makeDataSource()
    const observed = generation('partial-stage', 700)
    const feedpathHash = hashUrl(feed)
    const stagedKey = sitemapStagedFeedKey(ctx, observed, feedpathHash)
    const baseKey = sitemapImmutableBaseKey(ctx, observed, feedpathHash)
    const eventKey = sitemapUrlsEventKey(ctx, feedpathHash, observed)
    let failEvent = true
    const faulting: DataSource = {
      ...baseline.dataSource,
      write(key, bytes) {
        if (failEvent && key === eventKey) {
          failEvent = false
          return Promise.reject(new Error('event crash'))
        }
        return baseline.dataSource.write(key, bytes)
      },
    }
    const store = createSitemapStore({ dataSource: faulting, withMutation: runMutation })

    await expect(store.stageSitemapGenerationFeed(ctx, observed, feed, [
      { loc: 'https://example.com/partial' },
    ])).rejects.toThrow('event crash')
    expect(baseline.objects.has(stagedKey)).toBe(true)
    expect(baseline.objects.has(baseKey)).toBe(true)
    expect(baseline.objects.has(eventKey)).toBe(false)
    await expect(store.finalizeSitemapGeneration(ctx, observed, {
      _tag: 'complete',
      expectedFeedpaths: [feed],
    })).resolves.toMatchObject({ _tag: 'incomplete', missingFeedpaths: [feed] })

    await store.abortSitemapGeneration(ctx, observed)
    expect(baseline.objects.has(stagedKey)).toBe(false)
    expect(baseline.objects.has(baseKey)).toBe(false)
    expect(baseline.objects.has(eventKey)).toBe(false)
  })

  it('refuses to abort a published generation', async () => {
    const { dataSource } = makeDataSource()
    const store = createSitemapStore({ dataSource, withMutation: runMutation })
    const observed = generation('published-site', 800)
    await store.stageSitemapGenerationFeed(ctx, observed, feed, [
      { loc: 'https://example.com/published' },
    ])
    await store.finalizeSitemapGeneration(ctx, observed, {
      _tag: 'complete',
      expectedFeedpaths: [feed],
    })

    await expect(store.abortSitemapGeneration(ctx, observed))
      .rejects
      .toThrow('cannot abort published sitemap generation')
    await expect(store.listSitemapGenerationUrls(ctx, {
      generationId: observed.id,
    })).resolves.toMatchObject({
      _tag: 'page',
      items: [expect.objectContaining({ loc: 'https://example.com/published' })],
    })
  })

  it('publishes dropped-feed removals only through manifest event references', async () => {
    const { dataSource, objects } = makeDataSource()
    const store = createSitemapStore({ dataSource, withMutation: runMutation })
    const droppedFeed = 'https://cdn.example.com/dropped.xml'
    await store.stageSitemapGenerationFeed(ctx, generation('site-1', 100), feed, [
      { loc: 'https://example.com/retained' },
    ])
    await store.stageSitemapGenerationFeed(ctx, generation('site-1', 100), droppedFeed, [
      { loc: 'https://example.com/dropped' },
    ])
    await store.finalizeSitemapGeneration(ctx, generation('site-1', 100), {
      _tag: 'complete',
      expectedFeedpaths: [feed, droppedFeed],
    })
    await store.stageSitemapGenerationFeed(ctx, generation('site-2', 200), feed, [
      { loc: 'https://example.com/retained' },
    ])
    await store.finalizeSitemapGeneration(ctx, generation('site-2', 200), {
      _tag: 'complete',
      expectedFeedpaths: [feed],
    })

    objects.set(`${sitemapUrlsEventsPrefix(ctx)}/unreferenced.parquet`, new Uint8Array([1, 2, 3]))
    const pinnedStore = createSitemapStore({
      dataSource: {
        ...dataSource,
        list(prefix) {
          if (prefix === `${sitemapUrlsEventsPrefix(ctx)}/`)
            return Promise.reject(new Error('published reads must not scan the event prefix'))
          return dataSource.list(prefix)
        },
      },
      withMutation: runMutation,
    })
    const events = await Array.fromAsync(pinnedStore.loadEvents(ctx))
    expect(events).toContainEqual(expect.objectContaining({
      op: 'removed',
      feedpath: droppedFeed,
      loc: 'https://example.com/dropped',
      generationId: 'site-2',
    }))
  })

  it('stops generation ancestry reads once the requested event window is exhausted', async () => {
    const base = makeDataSource()
    const readKeys: string[] = []
    const tracked: DataSource = {
      ...base.dataSource,
      read(key, range, signal) {
        readKeys.push(key)
        return base.dataSource.read(key, range, signal)
      },
    }
    const dayMs = 86_400_000
    const firstObservedAt = Date.UTC(2023, 0, 1)
    let previous: {
      generationId: string
      observedAt: number
      manifestKey: string
    } | null = null
    let currentManifest: Record<string, unknown> | null = null

    for (let index = 0; index < 1_205; index++) {
      const observedAt = firstObservedAt + index * dayMs
      const current = generation(`site-${index}`, observedAt)
      const manifestKey = sitemapSiteGenerationManifestKey(ctx, current)
      currentManifest = {
        version: 1,
        generationId: current.id,
        observedAt,
        publishedAt: observedAt,
        completeness: { _tag: 'complete' },
        membershipHistoryAvailableFrom: firstObservedAt,
        legacyImport: { _tag: 'none' },
        previousGenerationId: previous?.generationId ?? null,
        previousManifestKey: previous?.manifestKey ?? null,
        eventKeys: [],
        feeds: {},
      }
      base.objects.set(
        manifestKey,
        new TextEncoder().encode(JSON.stringify(currentManifest)),
      )
      previous = {
        generationId: current.id,
        observedAt,
        manifestKey,
      }
    }
    base.objects.set(
      sitemapSiteManifestKey(ctx),
      new TextEncoder().encode(JSON.stringify(currentManifest)),
    )

    const store = createSitemapStore({
      dataSource: tracked,
      withMutation: runMutation,
    })
    const from = new Date(previous!.observedAt - 7 * dayMs)
      .toISOString()
      .slice(0, 10)

    await expect(Array.fromAsync(store.loadEvents(ctx, { from }))).resolves.toEqual([])
    expect(
      readKeys.filter(key => key !== sitemapSiteManifestKey(ctx)),
    ).toHaveLength(8)
  })

  it('rejects an older writer that resumes after a newer manifest publishes', async () => {
    const base = makeDataSource()
    const directStore = createSitemapStore({ dataSource: base.dataSource, withMutation: runMutation })
    await directStore.stageSitemapGenerationFeed(ctx, generation('site-1', 100), feed, [
      { loc: 'https://example.com/initial' },
    ])
    await directStore.finalizeSitemapGeneration(ctx, generation('site-1', 100), {
      _tag: 'complete',
      expectedFeedpaths: [feed],
    })
    await directStore.stageSitemapGenerationFeed(ctx, generation('site-2', 200), feed, [
      { loc: 'https://example.com/older-writer' },
    ])
    await directStore.stageSitemapGenerationFeed(ctx, generation('site-3', 300), feed, [
      { loc: 'https://example.com/newer-writer' },
    ])

    let interleave = true
    const oldManifestKey = sitemapSiteGenerationManifestKey(ctx, generation('site-2', 200))
    const delayedDataSource: DataSource = {
      ...base.dataSource,
      async write(key, bytes) {
        if (interleave && key === oldManifestKey) {
          interleave = false
          await directStore.finalizeSitemapGeneration(ctx, generation('site-3', 300), {
            _tag: 'complete',
            expectedFeedpaths: [feed],
          })
        }
        await base.dataSource.write(key, bytes)
      },
    }
    const delayedStore = createSitemapStore({ dataSource: delayedDataSource, withMutation: runMutation })
    await expect(delayedStore.finalizeSitemapGeneration(ctx, generation('site-2', 200), {
      _tag: 'complete',
      expectedFeedpaths: [feed],
    })).resolves.toMatchObject({ _tag: 'conflict', reason: 'stale_generation' })
    await expect(delayedStore.getSitemapGeneration(ctx)).resolves.toMatchObject({
      _tag: 'available',
      manifest: { generationId: 'site-3' },
    })
    await expect(delayedStore.getSitemapGeneration(ctx, 'site-2')).resolves.toEqual({
      _tag: 'unavailable',
      reason: 'generation_not_found',
    })
  })

  it('reads cursor pages one immutable feed base at a time', async () => {
    const base = makeDataSource()
    const readKeys: string[] = []
    const tracked: DataSource = {
      ...base.dataSource,
      read(key, range, signal) {
        readKeys.push(key)
        return base.dataSource.read(key, range, signal)
      },
    }
    const store = createSitemapStore({ dataSource: tracked, withMutation: runMutation })
    const secondFeed = 'https://cdn.example.com/z.xml'
    await store.stageSitemapGenerationFeed(ctx, generation('site-1', 100), feed, [
      { loc: 'https://example.com/a' },
      { loc: 'https://example.com/b' },
    ])
    await store.stageSitemapGenerationFeed(ctx, generation('site-1', 100), secondFeed, [
      { loc: 'https://example.com/c' },
    ])
    await store.finalizeSitemapGeneration(ctx, generation('site-1', 100), {
      _tag: 'complete',
      expectedFeedpaths: [feed, secondFeed],
    })
    readKeys.length = 0

    await expect(store.listSitemapGenerationUrls(ctx, { limit: 1 })).resolves.toMatchObject({
      _tag: 'page',
      items: [expect.any(Object)],
    })
    expect(readKeys.filter(key => key.endsWith('.parquet'))).toHaveLength(1)
  })

  it('streams a pinned generation across export pages while reading each selected feed once', async () => {
    const base = makeDataSource()
    const readKeys: string[] = []
    const tracked: DataSource = {
      ...base.dataSource,
      read(key, range, signal) {
        readKeys.push(key)
        return base.dataSource.read(key, range, signal)
      },
    }
    const store = createSitemapStore({ dataSource: tracked, withMutation: runMutation })
    const secondFeed = 'https://cdn.example.com/z.xml?variant=exact'
    await store.stageSitemapGenerationFeed(ctx, generation('site-1', 100), feed, [
      { loc: 'https://example.com/c' },
      { loc: 'https://example.com/a' },
      { loc: 'https://example.com/b' },
    ])
    await store.stageSitemapGenerationFeed(ctx, generation('site-1', 100), secondFeed, [
      { loc: 'https://example.com/e' },
      { loc: 'https://example.com/d' },
    ])
    await store.finalizeSitemapGeneration(ctx, generation('site-1', 100), {
      _tag: 'complete',
      expectedFeedpaths: [feed, secondFeed],
    })

    const pinned = await store.iterateSitemapGenerationUrls(ctx)
    expect(pinned).toMatchObject({ _tag: 'iterator', generationId: 'site-1' })
    if (pinned._tag !== 'iterator')
      throw new Error('expected generation iterator')

    await store.stageSitemapGenerationFeed(ctx, generation('site-2', 200), feed, [
      { loc: 'https://example.com/new' },
    ])
    await store.finalizeSitemapGeneration(ctx, generation('site-2', 200), {
      _tag: 'complete',
      expectedFeedpaths: [feed],
    })
    readKeys.length = 0

    const pages: string[][] = []
    let page: string[] = []
    for await (const item of pinned.items) {
      page.push(item.loc)
      if (page.length === 2) {
        pages.push(page)
        page = []
      }
    }
    if (page.length > 0)
      pages.push(page)

    expect(pages).toEqual([
      ['https://example.com/a', 'https://example.com/b'],
      ['https://example.com/c', 'https://example.com/d'],
      ['https://example.com/e'],
    ])
    const parquetReads = readKeys.filter(key => key.endsWith('.parquet'))
    expect(parquetReads).toHaveLength(2)
    expect(new Set(parquetReads)).toHaveLength(2)

    readKeys.length = 0
    const filtered = await store.iterateSitemapGenerationUrls(ctx, {
      generationId: 'site-1',
      feedpath: `${secondFeed}#ignored`,
    })
    expect(filtered).toMatchObject({ _tag: 'iterator', generationId: 'site-1' })
    if (filtered._tag !== 'iterator')
      throw new Error('expected filtered generation iterator')
    await expect(Array.fromAsync(filtered.items)).resolves.toEqual([
      expect.objectContaining({ feedpath: secondFeed, loc: 'https://example.com/d' }),
      expect.objectContaining({ feedpath: secondFeed, loc: 'https://example.com/e' }),
    ])
    expect(readKeys.filter(key => key.endsWith('.parquet'))).toHaveLength(1)

    const absentFilter = await store.iterateSitemapGenerationUrls(ctx, {
      generationId: 'site-1',
      feedpath: 'https://cdn.example.com/z.xml?variant=different',
    })
    expect(absentFilter).toMatchObject({ _tag: 'iterator' })
    if (absentFilter._tag !== 'iterator')
      throw new Error('expected empty generation iterator')
    await expect(Array.fromAsync(absentFilter.items)).resolves.toEqual([])

    await expect(store.iterateSitemapGenerationUrls(ctx, {
      feedpath: 'ftp://cdn.example.com/sitemap.xml',
    })).resolves.toEqual({ _tag: 'invalid_request', reason: 'invalid_feed' })
  })
})

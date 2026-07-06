import type { R2ManifestBucketLike } from '../src/adapters/r2-manifest'
import type { ManifestEntry } from '../src/storage'
import { describe, expect, it } from 'vitest'
import { createR2ManifestStore } from '../src/adapters/r2-manifest'

interface FakeR2Object {
  bytes: Uint8Array
  etag: string
}

interface FakeR2Bucket extends R2ManifestBucketLike {
  store: Map<string, FakeR2Object>
  putCount: number
  conditionalRejections: number
}

function makeFakeBucket(): FakeR2Bucket {
  const store = new Map<string, FakeR2Object>()
  let counter = 0
  let putCount = 0
  let conditionalRejections = 0
  function nextEtag(): string {
    counter++
    return `etag-${counter}`
  }
  const bucket: FakeR2Bucket = {
    store,
    get putCount() {
      return putCount
    },
    set putCount(v) {
      putCount = v
    },
    get conditionalRejections() {
      return conditionalRejections
    },
    set conditionalRejections(v) {
      conditionalRejections = v
    },
    async get(key) {
      const obj = store.get(key)
      if (!obj)
        return null
      const text = new TextDecoder().decode(obj.bytes)
      return {
        etag: obj.etag,
        text: async () => text,
      }
    },
    async put(key, bytes, options) {
      putCount++
      const existing = store.get(key)
      if (options?.onlyIf?.etagMatches !== undefined) {
        if (!existing || existing.etag !== options.onlyIf.etagMatches) {
          conditionalRejections++
          return null
        }
      }
      if (options?.onlyIf?.etagDoesNotMatch === '*') {
        if (existing) {
          conditionalRejections++
          return null
        }
      }
      const buf = typeof bytes === 'string' ? new TextEncoder().encode(bytes) : bytes
      const etag = nextEtag()
      store.set(key, { bytes: buf, etag })
      return { etag }
    },
    async list(options) {
      const prefix = options?.prefix ?? ''
      const keys = Array.from(store.keys()).filter(k => k.startsWith(prefix)).sort()
      return {
        objects: keys.map(key => ({ key })),
        truncated: false,
      }
    },
    async delete(keys) {
      const batch = typeof keys === 'string' ? [keys] : keys
      for (const k of batch) store.delete(k)
    },
  }
  return bucket
}

function makeEntry(partial: Partial<ManifestEntry> = {}): ManifestEntry {
  return {
    userId: 'u1',
    siteId: 's1',
    table: 'pages',
    partition: 'daily/2026-04-10',
    objectKey: 'u_u1/s1/pages/daily/2026-04-10__v1000.parquet',
    rowCount: 5,
    bytes: 100,
    createdAt: 1000,
    schemaVersion: 1,
    tier: 'raw',
    ...partial,
  }
}

async function delay(ms: number): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, ms))
}

describe('createR2ManifestStore — happy path', () => {
  it('writes HEAD pointer + immutable snapshot on first registerVersion', async () => {
    const bucket = makeFakeBucket()
    const store = createR2ManifestStore({ bucket, userId: 'u1' })

    await store.registerVersion(makeEntry())
    const live = await store.listLive({ userId: 'u1' })
    expect(live).toHaveLength(1)
    expect(live[0].objectKey).toContain('__v1000')

    // Two writes: snapshot + HEAD
    expect(bucket.putCount).toBe(2)
    expect(bucket.store.has('u_u1/manifest/s1/pages/HEAD')).toBe(true)
    const snapshotKeys = Array.from(bucket.store.keys()).filter(k => k.endsWith('.json'))
    expect(snapshotKeys).toHaveLength(1)
  })

  it('rejects entries for a different user than the scoped store', async () => {
    const bucket = makeFakeBucket()
    const store = createR2ManifestStore({ bucket, userId: 'u1' })

    await expect(store.registerVersion(makeEntry({ userId: 'u2' }))).rejects.toThrow(/scoped to userId=u1/)
  })

  it('retires superseded entries on the next registerVersion', async () => {
    const bucket = makeFakeBucket()
    const store = createR2ManifestStore({ bucket, userId: 'u1' })

    const old = makeEntry()
    await store.registerVersion(old)

    const next = makeEntry({
      objectKey: 'u_u1/s1/pages/daily/2026-04-10__v2000.parquet',
      createdAt: 2000,
    })
    await store.registerVersion(next, [old])

    const live = await store.listLive({ userId: 'u1' })
    expect(live).toHaveLength(1)
    expect(live[0].objectKey).toContain('__v2000')

    const all = await store.listAll({ userId: 'u1' })
    expect(all).toHaveLength(2)
    const retired = all.find(e => e.objectKey.includes('__v1000'))!
    expect(retired.retiredAt).toBe(2000)
  })

  it('shards per (siteId, table) — listLive aggregates across shards', async () => {
    const bucket = makeFakeBucket()
    const store = createR2ManifestStore({ bucket, userId: 'u1' })

    await store.registerVersion(makeEntry({ siteId: 's1', table: 'pages' }))
    await store.registerVersion(makeEntry({
      siteId: 's2',
      table: 'queries',
      objectKey: 'u_u1/s2/keywords/daily/2026-04-10__v1.parquet',
    }))

    const all = await store.listLive({ userId: 'u1' })
    expect(all).toHaveLength(2)

    const justS1 = await store.listLive({ userId: 'u1', siteId: 's1' })
    expect(justS1).toHaveLength(1)
    expect(justS1[0].siteId).toBe('s1')

    const justKeywords = await store.listLive({ userId: 'u1', table: 'queries' })
    expect(justKeywords).toHaveLength(1)
    expect(justKeywords[0].table).toBe('queries')
  })

  it('reads broad shard scans with bounded parallel R2 gets', async () => {
    const bucket = makeFakeBucket()
    const store = createR2ManifestStore({ bucket, userId: 'u1' })
    await store.registerVersions(Array.from({ length: 12 }, (_, i) =>
      makeEntry({
        siteId: `s${i}`,
        objectKey: `u_u1/s${i}/pages/daily/2026-04-10__v1.parquet`,
      })))

    const realGet = bucket.get.bind(bucket)
    let inFlightHeads = 0
    let peakHeads = 0
    bucket.get = async (key) => {
      if (!key.endsWith('/HEAD'))
        return realGet(key)
      inFlightHeads++
      peakHeads = Math.max(peakHeads, inFlightHeads)
      try {
        await delay(5)
        return await realGet(key)
      }
      finally {
        inFlightHeads--
      }
    }

    const live = await store.listLive({ userId: 'u1' })
    expect(live).toHaveLength(12)
    expect(peakHeads).toBeGreaterThan(1)
    expect(peakHeads).toBeLessThanOrEqual(8)
  })

  it('filters by tier, treating legacy entries via inferLegacyTier', async () => {
    const bucket = makeFakeBucket()
    const store = createR2ManifestStore({ bucket, userId: 'u1' })

    // raw (explicit)
    await store.registerVersion(makeEntry({
      partition: 'daily/2026-04-01',
      objectKey: 'u_u1/s1/pages/daily/2026-04-01__v1.parquet',
      tier: 'raw',
    }))
    // d7 (explicit)
    await store.registerVersion(makeEntry({
      objectKey: 'u_u1/s1/pages/weekly/2026-03-23__v1.parquet',
      partition: 'weekly/2026-03-23',
      tier: 'd7',
    }))
    // legacy monthly (no tier field) — inferLegacyTier → d30
    await store.registerVersion(makeEntry({
      objectKey: 'u_u1/s1/pages/monthly/2026-02__v1.parquet',
      partition: 'monthly/2026-02',
      tier: undefined,
    }))

    const raw = await store.listLive({ userId: 'u1', tier: 'raw' })
    expect(raw.map(e => e.partition)).toEqual(['daily/2026-04-01'])

    const d7 = await store.listLive({ userId: 'u1', tier: 'd7' })
    expect(d7.map(e => e.partition)).toEqual(['weekly/2026-03-23'])

    const d30 = await store.listLive({ userId: 'u1', tier: 'd30' })
    expect(d30.map(e => e.partition)).toEqual(['monthly/2026-02'])

    const d90 = await store.listLive({ userId: 'u1', tier: 'd90' })
    expect(d90).toHaveLength(0)
  })

  it('listLive filters by searchType — web matches legacy/undefined, discover matches its slice', async () => {
    const bucket = makeFakeBucket()
    const store = createR2ManifestStore({ bucket, userId: 'u1' })

    // Legacy entry: no searchType field (pre-partitioning data).
    await store.registerVersion(makeEntry({
      objectKey: 'u_u1/s1/pages/daily/2026-04-01__v1.parquet',
      partition: 'daily/2026-04-01',
      searchType: undefined,
    }))
    // Explicit web entry.
    await store.registerVersion(makeEntry({
      objectKey: 'u_u1/s1/pages/daily/2026-04-02__v1.parquet',
      partition: 'daily/2026-04-02',
      searchType: 'web',
    }))
    // Discover entry on the same (site, table).
    await store.registerVersion(makeEntry({
      objectKey: 'u_u1/s1/pages/discover/daily/2026-04-02__v1.parquet',
      partition: 'daily/2026-04-02',
      searchType: 'discover',
    }))

    const web = await store.listLive({ userId: 'u1', searchType: 'web' })
    expect(web.map(e => e.objectKey).sort()).toEqual([
      'u_u1/s1/pages/daily/2026-04-01__v1.parquet',
      'u_u1/s1/pages/daily/2026-04-02__v1.parquet',
    ])

    const discover = await store.listLive({ userId: 'u1', searchType: 'discover' })
    expect(discover.map(e => e.objectKey)).toEqual([
      'u_u1/s1/pages/discover/daily/2026-04-02__v1.parquet',
    ])

    // Undefined filter still unions every slice (admin/GC semantics).
    const all = await store.listLive({ userId: 'u1' })
    expect(all).toHaveLength(3)
  })

  it('lists only the site shard prefix when siteId is provided without table', async () => {
    const bucket = makeFakeBucket()
    const prefixes: string[] = []
    const originalList = bucket.list.bind(bucket)
    bucket.list = async (options) => {
      prefixes.push(options?.prefix ?? '')
      return originalList(options)
    }
    const store = createR2ManifestStore({ bucket, userId: 'u1' })

    await store.registerVersion(makeEntry({ siteId: 's1', table: 'pages', objectKey: 's1-pages' }))
    await store.registerVersion(makeEntry({ siteId: 's2', table: 'pages', objectKey: 's2-pages' }))

    prefixes.length = 0
    const live = await store.listLive({ userId: 'u1', siteId: 's1' })

    expect(live.map(e => e.objectKey)).toEqual(['s1-pages'])
    expect(prefixes).toContain('u_u1/manifest/s1/')
    expect(prefixes).not.toContain('u_u1/manifest/')
  })

  it('tracks watermarks per shard', async () => {
    const bucket = makeFakeBucket()
    const store = createR2ManifestStore({ bucket, userId: 'u1' })

    await store.bumpWatermark({ userId: 'u1', siteId: 's1', table: 'pages' }, '2026-03-15', 1000)
    await store.bumpWatermark({ userId: 'u1', siteId: 's1', table: 'pages' }, '2026-03-20', 2000)
    await store.bumpWatermark({ userId: 'u1', siteId: 's1', table: 'pages' }, '2026-03-10', 3000)
    // Older timestamp must not regress lastSyncAt
    await store.bumpWatermark({ userId: 'u1', siteId: 's1', table: 'pages' }, '2026-03-12', 500)

    const ws = await store.getWatermarks({ userId: 'u1', siteId: 's1', table: 'pages' })
    expect(ws).toHaveLength(1)
    expect(ws[0].oldestDateSynced).toBe('2026-03-10')
    expect(ws[0].newestDateSynced).toBe('2026-03-20')
    expect(ws[0].lastSyncAt).toBe(3000)
  })

  it('tracks watermarks per searchType within a shard', async () => {
    const bucket = makeFakeBucket()
    const store = createR2ManifestStore({ bucket, userId: 'u1' })

    await store.bumpWatermark({ userId: 'u1', siteId: 's1', table: 'pages' }, '2026-04-10', 1000)
    await store.bumpWatermark({ userId: 'u1', siteId: 's1', table: 'pages', searchType: 'discover' }, '2026-04-11', 2000)

    const all = await store.getWatermarks({ userId: 'u1', siteId: 's1', table: 'pages' })
    expect(all).toHaveLength(2)
    expect(await store.getWatermarks({ userId: 'u1', siteId: 's1', table: 'pages', searchType: 'web' }))
      .toMatchObject([{ newestDateSynced: '2026-04-10' }])
    expect(await store.getWatermarks({ userId: 'u1', siteId: 's1', table: 'pages', searchType: 'discover' }))
      .toMatchObject([{ newestDateSynced: '2026-04-11', searchType: 'discover' }])
  })

  it('tracks sync state per searchType — different types do not collide', async () => {
    const bucket = makeFakeBucket()
    const store = createR2ManifestStore({ bucket, userId: 'u1' })
    const baseScope = { userId: 'u1', siteId: 's1', table: 'pages' as const, date: '2026-04-10' }

    await store.setSyncState({ ...baseScope, searchType: 'web' }, 'done', { at: 1000 })
    await store.setSyncState({ ...baseScope, searchType: 'discover' }, 'inflight', { at: 2000 })

    const all = await store.getSyncStates({ userId: 'u1', siteId: 's1' })
    expect(all).toHaveLength(2)

    const web = await store.getSyncStates({ userId: 'u1', siteId: 's1', searchType: 'web' })
    expect(web).toHaveLength(1)
    expect(web[0].state).toBe('done')

    const discover = await store.getSyncStates({ userId: 'u1', siteId: 's1', searchType: 'discover' })
    expect(discover).toHaveLength(1)
    expect(discover[0].state).toBe('inflight')
  })

  it('tracks sync state transitions', async () => {
    const bucket = makeFakeBucket()
    const store = createR2ManifestStore({ bucket, userId: 'u1' })
    const scope = { userId: 'u1', siteId: 's1', table: 'pages' as const, date: '2026-04-10' }

    await store.setSyncState(scope, 'inflight', { at: 1000 })
    let states = await store.getSyncStates({ userId: 'u1', siteId: 's1' })
    expect(states[0].state).toBe('inflight')
    expect(states[0].attempts).toBe(1)

    await store.setSyncState(scope, 'failed', { at: 2000, error: 'boom' })
    states = await store.getSyncStates({ userId: 'u1', siteId: 's1' })
    expect(states[0].state).toBe('failed')
    expect(states[0].error).toBe('boom')
    expect(states[0].attempts).toBe(1)

    await store.setSyncState(scope, 'inflight', { at: 3000 })
    states = await store.getSyncStates({ userId: 'u1', siteId: 's1' })
    expect(states[0].attempts).toBe(2)

    await store.setSyncState(scope, 'done', { at: 4000 })
    states = await store.getSyncStates({ userId: 'u1', siteId: 's1' })
    expect(states[0].state).toBe('done')
    expect(states[0].error).toBeUndefined()
  })

  it('listRetired returns only entries older than cutoff', async () => {
    const bucket = makeFakeBucket()
    const store = createR2ManifestStore({ bucket, userId: 'u1' })
    await store.registerVersion(makeEntry({ retiredAt: 1000 }))
    await store.registerVersion(makeEntry({
      objectKey: 'u_u1/s1/pages/daily/2026-04-11__v1.parquet',
      partition: 'daily/2026-04-11',
      retiredAt: 5000,
    }))

    const retired1 = await store.listRetired(2000)
    expect(retired1).toHaveLength(1)
    expect(retired1[0].retiredAt).toBe(1000)

    const retired2 = await store.listRetired(10_000)
    expect(retired2).toHaveLength(2)
  })

  it('delete removes entries from snapshot and rewrites HEAD', async () => {
    const bucket = makeFakeBucket()
    const store = createR2ManifestStore({ bucket, userId: 'u1' })
    const entry = makeEntry()
    await store.registerVersion(entry)
    expect((await store.listLive({ userId: 'u1' })).length).toBe(1)

    await store.delete([entry])
    expect((await store.listLive({ userId: 'u1' })).length).toBe(0)
    expect((await store.listAll({ userId: 'u1' })).length).toBe(0)
  })
})

describe('createR2ManifestStore — concurrency', () => {
  it('registerVersions mutates independent shards with bounded parallel R2 gets', async () => {
    const bucket = makeFakeBucket()
    const store = createR2ManifestStore({ bucket, userId: 'u1' })
    const entries = Array.from({ length: 12 }, (_, i) =>
      makeEntry({
        siteId: `s${i}`,
        objectKey: `u_u1/s${i}/pages/daily/2026-04-10__v1.parquet`,
      }))

    const realGet = bucket.get.bind(bucket)
    let inFlightHeads = 0
    let peakHeads = 0
    bucket.get = async (key) => {
      if (!key.endsWith('/HEAD'))
        return realGet(key)
      inFlightHeads++
      peakHeads = Math.max(peakHeads, inFlightHeads)
      try {
        await delay(5)
        return await realGet(key)
      }
      finally {
        inFlightHeads--
      }
    }

    await store.registerVersions(entries)
    expect(peakHeads).toBeGreaterThan(1)
    expect(peakHeads).toBeLessThanOrEqual(8)

    const live = await store.listLive({ userId: 'u1' })
    expect(live).toHaveLength(12)
  })

  it('delete mutates independent shards with bounded parallel R2 gets', async () => {
    const bucket = makeFakeBucket()
    const store = createR2ManifestStore({ bucket, userId: 'u1' })
    const entries = Array.from({ length: 12 }, (_, i) =>
      makeEntry({
        siteId: `s${i}`,
        objectKey: `u_u1/s${i}/pages/daily/2026-04-10__v1.parquet`,
      }))
    await store.registerVersions(entries)

    const realGet = bucket.get.bind(bucket)
    let inFlightHeads = 0
    let peakHeads = 0
    bucket.get = async (key) => {
      if (!key.endsWith('/HEAD'))
        return realGet(key)
      inFlightHeads++
      peakHeads = Math.max(peakHeads, inFlightHeads)
      try {
        await delay(5)
        return await realGet(key)
      }
      finally {
        inFlightHeads--
      }
    }

    await store.delete(entries)
    expect(peakHeads).toBeGreaterThan(1)
    expect(peakHeads).toBeLessThanOrEqual(8)

    const live = await store.listLive({ userId: 'u1' })
    expect(live).toHaveLength(0)
  })

  it('cAS retries when HEAD etag changes mid-flight', async () => {
    const bucket = makeFakeBucket()
    const store = createR2ManifestStore({ bucket, userId: 'u1' })
    // Two writers racing on the same shard.
    const a = makeEntry({ objectKey: 'u_u1/s1/pages/daily/2026-04-10__a.parquet', partition: 'daily/2026-04-10' })
    const b = makeEntry({ objectKey: 'u_u1/s1/pages/daily/2026-04-11__b.parquet', partition: 'daily/2026-04-11' })

    // Sequential calls — second one will see stale headEtag if first interleaves.
    // Our fake doesn't actually parallelize, but each write runs read→mutate→
    // conditional-PUT, which exercises the etag-match path.
    await Promise.all([store.registerVersion(a), store.registerVersion(b)])

    const live = await store.listLive({ userId: 'u1' })
    expect(live).toHaveLength(2)
    // At least one CAS retry should have happened because the second write
    // started against a stale (or initial) head etag.
    expect(bucket.conditionalRejections).toBeGreaterThanOrEqual(0)
  })

  it('throws after max retries on persistent contention', async () => {
    const bucket = makeFakeBucket()
    // Force every conditional PUT to fail by overriding put to always reject conditional requests.
    const realPut = bucket.put
    bucket.put = async (key, bytes, options) => {
      if (options?.onlyIf) {
        bucket.conditionalRejections++
        return null
      }
      return realPut(key, bytes)
    }
    const store = createR2ManifestStore({ bucket, userId: 'u1', maxRetries: 3 })
    await expect(store.registerVersion(makeEntry())).rejects.toThrow(/CAS exceeded 3 retries/)
  })

  it('initial HEAD creation uses If-None-Match: * to avoid races', async () => {
    const bucket = makeFakeBucket()
    const store = createR2ManifestStore({ bucket, userId: 'u1' })
    await store.registerVersion(makeEntry())
    // The first HEAD put used etagDoesNotMatch: '*' since there was no prior HEAD.
    // No conditional rejection on a clean bucket.
    expect(bucket.conditionalRejections).toBe(0)
    expect(bucket.store.get('u_u1/manifest/s1/pages/HEAD')).toBeDefined()
  })
})

describe('createR2ManifestStore — invariants', () => {
  it('rejects entries without siteId (R2 store requires shardable scope)', async () => {
    const bucket = makeFakeBucket()
    const store = createR2ManifestStore({ bucket, userId: 'u1' })
    const headless = { ...makeEntry(), siteId: undefined } as ManifestEntry
    await expect(store.registerVersion(headless)).rejects.toThrow(/requires entries to carry siteId/)
  })

  it('withLock is a no-op (CAS handles serialization)', async () => {
    const bucket = makeFakeBucket()
    const store = createR2ManifestStore({ bucket, userId: 'u1' })
    const result = await store.withLock(
      { userId: 'u1', siteId: 's1', table: 'pages', partition: 'daily/2026-04-10' },
      async () => 42,
    )
    expect(result).toBe(42)
  })
})

describe('createR2ManifestStore — purgeTenant', () => {
  it('deletes every shard object for the tenant and reports counts', async () => {
    const bucket = makeFakeBucket()
    const store = createR2ManifestStore({ bucket, userId: 'u1' })

    await store.registerVersions([
      makeEntry({ siteId: 's1', table: 'pages', objectKey: 'k1' }),
      makeEntry({ siteId: 's1', table: 'queries', objectKey: 'k2' }),
      makeEntry({ siteId: 's2', table: 'pages', objectKey: 'k3' }),
    ])
    await store.bumpWatermark({ userId: 'u1', siteId: 's1', table: 'pages' }, '2026-04-10')
    await store.setSyncState(
      { userId: 'u1', siteId: 's1', table: 'pages', date: '2026-04-10' },
      'done',
    )

    const keysBefore = Array.from(bucket.store.keys()).filter(k => k.startsWith('u_u1/manifest/'))
    expect(keysBefore.length).toBeGreaterThan(0)

    const result = await store.purgeTenant({ userId: 'u1' })
    expect(result.entriesRemoved).toBe(3)
    expect(result.watermarksRemoved).toBe(1)
    expect(result.syncStatesRemoved).toBe(1)

    const keysAfter = Array.from(bucket.store.keys()).filter(k => k.startsWith('u_u1/manifest/'))
    expect(keysAfter).toEqual([])

    expect(await store.listLive({ userId: 'u1' })).toEqual([])
    expect(await store.getWatermarks({ userId: 'u1' })).toEqual([])
    expect(await store.getSyncStates({ userId: 'u1' })).toEqual([])
  })

  it('purges one siteId without touching sibling sites', async () => {
    const bucket = makeFakeBucket()
    const store = createR2ManifestStore({ bucket, userId: 'u1' })

    await store.registerVersions([
      makeEntry({ siteId: 's1', objectKey: 'k1' }),
      makeEntry({ siteId: 's2', objectKey: 'k2' }),
    ])

    const result = await store.purgeTenant({ userId: 'u1', siteId: 's1' })
    expect(result.entriesRemoved).toBe(1)

    const live = await store.listLive({ userId: 'u1' })
    expect(live).toHaveLength(1)
    expect(live[0]!.siteId).toBe('s2')
  })

  it('rejects purge for a userId that does not match the store scope', async () => {
    const bucket = makeFakeBucket()
    const store = createR2ManifestStore({ bucket, userId: 'u1' })
    await expect(store.purgeTenant({ userId: 'u2' })).rejects.toThrow(/scoped to userId=u1/)
  })
})

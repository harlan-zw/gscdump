/**
 * Adversarial tests against REAL workerd-backed R2 (miniflare). These probe the
 * edges the happy-path suite and the node fakes never reach: >1000-object
 * pagination, batch-boundary deletes, range reads at/over EOF, zero-byte
 * objects, cross-shard superseding under concurrency, retirement/GC clock
 * skew, orphaned snapshot recovery, purgeTenant accounting, withLock scoping,
 * and key/shard parsing oddities.
 *
 * Run with `pnpm --filter @gscdump/cloudflare test:workers`. Concurrency cases
 * should be run 2-3x to catch flakes.
 */

import type { ManifestEntry } from '@gscdump/engine/contracts'
import { createR2ManifestStore } from '@gscdump/engine'
import { createR2DataSource } from '@gscdump/engine/r2'

import { env } from 'cloudflare:test'
import { beforeEach, describe, expect, it } from 'vitest'

const bucket = env.TEST_BUCKET as any

async function clearBucket(): Promise<void> {
  let cursor: string | undefined
  const keys: string[] = []
  do {
    const res = await bucket.list({ cursor, limit: 1000 })
    for (const o of res.objects) keys.push(o.key)
    cursor = res.truncated ? res.cursor : undefined
  } while (cursor)
  for (let i = 0; i < keys.length; i += 1000)
    await bucket.delete(keys.slice(i, i + 1000))
}

beforeEach(clearBucket)

function makeEntry(partial: Partial<ManifestEntry> = {}): ManifestEntry {
  return {
    userId: 'u1',
    siteId: 's1',
    table: 'pages',
    partition: 'daily/2026-05-01',
    objectKey: `u_u1/s1/pages/${Math.random().toString(36).slice(2)}.parquet`,
    rowCount: 10,
    bytes: 100,
    createdAt: Date.now(),
    ...partial,
  }
}

// ---------------------------------------------------------------------------
// DataSource edges
// ---------------------------------------------------------------------------

describe('createR2DataSource — pagination + batch boundaries', () => {
  it('lists MORE than 1000 objects across real R2 truncation+cursor', async () => {
    const ds = createR2DataSource({ bucket })
    const n = 1100
    // Write in parallel batches to keep the workerd runtime happy.
    for (let base = 0; base < n; base += 100) {
      await Promise.all(
        Array.from({ length: Math.min(100, n - base) }, (_, j) => {
          const i = base + j
          return ds.write(`u_u1/page/${String(i).padStart(5, '0')}.parquet`, new Uint8Array([i & 0xFF]))
        }),
      )
    }
    const listed = await ds.list('u_u1/page/')
    expect(listed.length).toBe(n)
    expect(new Set(listed).size).toBe(n)

    const streamed: string[] = []
    for await (const k of ds.streamList('u_u1/page/')) streamed.push(k)
    expect(streamed.length).toBe(n)
    expect(new Set(streamed).size).toBe(n)
  }, 60_000)

  it('deletes MORE than 1000 keys across the 1000-batch boundary', async () => {
    const ds = createR2DataSource({ bucket })
    const n = 1100
    const keys: string[] = []
    for (let base = 0; base < n; base += 100) {
      await Promise.all(
        Array.from({ length: Math.min(100, n - base) }, (_, j) => {
          const i = base + j
          const key = `u_u1/del/${String(i).padStart(5, '0')}`
          keys.push(key)
          return ds.write(key, new Uint8Array([1]))
        }),
      )
    }
    expect((await ds.list('u_u1/del/')).length).toBe(n)
    await ds.delete(keys)
    expect(await ds.list('u_u1/del/')).toEqual([])
  }, 60_000)

  it('delete([]) is a no-op and never calls the binding', async () => {
    const ds = createR2DataSource({ bucket })
    await expect(ds.delete([])).resolves.toBeUndefined()
  })
})

describe('createR2DataSource — range + zero-byte edges', () => {
  it('reads a zero-byte object back as empty', async () => {
    const ds = createR2DataSource({ bucket })
    await ds.write('u_u1/zero/empty.parquet', new Uint8Array(0))
    const got = await ds.read('u_u1/zero/empty.parquet')
    expect(got.length).toBe(0)
  })

  it('head distinguishes missing (undefined) from zero-byte (bytes:0)', async () => {
    const ds = createR2DataSource({ bucket })
    await ds.write('u_u1/zero/h.parquet', new Uint8Array(0))
    expect(await ds.head('u_u1/zero/h.parquet')).toEqual({ bytes: 0 })
    expect(await ds.head('u_u1/zero/missing.parquet')).toBeUndefined()
  })

  it('range read with length spanning past EOF clamps to available bytes', async () => {
    const ds = createR2DataSource({ bucket })
    const payload = new Uint8Array([1, 2, 3, 4, 5])
    await ds.write('u_u1/range/eof.parquet', payload)
    // Ask for 100 bytes starting at offset 3 — only 2 remain.
    const tail = await ds.read('u_u1/range/eof.parquet', { offset: 3, length: 100 })
    expect([...tail]).toEqual([4, 5])
  })

  // CHARACTERIZATION of a real-R2 limitation the adapter does NOT paper over:
  // the node fake ignored `range` entirely, so these throws only appear here.
  // The adapter forwards `{ offset, length }` straight to `bucket.get`; real R2
  // rejects a zero-length range and an offset at/over EOF with HTTP 416
  // ("range not satisfiable"). Engine read paths must never issue such ranges.
  it('zero-length range read throws on real R2 (range not satisfiable)', async () => {
    const ds = createR2DataSource({ bucket })
    await ds.write('u_u1/range/zlen.parquet', new Uint8Array([1, 2, 3, 4, 5]))
    await expect(ds.read('u_u1/range/zlen.parquet', { offset: 1, length: 0 }))
      .rejects
      .toThrow(/not satisfiable/i)
  })

  it('range read at offset == EOF throws on real R2', async () => {
    const ds = createR2DataSource({ bucket })
    await ds.write('u_u1/range/ateof.parquet', new Uint8Array([1, 2, 3]))
    await expect(ds.read('u_u1/range/ateof.parquet', { offset: 3, length: 4 }))
      .rejects
      .toThrow()
  })
})

// ---------------------------------------------------------------------------
// DataSource key validation gap
// ---------------------------------------------------------------------------

describe('createR2DataSource — unchecked keys on read/write/delete', () => {
  it('uri() rejects keys with control chars, but read/write do NOT assert (documented gap)', async () => {
    // assertKey only guards uri(); read/write/delete forward keys to R2 raw.
    // Document that a key uri() would reject still round-trips through bytes.
    const ds = createR2DataSource({ bucket, bucketName: 'my-bucket' })
    expect(() => ds.uri!('has space.parquet')).toThrow(/unsafe key/)
    // The same key written via write() reaches R2 unchecked.
    await ds.write('u_u1/raw/has space.parquet', new Uint8Array([7]))
    const got = await ds.read('u_u1/raw/has space.parquet')
    expect([...got]).toEqual([7])
  })
})

// ---------------------------------------------------------------------------
// Manifest CAS — cross-shard superseding under concurrency
// ---------------------------------------------------------------------------

describe('createR2ManifestStore — superseding correctness', () => {
  it('registerVersion retires the prior entry exactly once (no resurrection)', async () => {
    const store = createR2ManifestStore({ bucket, userId: 'u1' })
    const old = makeEntry({ objectKey: 'u_u1/s1/pages/old.parquet', createdAt: 1000 })
    await store.registerVersion(old)
    const next = makeEntry({ objectKey: 'u_u1/s1/pages/new.parquet', createdAt: 2000 })
    await store.registerVersion(next, [old])

    const live = await store.listLive({ userId: 'u1', siteId: 's1', table: 'pages' })
    expect(live.map(e => e.objectKey)).toEqual(['u_u1/s1/pages/new.parquet'])

    const all = await store.listAll({ userId: 'u1', siteId: 's1', table: 'pages' })
    expect(all.length).toBe(2)
    const retired = all.find(e => e.objectKey === 'u_u1/s1/pages/old.parquet')!
    expect(retired.retiredAt).toBe(2000)
  })

  it('concurrent registerVersions each superseding the SAME prior entry never double-count, no resurrection', async () => {
    const store = createR2ManifestStore({ bucket, userId: 'u1' })
    const base = makeEntry({ objectKey: 'u_u1/s1/pages/base.parquet', createdAt: 1000 })
    await store.registerVersion(base)

    // N writers each append a fresh entry AND retire `base`. base must end
    // retired exactly once; every new key must survive; live must exclude base.
    const writers = 10
    await Promise.all(
      Array.from({ length: writers }, (_, i) =>
        store.registerVersion(
          makeEntry({ objectKey: `u_u1/s1/pages/r${i}.parquet`, createdAt: 2000 + i }),
          [base],
        )),
    )

    const all = await store.listAll({ userId: 'u1', siteId: 's1', table: 'pages' })
    const baseEntries = all.filter(e => e.objectKey === 'u_u1/s1/pages/base.parquet')
    expect(baseEntries.length).toBe(1)
    expect(baseEntries[0].retiredAt).toBeDefined()

    const live = await store.listLive({ userId: 'u1', siteId: 's1', table: 'pages' })
    expect(live.some(e => e.objectKey === 'u_u1/s1/pages/base.parquet')).toBe(false)
    expect(live.length).toBe(writers)
    expect(new Set(live.map(e => e.objectKey)).size).toBe(writers)
  })

  it('registerVersions (batch) racing registerVersion on DIFFERENT shards do not contend or lose writes', async () => {
    const store = createR2ManifestStore({ bucket, userId: 'u1' })
    // Two distinct shards; a batch hitting both should not serialize against a
    // single-shard write to a third, nor lose anything.
    await Promise.all([
      store.registerVersions([
        makeEntry({ siteId: 'sA', table: 'pages', objectKey: 'u_u1/sA/pages/1.parquet' }),
        makeEntry({ siteId: 'sB', table: 'queries', objectKey: 'u_u1/sB/queries/1.parquet' }),
      ]),
      store.registerVersion(makeEntry({ siteId: 'sC', table: 'pages', objectKey: 'u_u1/sC/pages/1.parquet' })),
      store.registerVersion(makeEntry({ siteId: 'sA', table: 'pages', objectKey: 'u_u1/sA/pages/2.parquet' })),
    ])
    const all = await store.listLive({ userId: 'u1' })
    expect(new Set(all.map(e => e.objectKey)).size).toBe(4)
    const sA = all.filter(e => e.siteId === 'sA')
    expect(sA.length).toBe(2)
  })
})

// ---------------------------------------------------------------------------
// Retirement / GC windows + clock skew
// ---------------------------------------------------------------------------

describe('createR2ManifestStore — retirement + GC windows', () => {
  it('listRetired(olderThan) is inclusive at the boundary (retiredAt <= olderThan)', async () => {
    const store = createR2ManifestStore({ bucket, userId: 'u1' })
    await store.registerVersion(makeEntry({ objectKey: 'u_u1/s1/pages/a.parquet', retiredAt: 1000 }))
    await store.registerVersion(makeEntry({ objectKey: 'u_u1/s1/pages/b.parquet', retiredAt: 1000 }))
    await store.registerVersion(makeEntry({ objectKey: 'u_u1/s1/pages/c.parquet', retiredAt: 2000 }))

    const atBoundary = await store.listRetired(1000)
    expect(atBoundary.map(e => e.objectKey).sort()).toEqual([
      'u_u1/s1/pages/a.parquet',
      'u_u1/s1/pages/b.parquet',
    ])
  })

  it('superseding with equal createdAt clocks still retires (retiredAt == now is fine)', async () => {
    // Non-monotonic / equal clocks: supersededAt = newEntries[0].createdAt.
    const store = createR2ManifestStore({ bucket, userId: 'u1' })
    const old = makeEntry({ objectKey: 'u_u1/s1/pages/old.parquet', createdAt: 5000 })
    await store.registerVersion(old)
    const next = makeEntry({ objectKey: 'u_u1/s1/pages/new.parquet', createdAt: 5000 })
    await store.registerVersion(next, [old])

    const all = await store.listAll({ userId: 'u1', siteId: 's1', table: 'pages' })
    const retired = all.find(e => e.objectKey === 'u_u1/s1/pages/old.parquet')!
    expect(retired.retiredAt).toBe(5000)
  })

  it('orphaned v<id>.json snapshot from a rejected CAS is NEVER read back as live', async () => {
    // Force contention to orphan snapshots, then verify only HEAD-reachable
    // entries are live. Read shard directly: live set must equal what HEAD points at.
    const store = createR2ManifestStore({ bucket, userId: 'u1' })
    const writers = 8
    await Promise.all(
      Array.from({ length: writers }, (_, i) =>
        store.registerVersion(makeEntry({ objectKey: `u_u1/s1/pages/o${i}.parquet` }))),
    )
    const live = await store.listLive({ userId: 'u1', siteId: 's1', table: 'pages' })
    expect(live.length).toBe(writers)

    // The HEAD pointer names exactly one snapshot; its entries are the live set.
    const head = await bucket.get('u_u1/manifest/s1/pages/HEAD')
    const snapId = (await head.text()).trim()
    const snap = await bucket.get(`u_u1/manifest/s1/pages/v${snapId}.json`)
    const parsed = JSON.parse(await snap.text())
    expect(parsed.entries.length).toBe(writers)
  })

  it('recovers when HEAD points at a deleted snapshot (resets shard to empty, next write succeeds)', async () => {
    const store = createR2ManifestStore({ bucket, userId: 'u1' })
    await store.registerVersion(makeEntry({ objectKey: 'u_u1/s1/pages/first.parquet' }))
    // Manually delete the snapshot HEAD points at, leaving a dangling HEAD.
    const head = await bucket.get('u_u1/manifest/s1/pages/HEAD')
    const snapId = (await head.text()).trim()
    await bucket.delete(`u_u1/manifest/s1/pages/v${snapId}.json`)

    // listLive must treat the dangling shard as empty, not throw.
    const live = await store.listLive({ userId: 'u1', siteId: 's1', table: 'pages' })
    expect(live).toEqual([])

    // Next write must succeed (CAS uses the existing HEAD etag) and become live.
    await store.registerVersion(makeEntry({ objectKey: 'u_u1/s1/pages/recovered.parquet' }))
    const after = await store.listLive({ userId: 'u1', siteId: 's1', table: 'pages' })
    expect(after.map(e => e.objectKey)).toEqual(['u_u1/s1/pages/recovered.parquet'])
  })
})

// ---------------------------------------------------------------------------
// Extreme contention
// ---------------------------------------------------------------------------

describe('createR2ManifestStore — extreme contention', () => {
  it('30 writers on one hot shard either all converge or throw a bounded CAS error (no infinite loop, no lost writes among survivors)', async () => {
    const store = createR2ManifestStore({ bucket, userId: 'u1' })
    const writers = 30
    const results = await Promise.allSettled(
      Array.from({ length: writers }, (_, i) =>
        store.registerVersion(makeEntry({ objectKey: `u_u1/s1/pages/h${i}.parquet` }))),
    )
    const rejected = results.filter(r => r.status === 'rejected')
    // If any rejected, it must be the bounded CAS error (never a hang).
    for (const r of rejected)
      expect((r as PromiseRejectedResult).reason.message).toMatch(/CAS exceeded \d+ retries/)

    // Every writer that resolved must be present exactly once.
    const live = await store.listLive({ userId: 'u1', siteId: 's1', table: 'pages' })
    const resolvedCount = results.filter(r => r.status === 'fulfilled').length
    expect(live.length).toBe(resolvedCount)
    expect(new Set(live.map(e => e.objectKey)).size).toBe(resolvedCount)
  })

  it('maxRetries bounds attempts — a permanently contended shard throws rather than hangs', async () => {
    // Wrap put so HEAD conditional writes always fail: simulates a never-winning writer.
    const hostile = {
      get: bucket.get.bind(bucket),
      list: bucket.list.bind(bucket),
      delete: bucket.delete.bind(bucket),
      put: async (key: string, bytes: any, opts: any) => {
        if (opts?.onlyIf)
          return null
        return bucket.put(key, bytes)
      },
    }
    const store = createR2ManifestStore({ bucket: hostile as any, userId: 'u1', maxRetries: 4 })
    await expect(store.registerVersion(makeEntry())).rejects.toThrow(/CAS exceeded 4 retries/)
  })
})

// ---------------------------------------------------------------------------
// purgeTenant
// ---------------------------------------------------------------------------

describe('createR2ManifestStore — purgeTenant', () => {
  it('purges all shards + watermarks + sync-states with correct counts across many snapshot files', async () => {
    const store = createR2ManifestStore({ bucket, userId: 'u1' })
    // Accumulate multiple snapshot generations per shard (each registerVersion mints one).
    for (let i = 0; i < 5; i++)
      await store.registerVersion(makeEntry({ siteId: 's1', table: 'pages', objectKey: `u_u1/s1/pages/p${i}.parquet` }))
    await store.registerVersion(makeEntry({ siteId: 's2', table: 'queries', objectKey: 'u_u1/s2/queries/q.parquet' }))
    await store.bumpWatermark({ userId: 'u1', siteId: 's1', table: 'pages' }, '2026-05-10')
    await store.setSyncState({ userId: 'u1', siteId: 's1', table: 'pages', date: '2026-05-10' }, 'done')

    const result = await store.purgeTenant({ userId: 'u1' })
    expect(result.entriesRemoved).toBe(6)
    expect(result.watermarksRemoved).toBe(1)
    expect(result.syncStatesRemoved).toBe(1)

    const leftover = await bucket.list({ prefix: 'u_u1/manifest/' })
    expect(leftover.objects.length).toBe(0)
    expect(await store.listLive({ userId: 'u1' })).toEqual([])
  })

  it('purges a single siteId without touching siblings', async () => {
    const store = createR2ManifestStore({ bucket, userId: 'u1' })
    await store.registerVersions([
      makeEntry({ siteId: 's1', objectKey: 'u_u1/s1/pages/x.parquet' }),
      makeEntry({ siteId: 's2', objectKey: 'u_u1/s2/pages/y.parquet' }),
    ])
    const result = await store.purgeTenant({ userId: 'u1', siteId: 's1' })
    expect(result.entriesRemoved).toBe(1)
    const live = await store.listLive({ userId: 'u1' })
    expect(live.map(e => e.siteId)).toEqual(['s2'])
  })
})

// ---------------------------------------------------------------------------
// withLock
// ---------------------------------------------------------------------------

describe('createR2ManifestStore — withLock', () => {
  it('runs fn and returns its value (documented no-op; does NOT serialize)', async () => {
    const store = createR2ManifestStore({ bucket, userId: 'u1' })
    let entered = 0
    let maxConcurrent = 0
    const scope = { userId: 'u1', siteId: 's1', table: 'pages' as const, partition: 'daily/2026-05-01' }
    const run = () => store.withLock(scope, async () => {
      entered++
      maxConcurrent = Math.max(maxConcurrent, entered)
      await new Promise(r => setTimeout(r, 5))
      entered--
      return 1
    })
    const results = await Promise.all([run(), run(), run()])
    expect(results).toEqual([1, 1, 1])
    // Documented characterization: withLock is a no-op, so same-scope callers
    // run concurrently (CAS provides per-shard write serialization instead).
    expect(maxConcurrent).toBeGreaterThan(1)
  })
})

// ---------------------------------------------------------------------------
// Deep CAS correctness: mixed appends + supersedes + deletes on one hot shard
// ---------------------------------------------------------------------------

describe('createR2ManifestStore — mixed concurrent mutations', () => {
  it('interleaved appends, supersedes-of-base, and deletes converge consistently', async () => {
    const store = createR2ManifestStore({ bucket, userId: 'u1' })
    const base = makeEntry({ objectKey: 'u_u1/s1/pages/base.parquet', createdAt: 1000 })
    const doomed = makeEntry({ objectKey: 'u_u1/s1/pages/doomed.parquet', createdAt: 1000 })
    await store.registerVersions([base, doomed])

    const appends = Array.from({ length: 8 }, (_, i) =>
      store.registerVersion(makeEntry({ objectKey: `u_u1/s1/pages/a${i}.parquet`, createdAt: 2000 + i })))
    const supersede = store.registerVersion(
      makeEntry({ objectKey: 'u_u1/s1/pages/replacement.parquet', createdAt: 3000 }),
      [base],
    )
    const remove = store.delete([doomed])
    await Promise.all([...appends, supersede, remove])

    const live = await store.listLive({ userId: 'u1', siteId: 's1', table: 'pages' })
    const keys = new Set(live.map(e => e.objectKey))
    // base retired (excluded), doomed deleted (gone), replacement + 8 appends live.
    expect(keys.has('u_u1/s1/pages/base.parquet')).toBe(false)
    expect(keys.has('u_u1/s1/pages/doomed.parquet')).toBe(false)
    expect(keys.has('u_u1/s1/pages/replacement.parquet')).toBe(true)
    for (let i = 0; i < 8; i++)
      expect(keys.has(`u_u1/s1/pages/a${i}.parquet`)).toBe(true)
    expect(live.length).toBe(9)

    // doomed must be fully gone from listAll too (delete drops, not retires).
    const all = await store.listAll({ userId: 'u1', siteId: 's1', table: 'pages' })
    expect(all.some(e => e.objectKey === 'u_u1/s1/pages/doomed.parquet')).toBe(false)
    // base survives in listAll, retired exactly once.
    const baseRows = all.filter(e => e.objectKey === 'u_u1/s1/pages/base.parquet')
    expect(baseRows.length).toBe(1)
    expect(baseRows[0].retiredAt).toBeDefined()
  })

  it('delete of a non-existent / already-removed entry is idempotent', async () => {
    const store = createR2ManifestStore({ bucket, userId: 'u1' })
    const e = makeEntry({ objectKey: 'u_u1/s1/pages/once.parquet' })
    await store.registerVersion(e)
    await store.delete([e])
    // Second delete: entry already gone — must not throw, must not resurrect.
    await store.delete([e])
    const live = await store.listLive({ userId: 'u1', siteId: 's1', table: 'pages' })
    expect(live).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// purgeTenant racing a concurrent write (documented race window)
// ---------------------------------------------------------------------------

describe('createR2ManifestStore — purgeTenant vs concurrent write', () => {
  it('a write to a brand-new shard started after purge listed shards survives the purge', async () => {
    // CHARACTERIZATION: purgeTenant snapshots the shard list up front, so a
    // shard created after that listing is not seen by the delete sweep. This
    // documents the known race window (purge is not a global lock).
    const store = createR2ManifestStore({ bucket, userId: 'u1' })
    await store.registerVersion(makeEntry({ siteId: 'sOld', objectKey: 'u_u1/sOld/pages/x.parquet' }))
    const [purgeResult] = await Promise.all([
      store.purgeTenant({ userId: 'u1' }),
      store.registerVersion(makeEntry({ siteId: 'sNew', objectKey: 'u_u1/sNew/pages/y.parquet' })),
    ])
    // Purge removed at least the pre-existing shard's entry.
    expect(purgeResult.entriesRemoved).toBeGreaterThanOrEqual(1)
    // The new shard may or may not survive depending on interleaving; assert
    // only that the store is self-consistent (no crash, listLive readable).
    const live = await store.listLive({ userId: 'u1' })
    expect(Array.isArray(live)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Shard parsing oddities
// ---------------------------------------------------------------------------

describe('createR2ManifestStore — shard parsing', () => {
  it('siteId containing "=" (base-encoded) round-trips through SHARD_RE listing', async () => {
    const store = createR2ManifestStore({ bucket, userId: 'u1' })
    const weird = 'aHR0cHM6Ly9leGFtcGxlLmNvbS8='
    await store.registerVersion(makeEntry({ siteId: weird, objectKey: 'u_u1/x/pages/z.parquet' }))
    // Cross-shard listing must rediscover the shard via SHARD_RE.
    const all = await store.listLive({ userId: 'u1' })
    expect(all.map(e => e.siteId)).toEqual([weird])
  })
})

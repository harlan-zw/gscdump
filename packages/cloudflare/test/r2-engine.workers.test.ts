/**
 * R2 adapters against a REAL workerd-backed R2 bucket (miniflare), not the
 * hand-rolled in-memory fakes the node tests use. This is the only place the
 * DataSource byte/range/list semantics and the manifest CAS loop run against
 * R2's real conditional-put + etag behaviour — the fakes mint synthetic etags
 * and ignore byte ranges, so subtle divergences (e.g. the `etagDoesNotMatch:
 * '*'` create-if-absent precondition, or lost updates under real concurrency)
 * only surface here.
 *
 * Run with `pnpm --filter @gscdump/cloudflare test:workers`.
 */

import type { ManifestEntry } from '@gscdump/engine/contracts'
import { createR2DataSource } from '@gscdump/engine/r2'
import { createR2ManifestStore } from '@gscdump/engine/r2-manifest'

import { env } from 'cloudflare:test'
import { beforeEach, describe, expect, it } from 'vitest'

const bucket = env.TEST_BUCKET as any

async function clearBucket(): Promise<void> {
  const listed = await bucket.list()
  if (listed.objects.length > 0)
    await bucket.delete(listed.objects.map((o: { key: string }) => o.key))
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

describe('createR2DataSource against real R2', () => {
  it('reads back exactly what was written (read-after-write)', async () => {
    const ds = createR2DataSource({ bucket })
    const payload = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8])
    await ds.write('u_u1/data/a.parquet', payload)
    const got = await ds.read('u_u1/data/a.parquet')
    expect([...got]).toEqual([...payload])
  })

  it('honours range reads (offset + length) — the fake ignored this', async () => {
    const ds = createR2DataSource({ bucket })
    const payload = new Uint8Array([10, 11, 12, 13, 14, 15, 16, 17, 18, 19])
    await ds.write('u_u1/data/ranged.parquet', payload)
    const mid = await ds.read('u_u1/data/ranged.parquet', { offset: 3, length: 4 })
    expect([...mid]).toEqual([13, 14, 15, 16])
  })

  it('throws on a missing object', async () => {
    const ds = createR2DataSource({ bucket })
    await expect(ds.read('u_u1/data/missing.parquet')).rejects.toThrow(/not found/)
  })

  it('head returns the real byte size', async () => {
    const ds = createR2DataSource({ bucket })
    await ds.write('u_u1/data/sized.parquet', new Uint8Array(42))
    expect(await ds.head('u_u1/data/sized.parquet')).toEqual({ bytes: 42 })
    expect(await ds.head('u_u1/data/nope.parquet')).toBeUndefined()
  })

  it('lists + streams every key under a prefix across pagination', async () => {
    const ds = createR2DataSource({ bucket })
    const n = 25
    for (let i = 0; i < n; i++)
      await ds.write(`u_u1/list/${String(i).padStart(3, '0')}.parquet`, new Uint8Array([i]))
    await ds.write('u_u1/other/x.parquet', new Uint8Array([0]))

    const listed = await ds.list('u_u1/list/')
    expect(listed.length).toBe(n)
    expect(listed.every(k => k.startsWith('u_u1/list/'))).toBe(true)

    const streamed: string[] = []
    for await (const k of ds.streamList('u_u1/list/')) streamed.push(k)
    expect(streamed.sort()).toEqual(listed.sort())
  })

  it('deletes in batches', async () => {
    const ds = createR2DataSource({ bucket })
    await ds.write('u_u1/del/a', new Uint8Array([1]))
    await ds.write('u_u1/del/b', new Uint8Array([2]))
    await ds.delete(['u_u1/del/a', 'u_u1/del/b'])
    expect(await ds.list('u_u1/del/')).toEqual([])
  })
})

describe('createR2ManifestStore against real R2 (CAS)', () => {
  it('registers a version and lists it back', async () => {
    const store = createR2ManifestStore({ bucket, userId: 'u1' })
    const entry = makeEntry()
    await store.registerVersion(entry)
    const live = await store.listLive({ userId: 'u1', siteId: 's1', table: 'pages' })
    expect(live.map(e => e.objectKey)).toEqual([entry.objectKey])
  })

  it('first write uses create-if-absent (etagDoesNotMatch) correctly', async () => {
    // The CAS first-write path puts HEAD with `onlyIf.etagDoesNotMatch: '*'`.
    // If real R2 doesn't honour the `'*'` wildcard the way the fake does, this
    // is exactly where it shows up — two stores writing a brand-new shard.
    const a = createR2ManifestStore({ bucket, userId: 'u1' })
    const b = createR2ManifestStore({ bucket, userId: 'u1' })
    await Promise.all([
      a.registerVersion(makeEntry({ objectKey: 'u_u1/s1/pages/a.parquet' })),
      b.registerVersion(makeEntry({ objectKey: 'u_u1/s1/pages/b.parquet' })),
    ])
    const live = await a.listLive({ userId: 'u1', siteId: 's1', table: 'pages' })
    expect(live.map(e => e.objectKey).sort()).toEqual([
      'u_u1/s1/pages/a.parquet',
      'u_u1/s1/pages/b.parquet',
    ])
  })

  it('does not lose updates under real concurrent writers (etag CAS)', async () => {
    const store = createR2ManifestStore({ bucket, userId: 'u1' })
    const writers = 12
    await Promise.all(
      Array.from({ length: writers }, (_, i) =>
        store.registerVersion(makeEntry({ objectKey: `u_u1/s1/pages/c${i}.parquet` }))),
    )
    const live = await store.listLive({ userId: 'u1', siteId: 's1', table: 'pages' })
    // Every concurrent append must survive — the etag CAS retry loop converges.
    expect(live.length).toBe(writers)
    expect(new Set(live.map(e => e.objectKey)).size).toBe(writers)
  })

  it('accumulates immutable snapshot files under contention (orphan growth)', async () => {
    // Each successful CAS writes a new immutable v<id>.json BEFORE the HEAD put;
    // a rejected attempt orphans its snapshot. This quantifies the growth the
    // node fake could not observe (it minted synthetic etags). Documents the
    // current behaviour so a future GC fix has a baseline to assert against.
    const store = createR2ManifestStore({ bucket, userId: 'u1' })
    const writers = 8
    await Promise.all(
      Array.from({ length: writers }, (_, i) =>
        store.registerVersion(makeEntry({ objectKey: `u_u1/s1/pages/d${i}.parquet` }))),
    )
    const snapshots = await bucket.list({ prefix: 'u_u1/manifest/s1/pages/' })
    const versionFiles = snapshots.objects.filter((o: { key: string }) => /\/v[^/]+\.json$/.test(o.key))
    // At least one snapshot per successful commit; contention adds orphans.
    expect(versionFiles.length).toBeGreaterThanOrEqual(writers)
  })

  it('round-trips watermarks', async () => {
    const store = createR2ManifestStore({ bucket, userId: 'u1' })
    await store.bumpWatermark({ userId: 'u1', siteId: 's1', table: 'pages' }, '2026-05-10')
    const marks = await store.getWatermarks({ userId: 'u1', siteId: 's1', table: 'pages' })
    expect(marks.some(m => m.newestDateSynced === '2026-05-10')).toBe(true)
  })
})

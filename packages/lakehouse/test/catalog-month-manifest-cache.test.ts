/**
 * Month-keyed manifest cache (issue #43): `resolveIcebergDataFiles` groups
 * the manifests surviving partition pruning by the calendar month their
 * `month`-transform partition-summary bounds prove them confined to, and
 * caches each month's resolved (but not yet day-bounds-pruned) file list
 * under a key content-addressed by the sha-256 of that month's sorted
 * manifest-path set. A hit serves the month without fetching any manifest; a
 * miss (a new commit added a manifest, a compaction rewrote one, or the
 * manifest can't be proven single-month) walks only the manifests that
 * missed.
 *
 * These pin the correctness invariant from the issue: for any range, the
 * union of (cached month entries ∪ freshly-walked month entries),
 * day-bounds-pruned, must equal what a full uncached walk of the same
 * snapshot returns.
 */

import type { ManifestFixture } from './manifest-mock'
import { createStorage } from 'unstorage'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fakeManifestWalker } from './manifest-mock'

const restCatalogLoadTable = vi.fn()
const icebergManifests = vi.fn()

vi.mock('icebird/src/catalog/rest.js', () => ({ restCatalogConnect: vi.fn(), restCatalogCreateNamespace: vi.fn(), restCatalogListTables: vi.fn(), restCatalogLoadTable }))
vi.mock('icebird/src/manifest.js', () => ({ icebergManifests }))

const { invalidateSnapshotRef, resolveIcebergDataFiles } = await import('../src/catalog')

const SPEC = [
  { sourceColumn: 'site_id', transform: 'identity' as const, name: 'site_id' },
  { sourceColumn: 'date', transform: 'month' as const, name: 'date_month' },
]

function monthVal(ym: string): number {
  const [y, m] = ym.split('-').map(Number) as [number, number]
  return (y - 1970) * 12 + (m - 1)
}

function intBound(n: number): Uint8Array {
  const b = new Uint8Array(4)
  new DataView(b.buffer).setInt32(0, n, true)
  return b
}

/** `month`-transform field-summary bounds. `hi` defaults to `lo` (single-month, cacheable). */
function monthSummary(lo: number, hi = lo) {
  return { contains_null: false, lower_bound: intBound(lo), upper_bound: intBound(hi) }
}

/** Placeholder summary for the (unused-by-pruning) `site_id` identity field slot. */
const NO_SUMMARY = { contains_null: false, lower_bound: null, upper_bound: null }

let fileIdSeq = 0
function dataFile(siteId: number, ym: string, path = `s3://lh/gsc/queries/${fileIdSeq++}.parquet`) {
  return {
    status: 1,
    data_file: {
      content: 0,
      file_path: path,
      file_size_in_bytes: 1024,
      record_count: 10,
      partition: { site_id: siteId, date_month: monthVal(ym) },
    },
  }
}

function conn(): unknown {
  return { catalog: {}, resolver: {}, namespace: 'gsc' }
}

function opts(range: { start: string, end: string }, cache?: unknown) {
  return {
    namespace: 'gsc',
    table: 'queries',
    partitionSpec: SPEC,
    matches: [{ field: 'site_id', value: 1, encoding: 'int32' as const }],
    range,
    cache,
  }
}

function setSnapshot(snapshotId: string): void {
  restCatalogLoadTable.mockResolvedValue({ metadata: { 'current-snapshot-id': snapshotId } })
}

function setManifests(fixtures: ManifestFixture[]): void {
  icebergManifests.mockImplementation(fakeManifestWalker(fixtures))
}

const RANGE = { start: '2026-05-01', end: '2026-06-30' }
const FILE_A = 's3://lh/gsc/queries/a.parquet'
const FILE_B = 's3://lh/gsc/queries/b.parquet'
const FILE_C = 's3://lh/gsc/queries/c.parquet'

describe('resolveIcebergDataFiles month-keyed manifest cache', () => {
  beforeEach(() => {
    fileIdSeq = 0
    restCatalogLoadTable.mockReset()
    icebergManifests.mockReset()
  })

  it('a cold walk populates month keys and returns the same list as a full uncached walk', async () => {
    const fixtures: ManifestFixture[] = [
      { path: 'm1', partitions: [NO_SUMMARY, monthSummary(monthVal('2026-05'))], entries: [dataFile(1, '2026-05', FILE_A)] },
      { path: 'm2', partitions: [NO_SUMMARY, monthSummary(monthVal('2026-06'))], entries: [dataFile(1, '2026-06', FILE_B)] },
    ]

    setSnapshot('snap-1')
    setManifests(fixtures)
    const uncached = await resolveIcebergDataFiles(conn() as never, opts(RANGE))

    setSnapshot('snap-1')
    setManifests(fixtures)
    const cache = { storage: createStorage() }
    const cached = await resolveIcebergDataFiles(conn() as never, opts(RANGE, cache))

    expect(cached).toEqual(uncached)
    expect(cached.map(f => f.filePath).sort()).toEqual([FILE_A, FILE_B])
  })

  it('a second resolve on a new connection with the same cache and a different range inside the same months walks zero manifests', async () => {
    setSnapshot('snap-1')
    setManifests([
      { path: 'm1', partitions: [NO_SUMMARY, monthSummary(monthVal('2026-05'))], entries: [dataFile(1, '2026-05', FILE_A)] },
      { path: 'm2', partitions: [NO_SUMMARY, monthSummary(monthVal('2026-06'))], entries: [dataFile(1, '2026-06', FILE_B)] },
    ])
    const cache = { storage: createStorage() }

    await resolveIcebergDataFiles(conn() as never, opts(RANGE, cache))
    const callsAfterCold = icebergManifests.mock.calls.length
    expect(callsAfterCold).toBe(2) // list-only pass + walk pass

    // A NEW connection object (simulates a fresh isolate) — same cache, a
    // DIFFERENT exact range so the `lh-files2` exact-range cache misses, but
    // inside the same two months, so the month cache should serve both.
    const narrower = { start: '2026-05-15', end: '2026-06-10' }
    const out = await resolveIcebergDataFiles(conn() as never, opts(narrower, cache))

    // Only the list-only pass runs again (needed to hash this call's
    // surviving manifest set) — no walk pass, because both months hit.
    expect(icebergManifests.mock.calls.length).toBe(callsAfterCold + 1)
    expect(out.map(f => f.filePath).sort()).toEqual([FILE_A, FILE_B])
  })

  it('a month whose every manifest entry fails the matches filter is cached as empty and never re-walked', async () => {
    const cache = { storage: createStorage() }
    setSnapshot('snap-1')
    // site_id 2 fails the `matches` filter (site_id 1): the month's manifest
    // survives partition pruning but resolves to zero files.
    setManifests([
      { path: 'm1', partitions: [NO_SUMMARY, monthSummary(monthVal('2026-05'))], entries: [dataFile(2, '2026-05', FILE_A)] },
    ])

    const first = await resolveIcebergDataFiles(conn() as never, opts(RANGE, cache))
    expect(first).toEqual([])
    const callsAfterCold = icebergManifests.mock.calls.length
    expect(callsAfterCold).toBe(2) // list-only pass + walk pass

    // A different exact range inside the same month: the exact-range cache
    // misses, so only the month cache can serve the month.
    const narrower = { start: '2026-05-10', end: '2026-05-20' }
    const second = await resolveIcebergDataFiles(conn() as never, opts(narrower, cache))
    expect(second).toEqual([])
    // Only the list-only pass runs again — the empty month must be served
    // from the cache. Before the repair the walk pass ran again (+2).
    expect(icebergManifests.mock.calls.length).toBe(callsAfterCold + 1)
  })

  it('a new snapshot that adds one manifest to a month re-walks only that month, serving the untouched month from cache', async () => {
    const cache = { storage: createStorage() }
    setSnapshot('snap-1')
    setManifests([
      { path: 'm1', partitions: [NO_SUMMARY, monthSummary(monthVal('2026-05'))], entries: [dataFile(1, '2026-05', FILE_A)] },
      { path: 'm2a', partitions: [NO_SUMMARY, monthSummary(monthVal('2026-06'))], entries: [dataFile(1, '2026-06', FILE_B)] },
    ])
    await resolveIcebergDataFiles(conn() as never, opts(RANGE, cache))

    // New commit: June gains a second manifest. May's manifest path AND
    // partitions are unchanged (same hash -> cache hit), but its fixture
    // entries are "poisoned" — a re-walk would surface the poisoned path, so
    // the assertion below only holds if May is actually served from cache.
    // A real writer invalidates the snapshot ref post-commit; without it the
    // reader would keep serving the pre-commit `snap-1` pointer for the rest
    // of its 30-minute TTL.
    await invalidateSnapshotRef(cache, 'gsc', 'queries')
    setSnapshot('snap-2')
    setManifests([
      { path: 'm1', partitions: [NO_SUMMARY, monthSummary(monthVal('2026-05'))], entries: [dataFile(1, '2026-05', 'POISONED')] },
      { path: 'm2a', partitions: [NO_SUMMARY, monthSummary(monthVal('2026-06'))], entries: [dataFile(1, '2026-06', FILE_B)] },
      { path: 'm2b', partitions: [NO_SUMMARY, monthSummary(monthVal('2026-06'))], entries: [dataFile(1, '2026-06', FILE_C)] },
    ])
    const out = await resolveIcebergDataFiles(conn() as never, opts(RANGE, cache))

    expect(out.map(f => f.filePath).sort()).toEqual([FILE_A, FILE_B, FILE_C])
  })

  it('a compaction that rewrites a closed month\'s manifest changes that month\'s key and re-walks it, leaving other months cached', async () => {
    const cache = { storage: createStorage() }
    setSnapshot('snap-1')
    setManifests([
      { path: 'm1', partitions: [NO_SUMMARY, monthSummary(monthVal('2026-05'))], entries: [dataFile(1, '2026-05', FILE_A)] },
      { path: 'm2', partitions: [NO_SUMMARY, monthSummary(monthVal('2026-06'))], entries: [dataFile(1, '2026-06', FILE_B)] },
    ])
    await resolveIcebergDataFiles(conn() as never, opts(RANGE, cache))

    // Compaction rewrites May's manifest under a NEW path with the same
    // logical content. June's manifest keeps its old path but is "poisoned"
    // — a re-walk would surface the poisoned path, proving June came from
    // cache instead. Invalidate the snapshot ref, same as a real writer does
    // post-commit.
    await invalidateSnapshotRef(cache, 'gsc', 'queries')
    setSnapshot('snap-2')
    setManifests([
      { path: 'm1-compacted', partitions: [NO_SUMMARY, monthSummary(monthVal('2026-05'))], entries: [dataFile(1, '2026-05', FILE_A)] },
      { path: 'm2', partitions: [NO_SUMMARY, monthSummary(monthVal('2026-06'))], entries: [dataFile(1, '2026-06', 'POISONED')] },
    ])
    const out = await resolveIcebergDataFiles(conn() as never, opts(RANGE, cache))

    expect(out.map(f => f.filePath).sort()).toEqual([FILE_A, FILE_B])
  })

  it('a manifest spanning two months is always walked and never cached', async () => {
    const cache = { storage: createStorage() }
    setSnapshot('snap-1')
    const multi: ManifestFixture = {
      path: 'm-multi',
      partitions: [NO_SUMMARY, monthSummary(monthVal('2026-05'), monthVal('2026-06'))],
      entries: [dataFile(1, '2026-05', FILE_A), dataFile(1, '2026-06', FILE_B)],
    }
    setManifests([multi])

    const first = await resolveIcebergDataFiles(conn() as never, opts(RANGE, cache))
    expect(first.map(f => f.filePath).sort()).toEqual([FILE_A, FILE_B])
    const callsAfterFirst = icebergManifests.mock.calls.length
    expect(callsAfterFirst).toBe(2)

    // Same snapshot, a DIFFERENT exact range inside the same two months — an
    // exact-range cache miss, forcing the month-cache decision to run again.
    const narrower = { start: '2026-05-10', end: '2026-06-20' }
    const second = await resolveIcebergDataFiles(conn() as never, opts(narrower, cache))
    expect(second.map(f => f.filePath).sort()).toEqual([FILE_A, FILE_B])
    // Both calls (list-only + walk) happen again — a multi-month manifest is
    // never a month-cache hit.
    expect(icebergManifests.mock.calls.length).toBe(callsAfterFirst + 2)
  })

  it('a pruning-filter throw (malformed month-summary bound) walks the manifest in both results, matching an uncached walk', async () => {
    // A 2-byte month lower_bound makes `decodeMonthInt`'s getInt32 raise
    // RangeError, so `buildManifestPartitionFilter` throws for this manifest.
    // Icebird's own catch keeps it — pruning must not hide data — so the
    // resolver must walk it too, on every resolve.
    const fixtures: ManifestFixture[] = [
      {
        path: 'm-bad',
        partitions: [NO_SUMMARY, { contains_null: false, lower_bound: new Uint8Array(2), upper_bound: intBound(monthVal('2026-05')) }],
        entries: [dataFile(1, '2026-05', FILE_A)],
      },
    ]

    setSnapshot('snap-1')
    setManifests(fixtures)
    const uncached = await resolveIcebergDataFiles(conn() as never, opts(RANGE))
    expect(uncached.map(f => f.filePath).sort()).toEqual([FILE_A])

    setSnapshot('snap-1')
    setManifests(fixtures)
    const cache = { storage: createStorage() }
    const first = await resolveIcebergDataFiles(conn() as never, opts(RANGE, cache))

    // Same snapshot, a different exact range: the exact-range cache misses,
    // so the two-pass month-cache resolver runs again and must STILL walk
    // the throw-kept manifest instead of silently dropping its files.
    const narrower = { start: '2026-05-05', end: '2026-05-20' }
    const second = await resolveIcebergDataFiles(conn() as never, opts(narrower, cache))

    expect(first).toEqual(uncached)
    expect(second).toEqual(uncached)
    expect(first.map(f => f.filePath).sort()).toEqual([FILE_A])
    expect(second.map(f => f.filePath).sort()).toEqual([FILE_A])
  })

  it('a defer-less cache whose driver resolves setItem on a macrotask holds the month key once the resolve returns', async () => {
    setSnapshot('snap-1')
    setManifests([
      { path: 'm1', partitions: [NO_SUMMARY, monthSummary(monthVal('2026-05'))], entries: [dataFile(1, '2026-05', FILE_A)] },
    ])

    // No `defer` hook, so `cachePut` returns its write for the caller to
    // await (catalog-cache.ts contract). The driver defers the MONTH-key
    // `setItem` to a macrotask (the awaited exact-range put that follows
    // must not open an event-loop window the voided write could slip
    // through): if the month put is fired and forgotten, its write is still
    // pending when the resolve returns — exactly what cuts a defer-less
    // Worker's put off when the isolate suspends at response end.
    const storage = createStorage()
    const innerSetItem = storage.setItem.bind(storage) as (key: string, value: unknown, opts?: unknown) => Promise<void>
    storage.setItem = async (key: string, value: unknown, itemOpts?: unknown) => {
      if (key.startsWith('lh-month')) {
        await new Promise(resolve => setTimeout(resolve, 0))
      }
      return innerSetItem(key, value, itemOpts)
    }
    const cache = { storage }

    const out = await resolveIcebergDataFiles(conn() as never, opts(RANGE, cache))
    expect(out.map(f => f.filePath)).toEqual([FILE_A])

    // Back in the test only microtasks have drained; an un-awaited write
    // would still be pending on its timer. The month key must already be
    // in storage.
    const keys = await storage.getKeys()
    expect(keys.some(key => key.startsWith('lh-month'))).toBe(true)
  })

  it('month-cache writes for multiple missed months are issued concurrently, not one at a time (no defer hook)', async () => {
    setSnapshot('snap-1')
    setManifests([
      { path: 'm1', partitions: [NO_SUMMARY, monthSummary(monthVal('2026-05'))], entries: [dataFile(1, '2026-05', FILE_A)] },
      { path: 'm2', partitions: [NO_SUMMARY, monthSummary(monthVal('2026-06'))], entries: [dataFile(1, '2026-06', FILE_B)] },
    ])

    // A cold resolve misses BOTH May and June, so two `lh-month` writes are
    // due. Each write logs when it STARTS and when it (asynchronously)
    // finishes; if the code awaited each put in turn, the log would
    // alternate start/end/start/end. Collected up front via `Promise.all`,
    // both starts land before either end.
    const storage = createStorage()
    const innerSetItem = storage.setItem.bind(storage) as (key: string, value: unknown, opts?: unknown) => Promise<void>
    const events: string[] = []
    storage.setItem = async (key: string, value: unknown, itemOpts?: unknown) => {
      if (!key.startsWith('lh-month'))
        return innerSetItem(key, value, itemOpts)
      events.push(`start:${key}`)
      await new Promise(resolve => setTimeout(resolve, 0))
      events.push(`end:${key}`)
      return innerSetItem(key, value, itemOpts)
    }
    const cache = { storage }

    await resolveIcebergDataFiles(conn() as never, opts(RANGE, cache))

    expect(events).toHaveLength(4)
    const firstEndIndex = events.findIndex(e => e.startsWith('end:'))
    expect(firstEndIndex).toBe(2) // both starts precede either end
    expect(events.slice(0, 2).every(e => e.startsWith('start:'))).toBe(true)
  })

  it('a cache driver failure degrades to a full walk', async () => {
    setSnapshot('snap-1')
    setManifests([
      { path: 'm1', partitions: [NO_SUMMARY, monthSummary(monthVal('2026-05'))], entries: [dataFile(1, '2026-05', FILE_A)] },
      { path: 'm2', partitions: [NO_SUMMARY, monthSummary(monthVal('2026-06'))], entries: [dataFile(1, '2026-06', FILE_B)] },
    ])

    const errors: unknown[] = []
    const failingStorage = createStorage()
    failingStorage.getItem = async () => {
      throw new Error('driver down')
    }
    failingStorage.setItem = async () => {
      throw new Error('driver down')
    }
    const cache = { storage: failingStorage, onError: (_operation: string, _key: string, error: unknown) => errors.push(error) }

    const out = await resolveIcebergDataFiles(conn() as never, opts(RANGE, cache))

    expect(out.map(f => f.filePath).sort()).toEqual([FILE_A, FILE_B])
    expect(errors.length).toBeGreaterThan(0)
  })

  it('an inverted or unparseable range returns [] with zero cache gets and zero walks, even when the cache is warm for those months', async () => {
    const cache = { storage: createStorage() }
    setSnapshot('snap-1')
    setManifests([
      { path: 'm1', partitions: [NO_SUMMARY, monthSummary(monthVal('2026-05'))], entries: [dataFile(1, '2026-05', FILE_A)] },
      { path: 'm2', partitions: [NO_SUMMARY, monthSummary(monthVal('2026-06'))], entries: [dataFile(1, '2026-06', FILE_B)] },
    ])

    // Warm the month cache for both May and June first.
    await resolveIcebergDataFiles(conn() as never, opts(RANGE, cache))
    const manifestCallsAfterWarm = icebergManifests.mock.calls.length
    const loadTableCallsAfterWarm = restCatalogLoadTable.mock.calls.length
    expect(manifestCallsAfterWarm).toBeGreaterThan(0)

    const getItemSpy = vi.spyOn(cache.storage, 'getItem')

    // Inverted at month granularity: June before May, both of which are warm.
    const inverted = await resolveIcebergDataFiles(conn() as never, opts({ start: '2026-06-15', end: '2026-05-01' }, cache))
    expect(inverted).toEqual([])

    // Unparseable — neither endpoint is a date.
    const unparseable = await resolveIcebergDataFiles(conn() as never, opts({ start: 'not-a-date', end: 'also-not-a-date' }, cache))
    expect(unparseable).toEqual([])

    // Neither call touched the cache, the snapshot pointer, or the manifest
    // walk — a warm cache for May/June must never leak into a query that
    // asked for zero months.
    expect(getItemSpy).not.toHaveBeenCalled()
    expect(restCatalogLoadTable.mock.calls.length).toBe(loadTableCallsAfterWarm)
    expect(icebergManifests.mock.calls.length).toBe(manifestCallsAfterWarm)
  })
})

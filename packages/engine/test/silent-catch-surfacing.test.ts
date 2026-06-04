// Behavioral guard: a *real* read/list/get failure must SURFACE, not be
// silently swallowed by a `.catch(() => undefined|null|[])`, while a
// legitimately-absent object stays a no-op (first-run path unchanged).
//
// Each `it` here is the failing-test-first half of the P5 silent-catch fix:
// it drives a backend that throws a NON-missing error (a corrupt object / a
// network blip) and asserts the engine rethrows instead of degrading to an
// empty/no-op result.

import type { DataSource } from '../src/storage'
import { describe, expect, it } from 'vitest'
import { encodeRowsToParquetFlex } from '../src/adapters/hyparquet'
import { isMissingKeyError, readOptional } from '../src/adapters/read-optional'
import {
  createEmptyTypesStore,
  createIndexingMetadataStore,
  createInspectionStore,
  createSitemapStore,
  emptyTypesKey,
  indexingMetadataIndexKey,
  inspectionHistoryShardKey,
  sitemapIndexKey,
  sitemapUrlsDeltaKey,
  sitemapUrlsIndexKey,
} from '../src/entities'
import { readLatestRollup } from '../src/rollups'

const READ_FAILURE = 'simulated read failure (network blip / corrupt object)'

/**
 * In-memory DataSource whose `read` can be made to throw a real (non-missing)
 * failure for specific keys, while a key that was never written throws the
 * standard not-found marker (a genuine absence).
 */
function makeDataSource(opts?: { failReadFor?: (key: string) => boolean }): {
  ds: DataSource
  store: Map<string, Uint8Array>
} {
  const store = new Map<string, Uint8Array>()
  const ds: DataSource = {
    async read(key) {
      if (opts?.failReadFor?.(key))
        throw new Error(READ_FAILURE)
      const b = store.get(key)
      if (!b)
        throw new Error(`not found: ${key}`)
      return b
    },
    async write(key, bytes) {
      store.set(key, bytes)
    },
    async delete(keys) {
      for (const k of keys) store.delete(k)
    },
    async list(prefix) {
      return Array.from(store.keys()).filter(k => k.startsWith(prefix))
    },
  }
  return { ds, store }
}

const json = (value: unknown): Uint8Array => new TextEncoder().encode(JSON.stringify(value))

describe('isMissingKeyError', () => {
  it('recognises the not-found markers the shipped backends raise', () => {
    expect(isMissingKeyError(new Error('not found: foo'))).toBe(true)
    expect(isMissingKeyError(new Error('key not found: foo'))).toBe(true)
    expect(isMissingKeyError(new Error('R2 object not found: foo'))).toBe(true)
    expect(isMissingKeyError(new Error('missing key foo'))).toBe(true)
    expect(isMissingKeyError(Object.assign(new Error('x'), { code: 'ENOENT' }))).toBe(true)
    expect(isMissingKeyError(Object.assign(new Error('x'), { name: 'NotFoundError' }))).toBe(true)
  })

  it('does NOT treat a real failure as a missing key', () => {
    expect(isMissingKeyError(new Error(READ_FAILURE))).toBe(false)
    expect(isMissingKeyError(new Error('permission denied'))).toBe(false)
    expect(isMissingKeyError(new Error('failed to decode shard'))).toBe(false)
    expect(isMissingKeyError(null)).toBe(false)
  })
})

describe('readOptional', () => {
  it('returns undefined for a genuinely-absent key', async () => {
    const { ds } = makeDataSource()
    await expect(readOptional(ds, 'never-written')).resolves.toBeUndefined()
  })

  it('surfaces a real read failure instead of swallowing it', async () => {
    const { ds, store } = makeDataSource({ failReadFor: k => k === 'boom' })
    store.set('boom', json({ ok: true }))
    await expect(readOptional(ds, 'boom')).rejects.toThrow(READ_FAILURE)
  })
})

describe('inspection loadHistory: per-shard read', () => {
  const ctx = { userId: 'u1', siteId: 's1' }

  it('surfaces a real shard read failure rather than skipping the shard', async () => {
    const { ds, store } = makeDataSource({
      failReadFor: k => k.endsWith('shard-bad.json'),
    })
    // Two shards listed; one reads fine, the other throws a real failure.
    store.set(inspectionHistoryShardKey(ctx, '2026-04', 'shard-ok'), json({
      version: 1,
      records: [{ url: 'https://x/a', inspectedAt: '2026-04-01T00:00:00Z' }],
    }))
    store.set(inspectionHistoryShardKey(ctx, '2026-04', 'shard-bad'), json({ version: 1, records: [] }))
    const inspector = createInspectionStore({ dataSource: ds })
    await expect(inspector.loadHistory(ctx, '2026-04')).rejects.toThrow(READ_FAILURE)
  })
})

describe('sitemap readJson helper (writeSnapshot / loadIndex / getLatest)', () => {
  const ctx = { userId: 'u1', siteId: 's1' }

  it('surfaces a real index read failure on writeSnapshot rather than overwriting from scratch', async () => {
    const { ds } = makeDataSource({ failReadFor: k => k === sitemapIndexKey(ctx) })
    const store = createSitemapStore({ dataSource: ds, hash: p => p })
    await expect(store.writeSnapshot(ctx, [{ path: '/sitemap.xml', capturedAt: '2026-04-01T00:00:00Z' }]))
      .rejects
      .toThrow(READ_FAILURE)
  })

  it('surfaces a real index read failure on loadIndex rather than returning empty', async () => {
    const { ds } = makeDataSource({ failReadFor: k => k === sitemapIndexKey(ctx) })
    const store = createSitemapStore({ dataSource: ds, hash: p => p })
    await expect(store.loadIndex(ctx)).rejects.toThrow(READ_FAILURE)
  })

  it('still returns the empty default when the index is genuinely absent', async () => {
    const { ds } = makeDataSource()
    const store = createSitemapStore({ dataSource: ds, hash: p => p })
    await expect(store.loadIndex(ctx)).resolves.toEqual({ version: 1, records: {} })
  })
})

describe('sitemap loadUrls / loadDeltas: per-delta + index reads', () => {
  const ctx = { userId: 'u1', siteId: 's1' }
  const FEED = '/sitemap.xml'
  // The delta filename embeds the feedpath hash and the regex requires it to be
  // hex (`[0-9a-f]+`), so the test hash must produce a hex digest.
  const FP = 'deadbeef'
  const hash = () => FP

  function deltaBytes(): Uint8Array {
    return encodeRowsToParquetFlex(
      [{ feedpath: FEED, feedpath_hash: FP, url_hash: 'abc1', op: 'added', loc: 'https://x/a', lastmod: null, at: 1 }],
      {
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
      },
    )
  }

  it('surfaces a real index read failure in loadUrls', async () => {
    const indexKey = sitemapUrlsIndexKey(ctx, FP)
    const { ds, store } = makeDataSource({ failReadFor: k => k === indexKey })
    store.set(indexKey, json({ corrupt: true }))
    const sitemap = createSitemapStore({ dataSource: ds, hash })
    const iterate = async () => {
      for await (const _ of sitemap.loadUrls(ctx, FEED)) { /* drain */ }
    }
    await expect(iterate()).rejects.toThrow(READ_FAILURE)
  })

  it('surfaces a real delta read failure in loadUrls', async () => {
    const deltaKey = sitemapUrlsDeltaKey(ctx, FP, '2026-04-01')
    const { ds, store } = makeDataSource({ failReadFor: k => k === deltaKey })
    store.set(deltaKey, deltaBytes())
    const sitemap = createSitemapStore({ dataSource: ds, hash })
    const iterate = async () => {
      for await (const _ of sitemap.loadUrls(ctx, FEED)) { /* drain */ }
    }
    await expect(iterate()).rejects.toThrow(READ_FAILURE)
  })

  it('surfaces a real delta read failure in loadDeltas', async () => {
    const deltaKey = sitemapUrlsDeltaKey(ctx, FP, '2026-04-01')
    const { ds, store } = makeDataSource({ failReadFor: k => k === deltaKey })
    store.set(deltaKey, deltaBytes())
    const sitemap = createSitemapStore({ dataSource: ds, hash })
    const iterate = async () => {
      for await (const _ of sitemap.loadDeltas(ctx)) { /* drain */ }
    }
    await expect(iterate()).rejects.toThrow(READ_FAILURE)
  })
})

describe('sitemap compactUrls: index + delta reads (highest-risk)', () => {
  const ctx = { userId: 'u1', siteId: 's1' }
  const FEED = '/sitemap.xml'
  const FP = 'deadbeef'
  const hash = () => FP

  function deltaBytes(url: string): Uint8Array {
    return encodeRowsToParquetFlex(
      [{ feedpath: FEED, feedpath_hash: FP, url_hash: url, op: 'added', loc: `https://x/${url}`, lastmod: null, at: 1 }],
      {
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
      },
    )
  }

  it('surfaces a real prior-index read failure rather than rebuilding from deltas alone', async () => {
    const indexKey = sitemapUrlsIndexKey(ctx, FP)
    const deltaKey = sitemapUrlsDeltaKey(ctx, FP, '2026-04-01')
    const { ds, store } = makeDataSource({ failReadFor: k => k === indexKey })
    // A real index exists but its read fails. Swallowing here would drop the
    // index's state and rewrite it from the single delta — exactly the bug.
    store.set(indexKey, json({ corrupt: true }))
    store.set(deltaKey, deltaBytes('abc1'))
    const before = new Map(store)
    const sitemap = createSitemapStore({ dataSource: ds, hash })
    await expect(sitemap.compactUrls(ctx)).rejects.toThrow(READ_FAILURE)
    // The index must NOT have been rewritten and the delta must NOT be consumed.
    expect(store.get(indexKey)).toBe(before.get(indexKey))
    expect(store.has(deltaKey)).toBe(true)
  })

  it('surfaces a real delta read failure in compactUrls', async () => {
    const deltaKey = sitemapUrlsDeltaKey(ctx, FP, '2026-04-01')
    const { ds, store } = makeDataSource({ failReadFor: k => k === deltaKey })
    store.set(deltaKey, deltaBytes('abc1'))
    const sitemap = createSitemapStore({ dataSource: ds, hash })
    await expect(sitemap.compactUrls(ctx)).rejects.toThrow(READ_FAILURE)
    // Delta not consumed.
    expect(store.has(deltaKey)).toBe(true)
  })
})

describe('indexing-metadata readIndex', () => {
  const ctx = { userId: 'u1', siteId: 's1' }

  it('surfaces a real index read failure on loadIndex rather than returning empty', async () => {
    const { ds } = makeDataSource({ failReadFor: k => k === indexingMetadataIndexKey(ctx) })
    const store = createIndexingMetadataStore({ dataSource: ds, hash: u => u })
    await expect(store.loadIndex(ctx)).rejects.toThrow(READ_FAILURE)
  })

  it('still returns the empty default when the index is genuinely absent', async () => {
    const { ds } = makeDataSource()
    const store = createIndexingMetadataStore({ dataSource: ds, hash: u => u })
    await expect(store.loadIndex(ctx)).resolves.toEqual({ version: 1, records: {} })
  })

  it('surfaces a real read failure on writeBatch rather than clobbering the index', async () => {
    const { ds } = makeDataSource({ failReadFor: k => k === indexingMetadataIndexKey(ctx) })
    const store = createIndexingMetadataStore({ dataSource: ds, hash: u => u })
    await expect(store.writeBatch(ctx, [{ url: 'https://x/a', capturedAt: '2026-04-01T00:00:00Z' }]))
      .rejects
      .toThrow(READ_FAILURE)
  })
})

describe('empty-types readDoc', () => {
  const ctx = { userId: 'u1', siteId: 's1' }

  it('surfaces a real read failure on load rather than returning empty', async () => {
    const { ds } = makeDataSource({ failReadFor: k => k === emptyTypesKey(ctx) })
    const store = createEmptyTypesStore({ dataSource: ds })
    await expect(store.load(ctx)).rejects.toThrow(READ_FAILURE)
  })

  it('still returns the empty default when the doc is genuinely absent', async () => {
    const { ds } = makeDataSource()
    const store = createEmptyTypesStore({ dataSource: ds })
    await expect(store.load(ctx)).resolves.toEqual({ version: 1, emptyTypes: [], markedAt: {} })
  })
})

describe('readLatestRollup: list + get failures', () => {
  const ctx = { userId: 'u1', siteId: 's1' }

  it('surfaces a LIST failure instead of reporting "no rollup"', async () => {
    const bucket = {
      list: () => Promise.reject(new Error(READ_FAILURE)),
      get: () => Promise.resolve(null),
    }
    await expect(readLatestRollup(bucket, ctx, 'daily_totals')).rejects.toThrow(READ_FAILURE)
  })

  it('surfaces a GET failure instead of reporting "no rollup"', async () => {
    const key = 'u_u1/s1/rollups/daily_totals__v1.json'
    const bucket = {
      list: () => Promise.resolve({ objects: [{ key }], truncated: false }),
      get: () => Promise.reject(new Error(READ_FAILURE)),
    }
    await expect(readLatestRollup(bucket, ctx, 'daily_totals')).rejects.toThrow(READ_FAILURE)
  })

  it('still returns null when the rollup is genuinely absent (empty listing)', async () => {
    const bucket = {
      list: () => Promise.resolve({ objects: [], truncated: false }),
      get: () => Promise.resolve(null),
    }
    await expect(readLatestRollup(bucket, ctx, 'daily_totals')).resolves.toBeNull()
  })
})

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
import { isMissingKeyError, readOptional } from '../src/adapters/read-optional'
import {
  createEmptyTypesStore,
  createIndexingMetadataStore,
  createInspectionStore,
  emptyTypesKey,
  indexingMetadataIndexKey,
  inspectionHistoryShardKey,
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

  it('does not issue a redundant HEAD before reading an existing object', async () => {
    let heads = 0
    let reads = 0
    const ds: DataSource = {
      async head() {
        heads++
        return { bytes: 1 }
      },
      async read() {
        reads++
        return new Uint8Array([1])
      },
      async write() {},
      async delete() {},
      async list() { return [] },
    }
    await expect(readOptional(ds, 'present')).resolves.toEqual(new Uint8Array([1]))
    expect(reads).toBe(1)
    expect(heads).toBe(0)
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

import type { DataSource } from '../src/storage'
import { describe, expect, it } from 'vitest'
import {
  buildQueryDimRecords,
  createQueryDimStore,
  queryDimMetaKey,
  queryDimParquetKey,
} from '../src/query-dim'

function makeFakeDataSource(): { ds: DataSource, store: Map<string, Uint8Array> } {
  const store = new Map<string, Uint8Array>()
  const ds: DataSource = {
    async read(key) {
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
      return [...store.keys()].filter(k => k.startsWith(prefix))
    },
  }
  return { ds, store }
}

// Stub derivation (engine never imports @gscdump/analysis): sort tokens for the
// canonical, code 3 for "buy" queries else 0.
const deps = {
  normalizeQuery: (q: string) => q.toLowerCase().split(/\s+/).filter(Boolean).sort().join(' '),
  normalizerVersion: 2,
  classifyIntentCode: (q: string) => (/\bbuy\b/.test(q.toLowerCase()) ? 3 : 0),
  intentVersion: 1,
}

describe('buildQueryDimRecords', () => {
  it('dedupes, stamps versions, classifies, and folds empty canonical to raw query', () => {
    const recs = buildQueryDimRecords(['Nuxt SEO', 'nuxt seo', 'buy domain', '   ', ''], {
      ...deps,
      // force an empty canonical for one input to exercise the fold
      normalizeQuery: q => (q.trim() === 'buy domain' ? '' : deps.normalizeQuery(q)),
    })
    // 'Nuxt SEO' and 'nuxt seo' are distinct raw queries (dedupe is on raw).
    expect(recs.map(r => r.query)).toEqual(['Nuxt SEO', 'nuxt seo', 'buy domain'])
    expect(recs.every(r => r.normalizer_version === 2 && r.intent_version === 1)).toBe(true)
    // empty canonical folded back to the raw query
    expect(recs.find(r => r.query === 'buy domain')!.query_canonical).toBe('buy domain')
    expect(recs.find(r => r.query === 'buy domain')!.intent_code).toBe(3)
    expect(recs.find(r => r.query === 'Nuxt SEO')!.query_canonical).toBe('nuxt seo')
  })
})

describe('createQueryDimStore', () => {
  const ctx = { userId: 'u1', siteId: 's1' }

  it('loadMeta is null before first build', async () => {
    const { ds } = makeFakeDataSource()
    const store = createQueryDimStore({ dataSource: ds })
    expect(await store.loadMeta(ctx)).toBeNull()
    expect(await store.loadRecords(ctx)).toEqual([])
  })

  it('writes parquet + sidecar and round-trips records', async () => {
    const { ds, store: blobs } = makeFakeDataSource()
    const store = createQueryDimStore({ dataSource: ds })
    const recs = buildQueryDimRecords(['nuxt seo', 'buy domain', 'how to validate'], deps)

    const res = await store.write(ctx, recs, 1_700_000_000_000)
    expect(res.parquetKey).toBe(queryDimParquetKey(ctx))
    expect(res.rowCount).toBe(3)
    expect(blobs.has(queryDimParquetKey(ctx))).toBe(true)
    expect(blobs.has(queryDimMetaKey(ctx))).toBe(true)

    const meta = await store.loadMeta(ctx)
    expect(meta).toMatchObject({ version: 1, rowCount: 3, normalizerVersion: 2, intentVersion: 1 })

    const back = await store.loadRecords(ctx)
    expect(back.map(r => r.query).sort()).toEqual(['buy domain', 'how to validate', 'nuxt seo'])
    const buy = back.find(r => r.query === 'buy domain')!
    expect(buy).toMatchObject({ query_canonical: 'buy domain', intent_code: 3, normalizer_version: 2 })
  })
})

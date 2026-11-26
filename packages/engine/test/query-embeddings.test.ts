import type { DataSource } from '../src/storage'
import { describe, expect, it } from 'vitest'
import {
  buildQueryEmbeddingRecords,
  createQueryEmbeddingsStore,
  dequantizeEmbeddingInt8,
  quantizeEmbeddingInt8,
  queryEmbeddingsMetaKey,
  queryEmbeddingsParquetKey,
} from '../src/entities'

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

function dot(a: readonly number[] | Float32Array, b: readonly number[] | Float32Array): number {
  let s = 0
  for (let i = 0; i < a.length; i++)
    s += a[i]! * b[i]!
  return s
}

function l2(v: readonly number[]): Float32Array {
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0))
  return Float32Array.from(v.map(x => x / norm))
}

describe('int8 embedding quantization', () => {
  it('preserves cosine similarity >= 0.999 on high-dimensional vectors', () => {
    const rawA = Array.from({ length: 768 }, (_, i) => Math.sin(i * 0.13) + Math.cos(i * 0.07))
    const rawB = Array.from({ length: 768 }, (_, i) => Math.sin(i * 0.13 + 0.2) + Math.cos(i * 0.07))
    const exactCos = dot(l2(rawA), l2(rawB))

    const qA = quantizeEmbeddingInt8(rawA)
    const qB = quantizeEmbeddingInt8(rawB)
    const dA = dequantizeEmbeddingInt8(qA.b64, qA.scale, qA.dims)
    const dB = dequantizeEmbeddingInt8(qB.b64, qB.scale, qB.dims)

    expect(dot(l2(rawA), dA)).toBeGreaterThan(0.999)
    expect(Math.abs(dot(dA, dB) - exactCos)).toBeLessThan(0.002)
  })

  it('handles zero vectors safely without NaN', () => {
    const q = quantizeEmbeddingInt8([0, 0, 0, 0])
    expect(q.scale).toBe(0)
    const back = dequantizeEmbeddingInt8(q.b64, q.scale, q.dims)
    expect([...back]).toEqual([0, 0, 0, 0])
  })
})

describe('createQueryEmbeddingsStore', () => {
  const ctx = { userId: 'u1', siteId: 's1' }

  it('returns null meta and empty records before first build', async () => {
    const { ds } = makeFakeDataSource()
    const store = createQueryEmbeddingsStore({ dataSource: ds })
    expect(await store.loadMeta(ctx)).toBeNull()
    expect(await store.loadRecords(ctx)).toEqual([])
  })

  it('writes Parquet + sidecar and incrementally merges compatible updates', async () => {
    const { ds, store: blobs } = makeFakeDataSource()
    const store = createQueryEmbeddingsStore({ dataSource: ds })

    const batch1 = buildQueryEmbeddingRecords([
      { queryCanonical: 'nyfw', vector: [1, 0, 0, 0] },
      { queryCanonical: 'fashion new week york', vector: [0.98, 0.2, 0, 0] },
    ], { model: '@cf/baai/bge-m3', normalizerVersion: 3 })

    const w1 = await store.write(ctx, batch1, 1_700_000_000_000)
    expect(w1.parquetKey).toBe(queryEmbeddingsParquetKey(ctx))
    expect(w1.rowCount).toBe(2)
    expect(blobs.has(queryEmbeddingsParquetKey(ctx))).toBe(true)
    expect(blobs.has(queryEmbeddingsMetaKey(ctx))).toBe(true)

    const meta1 = await store.loadMeta(ctx)
    expect(meta1).toMatchObject({
      version: 1,
      rowCount: 2,
      model: '@cf/baai/bge-m3',
      dims: 4,
      normalizerVersion: 3,
      quantization: 'int8-symmetric',
    })

    // Incremental merge with same model/dims preserves existing canonicals.
    const batch2 = buildQueryEmbeddingRecords([
      { queryCanonical: 'hotel new york', vector: [0, 1, 0, 0] },
    ], { model: '@cf/baai/bge-m3', normalizerVersion: 3 })
    const m1 = await store.mergeWrite(ctx, batch2, 1_700_000_001_000)
    expect(m1.replaced).toBe(false)
    expect(m1.rowCount).toBe(3)
    expect((await store.loadRecords(ctx)).map(r => r.query_canonical)).toEqual([
      'fashion new week york',
      'hotel new york',
      'nyfw',
    ])

    // Incompatible model replaces instead of mixing vector spaces.
    const batch3 = buildQueryEmbeddingRecords([
      { queryCanonical: 'nyfw', vector: [0, 0, 1, 0] },
    ], { model: 'embeddinggemma:300m', normalizerVersion: 3 })
    const m2 = await store.mergeWrite(ctx, batch3, 1_700_000_002_000)
    expect(m2.replaced).toBe(true)
    expect(m2.rowCount).toBe(1)
    expect((await store.loadMeta(ctx))?.model).toBe('embeddinggemma:300m')
  })
})

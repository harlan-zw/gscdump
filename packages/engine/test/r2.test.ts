/**
 * gscdump/analytics/r2 — DataSource tests against an in-memory R2Bucket stub.
 * Exercises read/write/delete/list/streamList/head plus the uri() and key
 * safety guards.
 */

import { describe, expect, it } from 'vitest'
import { createR2DataSource } from '../src/adapters/r2'

function fakeBucket(initial: Record<string, Uint8Array> = {}) {
  const store = new Map<string, Uint8Array>(Object.entries(initial))
  return {
    store,
    async get(key: string) {
      const v = store.get(key)
      if (!v)
        return null
      return { arrayBuffer: async () => v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength) }
    },
    async put(key: string, bytes: Uint8Array) {
      store.set(key, bytes)
    },
    async delete(keys: string | string[]) {
      const list = Array.isArray(keys) ? keys : [keys]
      for (const k of list) store.delete(k)
    },
    async list({ prefix, cursor, limit = 1000 }: { prefix?: string, cursor?: string, limit?: number } = {}) {
      const all = [...store.keys()].filter(k => !prefix || k.startsWith(prefix)).sort()
      const start = cursor ? all.indexOf(cursor) + 1 : 0
      const page = all.slice(start, start + limit)
      const nextStart = start + page.length
      const truncated = nextStart < all.length
      return {
        objects: page.map(key => ({ key })),
        truncated,
        cursor: truncated ? page[page.length - 1] : undefined,
      }
    },
    async head(key: string) {
      const v = store.get(key)
      if (!v)
        return null
      return { size: v.byteLength }
    },
  }
}

describe('createR2DataSource', () => {
  it('writes + reads bytes', async () => {
    const bucket = fakeBucket()
    const ds = createR2DataSource({ bucket })
    await ds.write('k', new Uint8Array([1, 2, 3]))
    const out = await ds.read('k')
    expect([...out]).toEqual([1, 2, 3])
  })

  it('read throws for missing keys', async () => {
    const ds = createR2DataSource({ bucket: fakeBucket() })
    await expect(ds.read('missing')).rejects.toThrow(/not found/)
  })

  it('list paginates across cursors', async () => {
    const bucket = fakeBucket()
    for (let i = 0; i < 2500; i++)
      bucket.store.set(`p/${String(i).padStart(5, '0')}`, new Uint8Array([0]))

    const ds = createR2DataSource({ bucket })
    const all = await ds.list('p/')
    expect(all).toHaveLength(2500)
    expect(all[0]).toBe('p/00000')
    expect(all[all.length - 1]).toBe('p/02499')
  })

  it('streamList yields keys lazily', async () => {
    const bucket = fakeBucket({ a: new Uint8Array(), b: new Uint8Array(), c: new Uint8Array() })
    const ds = createR2DataSource({ bucket })
    const out: string[] = []
    for await (const k of ds.streamList!(''))
      out.push(k)
    expect(out.sort()).toEqual(['a', 'b', 'c'])
  })

  it('delete chunks at 1000', async () => {
    const bucket = fakeBucket()
    for (let i = 0; i < 1500; i++)
      bucket.store.set(`k${i}`, new Uint8Array())
    const ds = createR2DataSource({ bucket })
    await ds.delete([...bucket.store.keys()])
    expect(bucket.store.size).toBe(0)
  })

  it('head returns byte size', async () => {
    const bucket = fakeBucket({ a: new Uint8Array(42) })
    const ds = createR2DataSource({ bucket })
    expect(await ds.head!('a')).toEqual({ bytes: 42 })
    expect(await ds.head!('missing')).toBeUndefined()
  })

  it('uri() emits r2:// when bucketName set', () => {
    const ds = createR2DataSource({ bucket: fakeBucket(), bucketName: 'my-bucket' })
    expect(ds.uri!('u_1/pages/daily__v1.parquet')).toBe('r2://my-bucket/u_1/pages/daily__v1.parquet')
  })

  it('uri is undefined when bucketName omitted', () => {
    const ds = createR2DataSource({ bucket: fakeBucket() })
    expect(ds.uri).toBeUndefined()
  })

  it('rejects unsafe bucket names', () => {
    expect(() => createR2DataSource({ bucket: fakeBucket(), bucketName: 'Bad Name!' })).toThrow(/invalid R2 bucket/)
    expect(() => createR2DataSource({ bucket: fakeBucket(), bucketName: 'ab' })).toThrow(/invalid R2 bucket/)
  })

  it('rejects unsafe keys in uri()', () => {
    const ds = createR2DataSource({ bucket: fakeBucket(), bucketName: 'my-bucket' })
    expect(() => ds.uri!('key with space')).toThrow(/refusing unsafe key/)
    expect(() => ds.uri!('quote\'injection')).toThrow(/refusing unsafe key/)
  })

  it('delete with empty list is a no-op', async () => {
    const bucket = fakeBucket({ a: new Uint8Array() })
    const ds = createR2DataSource({ bucket })
    await ds.delete([])
    expect(bucket.store.has('a')).toBe(true)
  })
})

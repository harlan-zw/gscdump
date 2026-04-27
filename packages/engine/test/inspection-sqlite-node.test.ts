import type { DataSource } from '../src/storage'
import { describe, expect, it } from 'vitest'
import { createBetterSqliteDriver } from '../src/adapters/inspection-sqlite-node'
import { createInspectionStoreSqlite, inspectionSqliteKey } from '../src/entities'

function makeMemDataSource(): { ds: DataSource, store: Map<string, Uint8Array> } {
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
      return Array.from(store.keys()).filter(k => k.startsWith(prefix))
    },
  }
  return { ds, store }
}

describe('createBetterSqliteDriver', () => {
  it('round-trips a write batch through loadIndex', async () => {
    const { ds } = makeMemDataSource()
    const store = createInspectionStoreSqlite({
      dataSource: ds,
      openDriver: bytes => createBetterSqliteDriver(bytes),
    })

    const ctx = { userId: 'u1', siteId: 's1' }
    await store.writeBatch(ctx, [
      {
        url: 'https://example.com/a',
        inspectedAt: '2026-04-22T10:00:00Z',
        indexStatus: 'PASS',
        coverageState: 'Submitted and indexed',
        raw: { referringUrls: ['https://ref.example/'] },
      },
    ])

    const index = await store.loadIndex(ctx)
    const records = Object.values(index.records)
    expect(records).toHaveLength(1)
    expect(records[0]!.url).toBe('https://example.com/a')
    expect(records[0]!.indexStatus).toBe('PASS')
    expect(records[0]!.raw).toEqual({ referringUrls: ['https://ref.example/'] })

    const latest = await store.getLatest(ctx, 'https://example.com/a')
    expect(latest?.indexStatus).toBe('PASS')
  })

  it('serialized bytes re-open into a fresh store with the same contents', async () => {
    const { ds, store: kv } = makeMemDataSource()
    const ctx = { userId: 'u1', siteId: 's1' }

    const first = createInspectionStoreSqlite({
      dataSource: ds,
      openDriver: bytes => createBetterSqliteDriver(bytes),
    })
    await first.writeBatch(ctx, [
      { url: 'https://example.com/a', inspectedAt: '2026-04-22T10:00:00Z', indexStatus: 'PASS' },
      { url: 'https://example.com/b', inspectedAt: '2026-04-22T10:05:00Z', indexStatus: 'FAIL' },
    ])

    // Confirm the DB blob is actually what we're reopening from.
    expect(kv.has(inspectionSqliteKey(ctx))).toBe(true)

    const second = createInspectionStoreSqlite({
      dataSource: ds,
      openDriver: bytes => createBetterSqliteDriver(bytes),
    })
    const index = await second.loadIndex(ctx)
    expect(Object.keys(index.records)).toHaveLength(2)

    const a = await second.getLatest(ctx, 'https://example.com/a')
    expect(a?.indexStatus).toBe('PASS')
    const b = await second.getLatest(ctx, 'https://example.com/b')
    expect(b?.indexStatus).toBe('FAIL')

    const history = await second.loadHistory(ctx, '2026-04')
    expect(history?.records).toHaveLength(2)
  })
})

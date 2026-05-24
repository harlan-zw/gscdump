/**
 * @gscdump/engine-sqlite — D1 manifest store coverage.
 *
 * Exercises the real `createD1ManifestStore` against an in-memory SQLite
 * database (`node:sqlite`) wrapped in a minimal D1 client shim, so the
 * store's drizzle `db.batch()` / `onConflictDoUpdate` paths run end to end.
 *
 * Focus: the single-live-per-partition guarantee from SPEC.md section 2 —
 * registering a new version retires the prior live row, leaving exactly one
 * live row per logical `(user, site, table, searchType, tier, partition)`.
 */

import type { ManifestEntry } from '@gscdump/engine/contracts'
import type { AnalyticsManifestDb } from '../src/r2-manifest-store'
import { DatabaseSync } from 'node:sqlite'
import { drizzle } from 'drizzle-orm/d1'
import { beforeEach, describe, expect, it } from 'vitest'
import { createD1ManifestStore } from '../src/r2-manifest-store'

// --- Minimal D1Database shim over node:sqlite ----------------------------
// drizzle-orm/d1's session only needs: client.prepare(sql) → stmt with
// bind(...params) → { run(), all(), raw() }, plus client.batch([stmts]).
// Each result is shaped { results, success, meta } like a real D1Result.
function createD1Shim(sqlite: DatabaseSync) {
  function makeStmt(sqlText: string, bound: unknown[] = []) {
    return {
      bind(...params: unknown[]) {
        return makeStmt(sqlText, params)
      },
      run() {
        sqlite.prepare(sqlText).run(...(bound as never[]))
        return { results: [], success: true, meta: {} }
      },
      all() {
        const rows = sqlite.prepare(sqlText).all(...(bound as never[]))
        return { results: rows, success: true, meta: {} }
      },
      raw() {
        const stmt = sqlite.prepare(sqlText)
        stmt.setReadBigInts(false)
        const rows = stmt.all(...(bound as never[])) as Record<string, unknown>[]
        return rows.map(r => Object.values(r))
      },
    }
  }
  return {
    prepare(sqlText: string) {
      return makeStmt(sqlText)
    },
    async batch(stmts: Array<ReturnType<typeof makeStmt>>) {
      // node:sqlite has no nested-transaction needs here; run sequentially.
      // A real D1 batch is atomic — a throw mid-batch aborts the rest, which
      // is what the UNIQUE-constraint test below relies on.
      return stmts.map(s => s.all())
    },
    async exec(sqlText: string) {
      sqlite.exec(sqlText)
    },
  }
}

// r2_manifest DDL — mirrors r2-manifest-schema.ts (plain indexes only).
const MANIFEST_DDL = `
CREATE TABLE r2_manifest (
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  site_id TEXT,
  "table" TEXT NOT NULL,
  partition TEXT NOT NULL,
  object_key TEXT NOT NULL,
  row_count INTEGER NOT NULL DEFAULT 0,
  bytes INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  retired_at INTEGER,
  tier TEXT,
  search_type TEXT,
  schema_version INTEGER
);
CREATE UNIQUE INDEX r2_manifest_object_key_unique ON r2_manifest (object_key);
CREATE INDEX idx_r2_manifest_live ON r2_manifest (user_id, site_id, "table", partition, retired_at);
`

// SPEC.md section 2 partial unique index. Lives in the host's
// database/main migration 0011, NOT in this package's schema. Applied here
// only to prove the constraint behaviour the store's logic must satisfy.
const ONE_LIVE_INDEX_DDL = `
CREATE UNIQUE INDEX idx_r2_manifest_one_live
  ON r2_manifest (user_id, site_id, "table", search_type, COALESCE(tier, ''), partition)
  WHERE retired_at IS NULL;
`

function entry(over: Partial<ManifestEntry> = {}): ManifestEntry {
  return {
    userId: '1',
    siteId: 'site-a',
    table: 'gsc_pages',
    partition: 'daily/2026-05-01',
    objectKey: `users/1/site-a/gsc_pages/daily/2026-05-01/${crypto.randomUUID()}.parquet`,
    rowCount: 100,
    bytes: 4096,
    createdAt: Date.now(),
    tier: 'raw',
    searchType: 'web',
    ...over,
  }
}

function setup(withUniqueIndex = false) {
  const sqlite = new DatabaseSync(':memory:')
  sqlite.exec(MANIFEST_DDL)
  if (withUniqueIndex)
    sqlite.exec(ONE_LIVE_INDEX_DDL)
  const db = drizzle(createD1Shim(sqlite) as never) as unknown as AnalyticsManifestDb
  const store = createD1ManifestStore(db)
  return { sqlite, db, store }
}

describe('@gscdump/engine-sqlite createD1ManifestStore', () => {
  describe('single-live-per-partition guarantee (SPEC section 2)', () => {
    let store: ReturnType<typeof setup>['store']
    beforeEach(() => {
      ;({ store } = setup())
    })

    it('registerVersion of a fresh partition leaves exactly one live row', async () => {
      const e = entry()
      await store.registerVersion(e)

      const live = await store.listLive({ userId: '1', siteId: 'site-a' })
      expect(live).toHaveLength(1)
      expect(live[0]!.objectKey).toBe(e.objectKey)
      expect(live[0]!.retiredAt).toBeUndefined()
    })

    it('registering a new version retires the prior live row, one live row remains', async () => {
      const v1 = entry({ rowCount: 100 })
      await store.registerVersion(v1)

      // New version of the SAME logical partition supersedes v1.
      const v2 = entry({ rowCount: 250, createdAt: v1.createdAt + 1000 })
      await store.registerVersion(v2, [v1])

      const live = await store.listLive({ userId: '1', siteId: 'site-a' })
      expect(live).toHaveLength(1)
      expect(live[0]!.objectKey).toBe(v2.objectKey)
      expect(live[0]!.rowCount).toBe(250)

      // v1 still exists but is retired.
      const all = await store.listAll({ userId: '1', siteId: 'site-a' })
      expect(all).toHaveLength(2)
      const retired = all.find(r => r.objectKey === v1.objectKey)
      expect(retired?.retiredAt).toBe(v2.createdAt)
    })

    it('three successive versions collapse to a single live row', async () => {
      const base = Date.now()
      const v1 = entry({ createdAt: base })
      await store.registerVersion(v1)
      const v2 = entry({ createdAt: base + 1000 })
      await store.registerVersion(v2, [v1])
      const v3 = entry({ createdAt: base + 2000 })
      await store.registerVersion(v3, [v2])

      const live = await store.listLive({ userId: '1', siteId: 'site-a' })
      expect(live).toHaveLength(1)
      expect(live[0]!.objectKey).toBe(v3.objectKey)
      expect(await store.listAll({ userId: '1', siteId: 'site-a' })).toHaveLength(3)
    })

    it('web and discover at the same partition coexist as separate live rows', async () => {
      const web = entry({ searchType: 'web' })
      const discover = entry({ searchType: 'discover' })
      await store.registerVersion(web)
      await store.registerVersion(discover)

      const liveWeb = await store.listLive({ userId: '1', siteId: 'site-a', searchType: 'web' })
      expect(liveWeb).toHaveLength(1)
      expect(liveWeb[0]!.searchType).toBe('web')

      const liveDiscover = await store.listLive({ userId: '1', siteId: 'site-a', searchType: 'discover' })
      expect(liveDiscover).toHaveLength(1)
      expect(liveDiscover[0]!.searchType).toBe('discover')

      // Both are live: the searchType axis keeps them as distinct partitions.
      expect(await store.listLive({ userId: '1', siteId: 'site-a' })).toHaveLength(2)
    })

    it('registering a discover version does not retire the web live row', async () => {
      const web = entry({ searchType: 'web' })
      await store.registerVersion(web)
      const discoverV2 = entry({ searchType: 'discover' })
      await store.registerVersion(discoverV2)

      const live = await store.listLive({ userId: '1', siteId: 'site-a' })
      expect(live).toHaveLength(2)
      expect(live.some(r => r.objectKey === web.objectKey && r.retiredAt === undefined)).toBe(true)
    })
  })

  describe('idx_r2_manifest_one_live partial unique index (host migration 0011)', () => {
    it('the index rejects a direct insert of a second live row for the same partition', () => {
      const { sqlite } = setup(true)
      const insert = (key: string, retiredAt: number | null) =>
        sqlite.prepare(
          `INSERT INTO r2_manifest (id, user_id, site_id, "table", partition, object_key, created_at, retired_at, tier, search_type)
           VALUES (?, 1, 'site-a', 'gsc_pages', 'daily/2026-05-01', ?, 1000, ?, 'raw', 'web')`,
        ).run(key, key, retiredAt)

      // First live row inserts fine.
      expect(() => insert('key-1', null)).not.toThrow()

      // Second live row for the identical logical partition violates the
      // partial unique index.
      expect(() => insert('key-2', null)).toThrow(/UNIQUE constraint failed/i)

      // Retiring the first then inserting a second live row is allowed:
      // partial index only covers retired_at IS NULL rows.
      sqlite.prepare(`UPDATE r2_manifest SET retired_at = 2000 WHERE id = 'key-1'`).run()
      expect(() => insert('key-2', null)).not.toThrow()
    })

    it('the index permits two live rows that differ only by search_type', () => {
      const { sqlite } = setup(true)
      const insert = (key: string, searchType: string) =>
        sqlite.prepare(
          `INSERT INTO r2_manifest (id, user_id, site_id, "table", partition, object_key, created_at, retired_at, tier, search_type)
           VALUES (?, 1, 'site-a', 'gsc_pages', 'daily/2026-05-01', ?, 1000, NULL, 'raw', ?)`,
        ).run(key, key, searchType)

      expect(() => insert('web-key', 'web')).not.toThrow()
      expect(() => insert('discover-key', 'discover')).not.toThrow()
    })

    it('the store registerVersion flow stays within the index when superseding correctly', () => {
      const { store, sqlite } = setup(true)
      // registerVersion that retires the prior row must not trip the index.
      return (async () => {
        const v1 = entry()
        await store.registerVersion(v1)
        const v2 = entry({ createdAt: v1.createdAt + 1 })
        await expect(store.registerVersion(v2, [v1])).resolves.not.toThrow()
        const liveCount = sqlite
          .prepare(`SELECT COUNT(*) c FROM r2_manifest WHERE retired_at IS NULL`)
          .get() as { c: number }
        expect(liveCount.c).toBe(1)
      })()
    })
  })
})

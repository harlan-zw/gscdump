// In-isolate TTL cache decorator over `ManifestStore.listLive`. Hot path
// is the browser-direct DuckDB-WASM analytics fan-out, which calls
// `listLive(userId, siteId, table, searchType?)` once per table per render.
//
// Cache key excludes `partitions`/`tier` — those are compaction-internal,
// rare, and benefit less from caching. Mutating methods bust the cache
// scoped to the entry being written. Hosts can call `bustManifestCache`
// directly when an out-of-band write occurs (e.g. an engine builds its own
// ManifestStore internally and the decorator can't trap registerVersion).

import type { ListLiveFilter, ManifestEntry, ManifestStore } from '@gscdump/engine'

export interface CachedManifestStoreOptions {
  ttlMs?: number
}

const DEFAULT_TTL_MS = 30_000

interface CacheEntry {
  value: ManifestEntry[]
  expiresAt: number
}

export interface CachedManifestStore extends ManifestStore {
  bust: (scope: { userId: string | number, siteId?: string, table?: string, searchType?: string }) => void
  clear: () => void
  stats: () => { size: number }
}

function cacheKey(filter: ListLiveFilter): string | null {
  if (!filter.siteId || !filter.table || filter.partitions || filter.tier)
    return null
  const st = (filter as { searchType?: string }).searchType ?? ''
  return `${filter.userId}\0${filter.siteId}\0${filter.table}\0${st}`
}

export function createCachedManifestStore(
  inner: ManifestStore,
  options: CachedManifestStoreOptions = {},
): CachedManifestStore {
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS
  const cache = new Map<string, CacheEntry>()

  function bust(scope: { userId: string | number, siteId?: string, table?: string, searchType?: string }): void {
    const userId = String(scope.userId)
    if (scope.siteId && scope.table && scope.searchType !== undefined) {
      cache.delete(`${userId}\0${scope.siteId}\0${scope.table}\0${scope.searchType}`)
      // The unscoped read unions every searchType slice, so any slice mutation
      // also invalidates that cached union.
      cache.delete(`${userId}\0${scope.siteId}\0${scope.table}\0`)
      return
    }
    const prefix = scope.siteId && scope.table
      ? `${userId}\0${scope.siteId}\0${scope.table}\0`
      : scope.siteId
        ? `${userId}\0${scope.siteId}\0`
        : `${userId}\0`
    for (const k of cache.keys()) {
      if (k.startsWith(prefix))
        cache.delete(k)
    }
  }

  return {
    listLive: async (filter) => {
      const k = cacheKey(filter)
      if (!k)
        return inner.listLive(filter)
      const now = Date.now()
      const hit = cache.get(k)
      if (hit && hit.expiresAt > now)
        return hit.value
      const value = await inner.listLive(filter)
      cache.set(k, { value, expiresAt: now + ttlMs })
      return value
    },
    listAll: inner.listAll.bind(inner),
    registerVersion: async (entry, superseding) => {
      await inner.registerVersion(entry, superseding)
      bust({ userId: entry.userId, siteId: entry.siteId ?? '', table: entry.table, searchType: entry.searchType })
      for (const e of superseding ?? [])
        bust({ userId: e.userId, siteId: e.siteId ?? '', table: e.table, searchType: e.searchType })
    },
    registerVersions: async (entries, superseding) => {
      await inner.registerVersions(entries, superseding)
      for (const e of entries)
        bust({ userId: e.userId, siteId: e.siteId ?? '', table: e.table, searchType: e.searchType })
      for (const e of superseding ?? [])
        bust({ userId: e.userId, siteId: e.siteId ?? '', table: e.table, searchType: e.searchType })
    },
    listRetired: inner.listRetired.bind(inner),
    delete: async (entries) => {
      await inner.delete(entries)
      for (const e of entries)
        bust({ userId: e.userId, siteId: e.siteId ?? '', table: e.table, searchType: e.searchType })
    },
    getWatermarks: inner.getWatermarks.bind(inner),
    bumpWatermark: inner.bumpWatermark.bind(inner),
    getSyncStates: inner.getSyncStates.bind(inner),
    setSyncState: inner.setSyncState.bind(inner),
    withLock: inner.withLock.bind(inner),
    purgeTenant: async (filter) => {
      const result = await inner.purgeTenant(filter)
      bust({ userId: filter.userId, siteId: filter.siteId })
      return result
    },
    bust,
    clear: () => cache.clear(),
    stats: () => ({ size: cache.size }),
  }
}

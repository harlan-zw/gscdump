/**
 * Pure routing + caching helpers for `useGscSnapshotAnalyzer`.
 *
 * Extracted into a standalone, Nuxt-free module so the routing decision and
 * the result LRU are unit-testable without a Nuxt runtime (the composable file
 * itself depends on Nuxt auto-imports).
 */

import type { ArchetypeQuery } from '@gscdump/sdk'
import type { AnalyzerTableRouting } from './useGscSnapshotAnalyzer.contract'

/**
 * Decide where an archetype query runs given the analyzer's per-table routing.
 *
 * - `aux-cloud-only` is always `cloud` (not an Iceberg query).
 * - Otherwise the fact-table the archetype reads decides: a table the resolver
 *   marked `browser` runs locally; `server` (or degraded by a quota error)
 *   routes to the server tail. An unknown table fails safe to `server`.
 */
export function routeArchetype(
  query: ArchetypeQuery,
  routing: AnalyzerTableRouting,
  tableOf: (q: ArchetypeQuery) => string | null,
): 'browser' | 'server' | 'cloud' {
  if (query.archetype === 'aux-cloud-only')
    return 'cloud'
  const table = tableOf(query)
  if (!table)
    return 'cloud'
  return routing[table] === 'browser' ? 'browser' : 'server'
}

/**
 * Stable hash of an archetype query for the result LRU. Archetype inputs are
 * flat + declarative; keys are sorted so insertion order can't perturb the key.
 */
export function archetypeQueryHash(query: ArchetypeQuery): string {
  return JSON.stringify(query, Object.keys(query as unknown as Record<string, unknown>).sort())
}

/**
 * Compose the LRU cache key. Keyed by `snapshotVersion` so a fresh compaction
 * (new snapshot) invalidates every cached result without an explicit bust.
 */
export function resultCacheKey(snapshotVersion: string | undefined, query: ArchetypeQuery): string {
  return `${snapshotVersion ?? 'none'}::${archetypeQueryHash(query)}`
}

export interface ResultLru<V> {
  get: (key: string) => V | undefined
  set: (key: string, value: V) => void
  clear: () => void
  readonly size: number
}

/** Minimal insertion-ordered LRU. Re-inserts on `get` to mark recency. */
export function createResultLru<V>(capacity: number): ResultLru<V> {
  const map = new Map<string, V>()
  const cap = Math.max(1, Math.floor(capacity))
  return {
    get(key) {
      if (!map.has(key))
        return undefined
      const value = map.get(key)!
      map.delete(key)
      map.set(key, value)
      return value
    },
    set(key, value) {
      if (map.has(key))
        map.delete(key)
      map.set(key, value)
      while (map.size > cap) {
        const oldest = map.keys().next().value
        if (oldest === undefined)
          break
        map.delete(oldest)
      }
    },
    clear() {
      map.clear()
    },
    get size() {
      return map.size
    },
  }
}

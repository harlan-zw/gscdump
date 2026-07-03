/**
 * Pluggable cross-isolate cache for the R2 Data Catalog read path.
 *
 * The catalog read pays two round-trips that dominate a cold-isolate request:
 * `restCatalogLoadTable` (the snapshot pointer) and the manifest walk. Both are
 * cacheable, but the engine must not know *where* the cache lives — a hosted
 * Worker wants Cloudflare KV, a test wants memory, a CLI wants the filesystem.
 * So the cache is an injected {@link https://unstorage.unjs.io | unstorage}
 * `Storage`: the caller picks the driver, the engine just reads and writes.
 *
 * `unstorage` is a type-only import here — the engine gains no runtime storage
 * dependency, honouring the edge-safe core boundary. Values are JSON-plain
 * (strings, numbers, arrays); table metadata (which carries BigInt snapshot
 * ids) is NEVER cached cross-isolate, only used in-isolate for the walk.
 *
 * Expiry is embedded in the stored value (`exp`, epoch ms) so it is correct
 * across every driver regardless of whether that driver honours a TTL; a
 * driver `ttl` is also forwarded so KV-like backends self-evict for hygiene.
 */

import type { Storage } from 'unstorage'

/** Injected catalog cache: an unstorage `Storage` plus an optional defer hook. */
export interface CatalogCache {
  /** unstorage storage instance — the driver is the caller's choice. */
  storage: Storage
  /**
   * Optional hook to run a cache WRITE off the response critical path, e.g.
   * Cloudflare's `ctx.waitUntil`. When omitted the writer awaits the put
   * inline so it is never cut off when the response returns.
   */
  defer?: (write: Promise<unknown>) => void
}

/** A cached value boxed with its absolute expiry (epoch ms). */
interface Boxed<T> {
  v: T
  exp: number
}

/**
 * Read a cached value. Returns `undefined` on a miss, an expired entry, a
 * malformed box, or any driver error (the cache is best-effort: a read failure
 * degrades to a fresh load, never to an error).
 */
export async function cacheGet<T>(cache: CatalogCache, key: string, now: number): Promise<T | undefined> {
  const boxed = await cache.storage.getItem<Boxed<T>>(key).catch(() => null)
  if (!boxed || typeof boxed.exp !== 'number' || boxed.exp <= now)
    return undefined
  return boxed.v
}

/**
 * Write a cached value with an embedded expiry and a forwarded driver TTL.
 *
 * Returns the write promise. With a `defer` hook the write is handed to the
 * hook and a resolved promise is returned (the response is not blocked on it);
 * without one the write promise is returned for the caller to await, so a
 * fire-and-forget put is never silently dropped. Driver errors are swallowed —
 * a failed cache write must not fail the read.
 */
export function cachePut<T>(cache: CatalogCache, key: string, value: T, ttlMs: number, now: number): Promise<void> {
  const boxed: Boxed<T> = { v: value, exp: now + ttlMs }
  const write = cache.storage.setItem(key, boxed, { ttl: Math.ceil(ttlMs / 1000) }).catch(() => {})
  if (cache.defer) {
    cache.defer(write)
    return Promise.resolve()
  }
  return write
}

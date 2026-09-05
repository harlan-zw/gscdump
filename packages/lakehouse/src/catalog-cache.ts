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
  /** Optional warning sink for best-effort cache driver failures. */
  onError?: (operation: 'get' | 'set' | 'remove', key: string, error: unknown) => void
}

/** A cached value boxed with its absolute expiry (epoch ms). */
interface Boxed<T> {
  v: T
  exp: number
}

export function reportCatalogCacheError(cache: CatalogCache, operation: 'get' | 'set' | 'remove', key: string, error: unknown): void {
  try {
    if (cache.onError)
      cache.onError(operation, key, error)
    else
      console.warn(`[gscdump/lakehouse] cache ${operation} failed for ${key}`, error)
  }
  catch (reportError) {
    console.warn(`[gscdump/lakehouse] cache error reporter failed during ${operation} for ${key}`, reportError)
  }
}

/**
 * Read a cached value. Returns `undefined` on a miss, an expired entry, a
 * malformed box, or any driver error (the cache is best-effort: a read failure
 * degrades to a fresh load, never to an error).
 */
export async function cacheGet<T>(cache: CatalogCache, key: string, now: number): Promise<T | undefined> {
  const boxed = await cache.storage.getItem<Boxed<T>>(key).catch((error: unknown) => {
    reportCatalogCacheError(cache, 'get', key, error)
    return null
  })
  if (!boxed || typeof boxed.exp !== 'number' || boxed.exp <= now)
    return undefined
  return boxed.v
}

/**
 * Read many cached values in one storage round trip. Returns one slot per
 * input key: `undefined` on a miss, an expired entry, a malformed box, or any
 * driver error (the batch degrades to all-misses, never to an error).
 *
 * Slots are matched to their input key, not to a result index: unstorage
 * executes a multi-key read as one batch per mount and flattens the batches
 * in mount order, so raw indices only line up with the input when every key
 * shares a single mount. Entries echo their key, so each slot is filled from
 * the entry echoed under that exact key; when the echoes do not round-trip to
 * the input spelling (a driver may rewrite its keys) matching falls back to
 * positional order, which stays correct for the single-mount key sets the
 * catalog read path passes, and a short result degrades to all-misses.
 */
export async function cacheGetMany<T>(cache: CatalogCache, keys: string[], now: number): Promise<(T | undefined)[]> {
  if (keys.length === 0)
    return []
  const boxed = await cache.storage.getItems<Boxed<T>>(keys).catch((error: unknown) => {
    reportCatalogCacheError(cache, 'get', keys.length === 1 ? keys[0]! : `${keys[0]} (+${keys.length - 1} more)`, error)
    return null
  })
  const byKey = new Map((boxed ?? []).map(entry => [entry.key, entry] as const))
  const echoRoundTrips = keys.every(key => byKey.has(key))
  return keys.map((key, index) => {
    const entry = (echoRoundTrips ? byKey.get(key) : boxed?.[index])?.value
    if (!entry || typeof entry.exp !== 'number' || entry.exp <= now)
      return undefined
    return entry.v
  })
}

/**
 * Write a cached value with an embedded expiry and a forwarded driver TTL.
 *
 * Returns the write promise. With a `defer` hook the write is handed to the
 * hook and a resolved promise is returned (the response is not blocked on it);
 * without one the write promise is returned for the caller to await, so a
 * fire-and-forget put is never silently dropped. Driver errors are reported
 * through `onError` (or `console.warn`) but do not fail the read.
 */
export function cachePut<T>(cache: CatalogCache, key: string, value: T, ttlMs: number, now: number): Promise<void> {
  const boxed: Boxed<T> = { v: value, exp: now + ttlMs }
  const write = cache.storage.setItem(key, boxed, { ttl: Math.ceil(ttlMs / 1000) }).catch((error: unknown) => {
    reportCatalogCacheError(cache, 'set', key, error)
  })
  if (cache.defer) {
    cache.defer(write)
    return Promise.resolve()
  }
  return write
}

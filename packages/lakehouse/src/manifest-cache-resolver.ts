/**
 * Cross-isolate cache for immutable Iceberg manifest objects.
 *
 * `resolveIcebergDataFiles` walks every manifest of the current snapshot that
 * survives partition pruning (see `catalog.ts`). Each manifest and the
 * manifest-list it comes from is fetched via the resolver's `reader`, but the
 * in-icebird `cachingResolver` only memoizes reads for the lifetime of one
 * connection — nothing survives across requests/isolates. Measured on team
 * catalog `gsc-team-9df5b57c-...-int`, table `gsc.queries`: a wide range
 * pulls 164 manifests for 93 data files, ~2.0s locally and ~8.0s from a cold
 * Cloudflare Worker (iceberg.duckdb.scan 8,045ms). The existing `lh-files2`
 * resolved-file-list cache is keyed by snapshot id AND exact date range, so
 * every commit and every distinct range misses it.
 *
 * Manifest and manifest-list objects are immutable once written: Iceberg
 * writers (`icebird/src/write/stage.js`, `.../write/snapshot.js`) name them
 * `metadata/<uuid>-m0.avro` and `metadata/snap-<id>-1-<uuid>.avro` — new
 * paths per commit, never rewritten in place, only ever removed wholesale by
 * snapshot expiry. That makes the bytes at a given path cacheable forever
 * (bounded by a TTL for hygiene), unlike the mutable `metadata.json` /
 * `version-hint.text` pointers or the data files themselves, which this
 * wrapper deliberately never touches.
 *
 * Only `reader` is wrapped; `writer`/`deleter` pass through unchanged so a
 * resolver retains its shape (read-only stays read-only, writable stays
 * writable).
 */

import type { AsyncBuffer } from 'hyparquet'
import type { Resolver } from 'icebird/src/types.js'
import type { CatalogCache } from './catalog-cache'
import { cacheGetMany, cachePut } from './catalog-cache'

/** Manifest and manifest-list files live at `.../metadata/<name>.avro`. */
const MANIFEST_AVRO_PATH = /\/metadata\/[^/]+\.avro$/

/** Immutable at a given path — safe to cache well past a request lifetime. */
const MANIFEST_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000

/** unstorage/KV values must be JSON-plain; guard against caching huge objects as base64 strings. */
const MAX_CACHED_MANIFEST_BYTES = 1024 * 1024

/** Chunk size for `String.fromCharCode` spreads — stays well under engine argument-count limits. */
const BASE64_CHUNK_BYTES = 0x8000

/**
 * Live hit/miss counters for one connection's manifest cache. Read paths diff
 * these around the manifest walk to report a per-walk hit rate (see the
 * `iceberg.walk` profiler span in `resolveIcebergDataFiles`).
 */
export interface ManifestCacheStats {
  hits: number
  misses: number
}

interface CachedManifestBytes {
  /** Base64-encoded object bytes. */
  b64: string
}

function isManifestObjectPath(path: string): boolean {
  return MANIFEST_AVRO_PATH.test(path)
}

function manifestCacheKey(scope: string, path: string): string {
  return `lh-manifest\0${scope}\0${path}`
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  for (let offset = 0; offset < bytes.length; offset += BASE64_CHUNK_BYTES) {
    const chunk = bytes.subarray(offset, offset + BASE64_CHUNK_BYTES)
    binary += String.fromCharCode(...chunk)
  }
  return btoa(binary)
}

function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++)
    bytes[i] = binary.charCodeAt(i)
  return bytes
}

/** A fully-materialized in-memory `AsyncBuffer` — no further I/O on `slice`. */
function bufferedAsyncBuffer(bytes: Uint8Array): AsyncBuffer {
  return {
    byteLength: bytes.byteLength,
    slice(start = 0, end = bytes.byteLength) {
      return bytes.buffer.slice(bytes.byteOffset + start, bytes.byteOffset + end) as ArrayBuffer
    },
  }
}

/**
 * Wrap a base `Resolver` so reads of immutable manifest/manifest-list `.avro`
 * objects are served from a cross-isolate {@link CatalogCache} ahead of the
 * base reader. Every other path (data files, `metadata.json`,
 * `version-hint.text`) passes straight through untouched.
 *
 * The manifest walk reads dozens of objects with bounded concurrency (icebird
 * fans out 8-wide), so lookups registered in the same tick are coalesced into
 * one `getItems` batch — drivers without a native batch get back a parallel
 * fan-out instead of sequential awaited round trips, which is what made the
 * #42 wrapper slower than the S3 fetch it fronts on Workers.
 *
 * On a hit the cached bytes are returned with no call to `base.reader`. On a
 * miss the base reader is used exactly as it would be without this wrapper —
 * `resolveIcebergDataFiles`/`fetchAvroRecords` already read the whole object
 * via `slice(0, byteLength)`, so materializing it here to populate the cache
 * adds no extra request. Objects over {@link MAX_CACHED_MANIFEST_BYTES} are
 * read normally and never written to the cache. A base reader rejection is
 * never cached, so the next read retries the base.
 *
 * Cache writes never block the read's critical path when the caller supplies
 * `cache.defer` (e.g. `ctx.waitUntil`): they are handed to the hook and the
 * response is not blocked on them. Without a `defer` hook the write is
 * awaited inline — a deferred-less cache has no way to keep work alive past
 * the response (Workers cut pending work off), so awaiting is the only way
 * the write ever lands. `cachePut` already reports driver failures, and a
 * failed write only costs the next read a fresh fetch. When `stats` is
 * supplied the wrapper counts hits and misses into it.
 */
export function wrapManifestCacheResolver(
  base: Resolver,
  cache: CatalogCache,
  scope: string,
  clock: () => number = Date.now,
  stats?: ManifestCacheStats,
): Resolver {
  let batchScheduled = false
  const pendingGets = new Map<string, Array<(value: CachedManifestBytes | undefined) => void>>()

  function flushPendingGets(): void {
    batchScheduled = false
    const groups = [...pendingGets]
    pendingGets.clear()
    cacheGetMany<CachedManifestBytes>(cache, groups.map(([key]) => key), clock()).then((values) => {
      groups.forEach((group, index) => {
        for (const resolve of group[1]) resolve(values[index])
      })
    })
  }

  /** Register a key and coalesce every lookup that arrives before the flush. */
  function queuedGet(key: string): Promise<CachedManifestBytes | undefined> {
    return new Promise((resolve) => {
      const waiters = pendingGets.get(key)
      if (waiters)
        waiters.push(resolve)
      else
        pendingGets.set(key, [resolve])
      if (!batchScheduled) {
        batchScheduled = true
        // A macrotask, not a microtask: concurrent fetch continuations land in
        // separate macrotasks, so waiting one turn collects a whole wave.
        setTimeout(flushPendingGets, 0)
      }
    })
  }

  return {
    ...base,
    async reader(path, byteLength) {
      if (!isManifestObjectPath(path))
        return base.reader(path, byteLength)

      const key = manifestCacheKey(scope, path)
      const cached = await queuedGet(key)
      if (cached) {
        if (stats)
          stats.hits++
        return bufferedAsyncBuffer(base64ToBytes(cached.b64))
      }
      if (stats)
        stats.misses++

      const ab = await base.reader(path, byteLength)
      const bytes = new Uint8Array(await ab.slice(0, ab.byteLength))
      if (bytes.byteLength <= MAX_CACHED_MANIFEST_BYTES)
        await cachePut(cache, key, { b64: bytesToBase64(bytes) }, MANIFEST_CACHE_TTL_MS, clock())
      return bufferedAsyncBuffer(bytes)
    },
  }
}

import type { AsyncBuffer } from 'hyparquet'
import type { Resolver } from 'icebird/src/types.js'
import { cachedAsyncBuffer } from 'hyparquet'

/**
 * Default byte cap for the per-connection object cache.
 *
 * A Cloudflare Worker isolate has 128 MiB. A connection lives for one sink,
 * one dataset handle or one request, and a warm file resolution rereads one
 * manifest list and its selected manifests. 16 MiB holds two walks at the
 * README `readLimits.maxTotalObjectBytes` example (8 MiB), and uses one
 * eighth of the isolate.
 */
export const CONNECTION_CACHE_MAX_BYTES = 16 * 1024 * 1024

/** Bytes of the range reads one cached path holds. Its identity marks the current entry. */
interface Account {
  bytes: number
}

interface CacheEntry {
  buffer: Promise<AsyncBuffer>
  account: Account
}

/**
 * Wrap a resolver so that reads of one path share one reader call, and range
 * reads of that object share one fetch. This matches icebird
 * `cachingResolver`, with these differences:
 *
 * - The cache holds at most `maxBytes` of fetched ranges. It evicts the least
 *   recently read path first. An object whose ranges exceed `maxBytes` is
 *   evicted at once, and the other paths stay.
 * - A failed reader call or a failed range read evicts the path, so the next
 *   read tries again.
 *
 * A successful write or delete of a path evicts it, as in `cachingResolver`.
 * A caller that holds an evicted buffer can still read from it. Those bytes
 * belong to the caller and no longer count against the cap.
 */
export function byteCappedCachingResolver(base: Resolver, maxBytes: number = CONNECTION_CACHE_MAX_BYTES): Resolver {
  const entries = new Map<string, CacheEntry>()
  let totalBytes = 0

  function touch(path: string, entry: CacheEntry): void {
    entries.delete(path)
    entries.set(path, entry)
  }

  function evict(path: string, account: Account): void {
    if (entries.get(path)?.account !== account)
      return
    entries.delete(path)
    totalBytes -= account.bytes
  }

  function retain(path: string, account: Account, bytes: number): void {
    const entry = entries.get(path)
    if (entry?.account !== account)
      return
    account.bytes += bytes
    totalBytes += bytes
    touch(path, entry)
    if (account.bytes > maxBytes) {
      evict(path, account)
      return
    }
    for (const [oldest, old] of entries) {
      if (totalBytes <= maxBytes)
        break
      // An entry with no fetched bytes frees nothing; keep it so its read stays shared.
      if (old.account.bytes > 0)
        evict(oldest, old.account)
    }
  }

  function counted(path: string, account: Account, file: AsyncBuffer): AsyncBuffer {
    return {
      byteLength: file.byteLength,
      slice(start, end) {
        // `cachedAsyncBuffer` keeps each range promise it gets from here,
        // including a rejected one. Evicting the path drops that buffer.
        return Promise.resolve(file.slice(start, end)).then(
          (bytes) => {
            retain(path, account, bytes.byteLength)
            return bytes
          },
          (error: unknown) => {
            evict(path, account)
            throw error
          },
        )
      },
    }
  }

  function invalidate(path: string): void {
    const entry = entries.get(path)
    if (entry)
      evict(path, entry.account)
  }

  const out: Resolver = {
    reader(path, byteLength) {
      const hit = entries.get(path)
      if (hit) {
        touch(path, hit)
        return hit.buffer
      }
      const account: Account = { bytes: 0 }
      // The async wrapper turns a synchronous throw into a rejection, so one path evicts both.
      const buffer = (async () => cachedAsyncBuffer(counted(path, account, await base.reader(path, byteLength))))()
      entries.set(path, { buffer, account })
      // The caller gets the rejection from `buffer`; this branch only evicts.
      buffer.catch(() => evict(path, account))
      return buffer
    },
  }
  if (base.writer) {
    const baseWriter = base.writer
    out.writer = (path, options) => {
      const writer = baseWriter(path, options)
      const finish = writer.finish.bind(writer)
      writer.finish = async function () {
        // A rejected finish leaves the object unchanged, so the cached bytes stay valid.
        await finish()
        invalidate(path)
      }
      return writer
    }
  }
  if (base.deleter) {
    const baseDeleter = base.deleter
    out.deleter = async (path) => {
      await baseDeleter(path)
      invalidate(path)
    }
  }
  return out
}

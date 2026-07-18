// R2-backed DataSource. Wraps a Cloudflare R2 bucket into the edge-safe bytes
// interface expected by @gscdump/analytics. Structural typing — we declare
// only the methods we call so this module stays free of
// `@cloudflare/workers-types` as a hard dep. Any `R2Bucket` passed at runtime
// satisfies the shape.
//
// `uri(key)` returns `r2://{bucket}/{key}` for DuckDB httpfs reads against
// a build configured with an R2 secret.

import type { DataSource } from '../storage'

// Bucket identifiers in R2 are ASCII: lowercase alphanumeric + hyphens,
// 3-63 chars. Reject anything else at construction — a malformed bucket
// name would flow straight into a DuckDB SQL literal.
const BUCKET_NAME_RE = /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/

// Object keys produced by the engine are built from tenant prefixes + ASCII
// path segments + UUIDs. Constrain to the subset that never needs
// SQL-escaping in `'r2://bucket/<key>'` so callers don't need a second
// escaping layer. Covers letters, digits, `._/-` and `=` (base-encoded
// site-ids can carry `=`).
const KEY_RE = /^[\w./=-]+$/
const DELETE_CHUNK_SIZE = 1000
const DELETE_CONCURRENCY = 4

function assertKey(key: string): void {
  if (!KEY_RE.test(key))
    throw new Error(`createR2DataSource: refusing unsafe key ${JSON.stringify(key)}`)
}

// Mirrors the `range` shape the adapter passes to `bucket.get` — always
// `{ offset, length }` concrete values forwarded from `DataSource.read`'s
// range arg. Keeping both fields required aligns with Cloudflare's
// `R2Bucket.get` signature so a real `R2Bucket` is structurally assignable
// here without a cast.
interface R2GetOptions {
  range?: { offset: number, length: number }
}

interface R2ObjectBody {
  arrayBuffer: () => Promise<ArrayBuffer>
}

interface R2HeadObject {
  size: number
}

interface R2ListResult {
  objects: Array<{ key: string }>
  truncated: boolean
  cursor?: string
}

interface R2ListOptions {
  prefix?: string
  cursor?: string
  limit?: number
}

interface R2BucketLike {
  get: (key: string, options?: R2GetOptions) => Promise<R2ObjectBody | null>
  put: (key: string, bytes: Uint8Array) => Promise<unknown>
  delete: (keys: string | string[]) => Promise<void>
  list: (options?: R2ListOptions) => Promise<R2ListResult>
  head: (key: string) => Promise<R2HeadObject | null>
}

export interface R2DataSourceOptions {
  /**
   * R2 bucket binding. Structurally typed — pass a Cloudflare `R2Bucket` or
   * any object with the same get/put/delete/list/head surface.
   */
  bucket: R2BucketLike
  /**
   * When set, `uri(key)` returns `r2://{bucketName}/{key}` for DuckDB httpfs
   * reads. Omit if the backing DuckDB can't resolve `r2://` URIs and the
   * caller should fall back to `read(key)` for bytes.
   */
  bucketName?: string
}

export function createR2DataSource(options: R2DataSourceOptions): DataSource {
  const { bucket } = options
  let resolvedBucketName: string | undefined
  if (options.bucketName !== undefined) {
    if (!BUCKET_NAME_RE.test(options.bucketName))
      throw new Error(`createR2DataSource: invalid R2 bucket name ${JSON.stringify(options.bucketName)}`)
    resolvedBucketName = options.bucketName
  }

  return {
    async read(key, range) {
      const obj = await bucket.get(key, range ? { range } : undefined)
      if (!obj)
        throw new Error(`R2 object not found: ${key}`)
      const ab = await obj.arrayBuffer()
      return new Uint8Array(ab)
    },
    async write(key, bytes) {
      await bucket.put(key, bytes)
    },
    async delete(keys) {
      if (keys.length === 0)
        return
      // R2 `delete` accepts string | string[]. Chunk at 1000 (R2's batch cap).
      // Chunks are independent, so keep a small number in flight instead of
      // paying one network RTT per chunk during tenant purges and GC.
      let next = 0
      async function worker(): Promise<void> {
        while (true) {
          const offset = next
          next += DELETE_CHUNK_SIZE
          if (offset >= keys.length)
            return
          await bucket.delete(keys.slice(offset, offset + DELETE_CHUNK_SIZE))
        }
      }
      const chunkCount = Math.ceil(keys.length / DELETE_CHUNK_SIZE)
      await Promise.all(Array.from({ length: Math.min(DELETE_CONCURRENCY, chunkCount) }, worker))
    },
    async list(prefix) {
      const out: string[] = []
      let cursor: string | undefined
      do {
        const res = await bucket.list({ prefix, cursor, limit: 1000 })
        for (const o of res.objects) out.push(o.key)
        cursor = res.truncated ? res.cursor : undefined
      } while (cursor)
      return out
    },
    async* streamList(prefix) {
      let cursor: string | undefined
      do {
        const res = await bucket.list({ prefix, cursor, limit: 1000 })
        for (const o of res.objects) yield o.key
        cursor = res.truncated ? res.cursor : undefined
      } while (cursor)
    },
    async head(key) {
      const obj = await bucket.head(key)
      if (!obj)
        return undefined
      return { bytes: obj.size }
    },
    uri: resolvedBucketName
      ? (key: string) => {
          assertKey(key)
          return `r2://${resolvedBucketName}/${key}`
        }
      : undefined,
  }
}

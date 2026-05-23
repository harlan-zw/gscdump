// Shared browser-DuckDB-WASM helpers used by per-site analyzers and the
// home-page multi-site fanout. Both consumers boot the same WASM bundle and
// run the same in-memory parquet attach path; OPFS attach lives in the caller
// because the two lifecycle models (refcounted long-lived vs ephemeral
// per-run) need different handle ownership.

import type { AsyncDuckDB, AsyncDuckDBConnection } from '@duckdb/duckdb-wasm'
import type { DuckDBWasmBootResult, OpfsAttachedHandle } from '@gscdump/engine-duckdb-wasm'

/**
 * Boot DuckDB-WASM using the layer's configured bundle base. The dynamic
 * `import('@gscdump/engine-duckdb-wasm')` keeps the WASM bundle out of the
 * SSR build; callers should also gate the call behind `import.meta.client`.
 *
 * The `filesystem` config disables HEAD-request preflight and forces full
 * HTTP reads — Cloudflare Workers strips `Content-Length` on streamed
 * responses, which makes DuckDB's default range-request path 404.
 */
export async function bootGscDuckDBWasm(bundleBase?: string): Promise<DuckDBWasmBootResult> {
  const { bootDuckDBWasm } = await import('@gscdump/engine-duckdb-wasm')
  return bootDuckDBWasm({
    ...(bundleBase
      ? {
          bundles: {
            mvp: { mainModule: `${bundleBase}/duckdb-mvp.wasm`, mainWorker: `${bundleBase}/duckdb-browser-mvp.worker.js` },
            eh: { mainModule: `${bundleBase}/duckdb-eh.wasm`, mainWorker: `${bundleBase}/duckdb-browser-eh.worker.js` },
          },
        }
      : {}),
    config: { filesystem: { reliableHeadRequests: false, allowFullHTTPReads: true } },
  })
}

/**
 * Process-wide shared boot. The ~800ms WASM boot is the dominant cost on the
 * warm path (OPFS cache-hit means downloads are skipped); paying it once per
 * session instead of per refresh turns date-range changes / search-type
 * swaps into near-instant updates.
 *
 * Callers that want their own throwaway instance can keep using
 * {@link bootGscDuckDBWasm}; those that want session-wide reuse — the home
 * page fanout and the per-site analyzer — go through this.
 *
 * Browser-only. The `bundleBase` is captured from the first call; subsequent
 * calls reuse the promise and ignore the argument (it's a deployment-wide
 * constant in practice).
 */
let sharedBootPromise: Promise<DuckDBWasmBootResult> | null = null
let sharedBootColdMs: number | undefined
export function sharedGscDuckDBWasm(bundleBase?: string): Promise<DuckDBWasmBootResult> {
  if (!sharedBootPromise) {
    if (typeof performance !== 'undefined')
      performance.mark('gsc:duckdb:boot:start')
    const start = typeof performance !== 'undefined' ? performance.now() : 0
    sharedBootPromise = bootGscDuckDBWasm(bundleBase).then((b) => {
      if (typeof performance !== 'undefined') {
        sharedBootColdMs = performance.now() - start
        performance.mark('gsc:duckdb:boot:end')
      }
      return b
    })
  }
  else if (typeof performance !== 'undefined') {
    performance.mark('gsc:duckdb:boot:reuse')
  }
  return sharedBootPromise
}

/** Diagnostics: ms paid for the one-time cold boot, or undefined if not yet booted. */
export function sharedGscDuckDBWasmColdMs(): number | undefined {
  return sharedBootColdMs
}

/**
 * Fetch every URL into a `Uint8Array` in parallel. `onFileFetched` ticks
 * once per successful download. Separate from `registerParquetView` so
 * callers can run fetches outside any connection mutex.
 */
export async function fetchParquetBuffers(
  urls: readonly string[],
  onFileFetched?: () => void,
): Promise<Uint8Array[]> {
  return Promise.all(urls.map(async (url) => {
    const r = await fetch(url, { credentials: 'omit' })
    if (!r.ok)
      throw new Error(`GET ${url} failed: ${r.status}`)
    const buf = new Uint8Array(await r.arrayBuffer())
    onFileFetched?.()
    return buf
  }))
}

/**
 * Register pre-fetched parquet buffers as virtual files, then build a single
 * view that unions them. `CAST(date AS DATE)` canonicalises the legacy-VARCHAR
 * / new-DATE encodings. File-name uniqueness is the caller's job; pass a
 * `viewName` that already encodes any site/table salt so concurrent attaches
 * across sites don't collide on the DuckDB virtual filesystem. Call under the
 * DuckDB-WASM single-connection mutex.
 */
export async function registerParquetView(opts: {
  db: AsyncDuckDB
  conn: AsyncDuckDBConnection
  viewName: string
  buffers: readonly Uint8Array[]
}): Promise<void> {
  const { db, conn, viewName, buffers } = opts
  const fileNames = buffers.map((_, i) => `${viewName}_${i}.parquet`)
  for (let i = 0; i < buffers.length; i++)
    await db.registerFileBuffer(fileNames[i]!, buffers[i]!)
  const fileList = fileNames.map(n => `'${n.replace(/'/g, '\'\'')}'`).join(',')
  await conn.query(`CREATE OR REPLACE VIEW ${viewName} AS SELECT * REPLACE (CAST(date AS DATE) AS date) FROM read_parquet([${fileList}], union_by_name = true)`)
}

/**
 * Attach a parquet file set into DuckDB-WASM, preferring the OPFS-backed
 * path (cache-hit skips download) and falling back to in-memory buffers when
 * OPFS is opted out, unavailable, or quota-exhausted.
 *
 * Returns the OPFS handle when the OPFS path succeeded — caller must keep
 * the handle alive and `detach()` on cleanup. Returns `null` when the
 * fallback path was used; nothing to detach. `onFileProgress` ticks once per
 * downloaded file in either path so the caller can drive a progress UI.
 *
 * `withDb` wraps the DDL/file-register calls when the caller serialises
 * against other DuckDB activity (e.g. a shared connection); pass `undefined`
 * when the caller already owns a private connection.
 */
export async function attachParquetWithFallback(args: {
  db: AsyncDuckDB
  conn: AsyncDuckDBConnection
  viewName: string
  files: readonly { url: string, bytes: number, contentHash: string }[]
  version: string
  useOpfsCache: boolean
  fetchConcurrency?: number
  onFileProgress?: () => void
  withDb?: <T>(fn: () => Promise<T>) => Promise<T>
}): Promise<OpfsAttachedHandle | null> {
  const { db, conn, viewName, files, version, useOpfsCache, onFileProgress } = args
  const lock = args.withDb ?? (<T>(fn: () => Promise<T>) => fn())
  const fetchConcurrency = args.fetchConcurrency ?? Math.min(files.length, 4)

  if (useOpfsCache) {
    const { attachOpfsParquetTables } = await import('@gscdump/engine-duckdb-wasm')
    const handle = await lock(() => attachOpfsParquetTables({
      db,
      conn,
      tables: [{
        table: viewName,
        files: files.map(f => ({ url: f.url, bytes: f.bytes, contentHash: f.contentHash })),
      }],
      version,
      fetchConcurrency,
      onFileProgress,
    }))
    if (!handle.degradedTables.includes(viewName))
      return handle
    // OPFS quota / failure — fall through to buffer path. Caller's progress
    // counter restarts; both paths report one tick per fetched file.
  }

  const buffers = await fetchParquetBuffers(files.map(f => f.url), onFileProgress)
  await lock(() => registerParquetView({ db, conn, viewName, buffers }))
  return null
}

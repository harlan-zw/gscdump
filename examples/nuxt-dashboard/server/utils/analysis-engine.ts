// Build a server-side analytics StorageEngine backed by Node DuckDB + R2 over
// HTTP. Each route reuses one engine (the Node DuckDB handle is a singleton
// under the hood, so there's no benefit to rebuilding per-request).
//
// This is the "flag OFF" path — gscdump.com today runs something analogous
// server-side, just against D1 instead of R2 parquets.

import type { StorageEngine, TenantCtx } from 'gscdump/analytics'
import {
  createDuckDBCodec,
  createDuckDBExecutor,
  createStorageEngine,
} from 'gscdump/analytics'
import { createHttpDataSource, createHttpManifestStore } from 'gscdump/analytics/http'
import { createNodeDuckDBHandle } from 'gscdump/analytics/node'
import { useR2Client } from './r2-client'

interface EngineHandle {
  engine: StorageEngine
  ctx: TenantCtx
}

let cached: Promise<EngineHandle> | null = null

async function build(origin: string): Promise<EngineHandle> {
  const cfg = useRuntimeConfig()
  const userId = cfg.gscUserId
  const siteId = cfg.gscSiteId || undefined
  if (!userId)
    throw createError({ statusCode: 500, statusMessage: 'GSCDUMP_USER_ID not set' })

  const r2 = useR2Client()
  const handle = createNodeDuckDBHandle()
  // createDuckDBCodec + Executor take a factory; the node handle IS the
  // singleton, so wrap it trivially.
  const factory = { getDuckDB: async () => handle }

  const dataSource = createHttpDataSource({
    baseUrl: `https://${cfg.r2AccountId}.r2.cloudflarestorage.com/${cfg.r2Bucket}`,
    // Every read signs a fresh URL locally — no round-trip back through our
    // own /api/sign-url. The browser hits /api/sign-url because it doesn't
    // have the R2 secret; the server has it, so call the R2 client directly.
    signUrl: (key: string) => {
      // signUrl is sync in the type, but the signer is async. Encode a
      // deterministic URL shape: the `uri` codepath asks for this
      // synchronously for DuckDB httpfs. We'll piggyback by presigning
      // ahead-of-time on every read call via a different route — but the
      // executor's uri() also needs sync, so we fall back to useDuckDBHttpfs:
      // false and let the codec buffer bytes through `read()`, where we
      // CAN be async. See below.
      // This string is a placeholder; with useDuckDBHttpfs:false nobody
      // calls it.
      return `${cfg.r2AccountId}.r2.cloudflarestorage.com/${cfg.r2Bucket}/${key}`
    },
    useDuckDBHttpfs: false,
  })

  // The http adapter's `read(key)` path is async, so override it to presign
  // + fetch in one step. Keeps the DataSource contract while letting us
  // do async signing.
  const originalRead = dataSource.read
  dataSource.read = async (key, range, signal) => {
    const url = await r2.presignGet(key)
    const headers: Record<string, string> = {}
    if (range)
      headers.Range = `bytes=${range.offset}-${range.offset + range.length - 1}`
    const res = await fetch(url, { headers, signal })
    if (!res.ok)
      throw new Error(`r2 read failed ${res.status} for ${key}`)
    return new Uint8Array(await res.arrayBuffer())
  }
  void originalRead

  const manifestStore = createHttpManifestStore({
    manifestUrl: `${origin}/api/manifest?user=${userId}${siteId ? `&site=${siteId}` : ''}`,
  })

  const engine = createStorageEngine({
    dataSource,
    manifestStore,
    codec: createDuckDBCodec(factory),
    executor: createDuckDBExecutor(factory),
  })

  return { engine, ctx: { userId, siteId } }
}

/**
 * Lazy singleton — the Node DuckDB bindings are themselves a singleton, and
 * the HTTP manifest store caches its fetch. Rebuilding per-request would
 * waste ~20ms + the manifest cache.
 */
export function useAnalysisEngine(origin: string): Promise<EngineHandle> {
  if (!cached)
    cached = build(origin)
  return cached
}

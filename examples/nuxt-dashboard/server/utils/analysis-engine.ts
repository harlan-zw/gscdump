// Build a server-side analytics StorageEngine backed by Node DuckDB + R2 over
// HTTP. Each route reuses one engine (the Node DuckDB handle is a singleton
// under the hood, so there's no benefit to rebuilding per-request).
//
// This is the "flag OFF" path — gscdump.com today runs something analogous
// server-side, just against D1 instead of R2 parquets.

import type { StorageEngine, TenantCtx } from '@gscdump/engine'
import {
  createDuckDBCodec,
  createDuckDBExecutor,
  createStorageEngine,
} from '@gscdump/engine'
import { createHttpDataSource, createHttpManifestStore } from '@gscdump/engine/http'
import { createNodeDuckDBHandle } from '@gscdump/engine/node'

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

  const handle = createNodeDuckDBHandle()
  // createDuckDBCodec + Executor take a factory; the node handle IS the
  // singleton, so wrap it trivially.
  const factory = { getDuckDB: async () => handle }

  // Read through /api/r2-data: that route already branches between
  // GSCDUMP_DATA_DIR (local fs) and R2 (presign + stream), so the engine
  // doesn't need to know which backend is live. Pure same-origin fetch.
  const dataSource = createHttpDataSource({
    baseUrl: `${origin}/api/r2-data`,
    signUrl: (key: string) => `${origin}/api/r2-data/${key}`,
    useDuckDBHttpfs: false,
  })
  dataSource.read = async (key, range, signal) => {
    const headers: Record<string, string> = {}
    if (range)
      headers.Range = `bytes=${range.offset}-${range.offset + range.length - 1}`
    const res = await fetch(`${origin}/api/r2-data/${key}`, { headers, signal })
    if (!res.ok)
      throw new Error(`read failed ${res.status} for ${key}`)
    return new Uint8Array(await res.arrayBuffer())
  }

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

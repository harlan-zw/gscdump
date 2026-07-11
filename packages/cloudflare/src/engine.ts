import type { AnalyticsManifestDb } from '@gscdump/engine-sqlite'
import type { AnalyticsEnv } from './env'
import { createStorageEngine } from '@gscdump/engine'
import { createD1ManifestStore } from '@gscdump/engine-sqlite'
import { createR2DataSource } from '@gscdump/engine/r2'
import { createDucklingsCodec, createDucklingsExecutor, createDucklingsRowCache } from './workers-duckdb'

/**
 * Optional per-request hooks for telemetry / tracing. Hosts wire these in
 * to bridge engine activity into their own metrics pipeline.
 */
export interface AnalyticsEngineHooks {
  /** Called once per R2 PUT, with the byte size of the payload. */
  onR2Write?: (byteLength: number) => void
}

// Returns null when R2 isn't bound (e.g. local dev without wrangler.toml R2
// binding). Callers must tolerate a missing engine.
//
// Engine construction stays per request (no WASM compile happens here — that's
// in the duckdb Worker). The runtime owns only the immutable, content-addressed
// decoded-row cache shared by those short-lived engine instances.
//
// Hosts call this per-request, passing their Drizzle D1 instance built from
// `env.DB`. The layer doesn't own a db singleton.
//
// `db` is intentionally typed as `unknown` at the boundary: pnpm dedupes
// drizzle-orm differently across host vs layer node_modules trees, so the
// host's `DrizzleD1Database` is a different type identity than ours even at
// the same version. The cast inside is safe because the manifest store
// reaches into its own table objects at runtime.

export interface AnalyticsEngineRuntime {
  getEngine: (env: AnalyticsEnv, db: any, hooks?: AnalyticsEngineHooks) => ReturnType<typeof createStorageEngine> | null
}

export function createAnalyticsEngineRuntime(): AnalyticsEngineRuntime {
  const rowCache = createDucklingsRowCache()
  return {
    getEngine(env, db, hooks = {}) {
      if (!env.R2_DATA)
        return null

      const baseDataSource = createR2DataSource({ bucket: env.R2_DATA, bucketName: env.R2_BUCKET_NAME })
      const dataSource = hooks.onR2Write
        ? {
            ...baseDataSource,
            async write(key: string, bytes: Uint8Array) {
              hooks.onR2Write!(bytes.byteLength)
              return baseDataSource.write(key, bytes)
            },
          }
        : baseDataSource
      const manifestStore = createD1ManifestStore(db as unknown as AnalyticsManifestDb)
      const codec = createDucklingsCodec(env)
      const executor = createDucklingsExecutor(env, { rowCache })

      return createStorageEngine({ dataSource, manifestStore, codec, executor })
    },
  }
}

let sharedRuntime: AnalyticsEngineRuntime | undefined

export function getAnalyticsEngine(env: AnalyticsEnv, db: any, hooks: AnalyticsEngineHooks = {}): ReturnType<typeof createStorageEngine> | null {
  sharedRuntime ??= createAnalyticsEngineRuntime()
  return sharedRuntime.getEngine(env, db, hooks)
}

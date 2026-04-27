// Post-sync rollup rebuild. Reads raw parquet via the analytics engine and
// writes aggregated JSON envelopes back to R2 at
// `u_<userId>/<siteId>/rollups/<id>__v<builtAt>.json`. The
// `/api/__gsc/sites/[siteId]/rollup/[id]` endpoint reads the latest version.
//
// Kept best-effort: sync path must never fail because rollups failed.
// Errors surface via r2_write_errors for observability.

import type { AnalyticsEnv } from '../utils/analytics/env'
import type { AnalyticsManifestDb } from './d1-manifest-store'
import { createR2DataSource } from '@gscdump/engine/r2'
import { DEFAULT_ROLLUPS, rebuildRollups } from '@gscdump/engine/rollups'
import { getAnalyticsEngine } from './engine'
import { r2WriteErrors } from './schema'

export interface RebuildRollupsCtx {
  userId: number
  siteId: string
}

export async function rebuildSiteRollups(
  env: AnalyticsEnv,
  db: AnalyticsManifestDb,
  ctx: RebuildRollupsCtx,
): Promise<{ built: number, failed: number }> {
  const engine = getAnalyticsEngine(env, db)
  if (!engine || !env.R2_DATA)
    return { built: 0, failed: 0 }

  const dataSource = createR2DataSource({ bucket: env.R2_DATA, bucketName: env.R2_BUCKET_NAME })
  const rollupCtx = { userId: String(ctx.userId), siteId: ctx.siteId }

  return rebuildRollups({
    engine: { runSQL: opts => engine.runSQL(opts) },
    dataSource,
    ctx: rollupCtx,
    defs: DEFAULT_ROLLUPS,
  }).then(results => ({ built: results.length, failed: 0 })).catch(async (err) => {
    await db.insert(r2WriteErrors).values({
      id: crypto.randomUUID(),
      userId: ctx.userId,
      siteId: ctx.siteId,
      table: null,
      date: null,
      error: `rollup rebuild: ${err instanceof Error ? (err.stack || err.message) : String(err)}`.slice(0, 2000),
      createdAt: Math.floor(Date.now() / 1000),
    }).run().catch(() => {})
    return { built: 0, failed: 1 }
  })
}

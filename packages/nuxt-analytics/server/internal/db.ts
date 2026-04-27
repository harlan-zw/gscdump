// Lazy Drizzle-over-D1 helper for layer handlers.
//
// The layer owns `AnalyticsManifestDb` — a drizzle instance bound to the
// r2* tables declared in `./schema`. Hosts that maintain their own drizzle
// instance over a broader schema can skip this helper and pass their
// instance directly into `createD1ManifestStore` / `getAnalyticsEngine`;
// the layer only touches the r2* tables so a wider schema is safe.

import type { AnalyticsEnv } from '../utils/analytics/env'
import type { AnalyticsManifestDb } from './d1-manifest-store'
import { drizzle } from 'drizzle-orm/d1'
import { r2Locks, r2Manifest, r2SyncStates, r2Watermarks } from './schema'

export function getAnalyticsDb(env: AnalyticsEnv): AnalyticsManifestDb | null {
  if (!env.DB)
    return null
  return drizzle(env.DB, { schema: { r2Manifest, r2Locks, r2SyncStates, r2Watermarks } })
}

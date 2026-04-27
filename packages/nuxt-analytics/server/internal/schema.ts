// Drizzle (sqlite-core) schema for the analytics layer's own D1 tables.
//
// These tables are infrastructure for the R2-native manifest + sync flow.
// The R2 snapshot+HEAD pointer is authoritative (see @gscdump/engine/r2-manifest);
// this D1 mirror exists as a queryable cache for host-side views (per-user
// listings, sort-by-clicks dashboards) that can't afford a full R2 snapshot
// fetch per request.
//
// Host apps import these directly:
//
//   import { r2Manifest, r2Locks } from '@gscdump/nuxt-analytics/schema'
//
// and include them in their drizzle config / migrations. Owning them here
// keeps the migration story simple — the host's drizzle-kit picks up the
// tables wherever they're imported from.
//
// The layer does NOT export `users` or `userSites` — those are host-identity
// concerns. Routing helpers take the relevant fields (migrationPhase,
// migrationReadFrom) as plain values, so the layer never sees a host user row.

import { sql } from 'drizzle-orm'
import { index, integer, primaryKey, sqliteTable, text, unique } from 'drizzle-orm/sqlite-core'

// Manifest mirror: one row per (user, site, table, partition, object). `retired_at`
// marks superseded versions; `listLive` filters IS NULL.
//
// NOTE: gscdump.com migration 0008 adds a partial unique index
// `idx_r2_manifest_one_live_per_partition` (WHERE retired_at IS NULL) via
// raw SQL. drizzle-kit can't model partial indexes, so it isn't reflected
// here. Preserve that index across regenerations.
export const r2Manifest = sqliteTable('r2_manifest', {
  id: text('id').primaryKey(),
  userId: integer('user_id').notNull(),
  siteId: text('site_id'),
  table: text('table').notNull(),
  partition: text('partition').notNull(),
  objectKey: text('object_key').notNull(),
  rowCount: integer('row_count').notNull().default(0),
  bytes: integer('bytes').notNull().default(0),
  createdAt: integer('created_at').notNull(),
  retiredAt: integer('retired_at'),
  // Tiered-compaction cohort: 'raw' | 'd7' | 'd30' | 'd90'. Legacy rows pre-
  // migration resolve via inferLegacyTier (daily/ → raw, monthly/ → d30).
  tier: text('tier'),
  // GSC searchType partition: 'web' | 'discover' | 'news' | 'googleNews' | 'image' | 'video'.
  // Legacy / unset reads as 'web'.
  searchType: text('search_type'),
  // Table schema version at write time; omitted rows treat as 1.
  schemaVersion: integer('schema_version'),
}, t => [
  index('idx_r2_manifest_live').on(t.userId, t.siteId, t.table, t.partition, t.retiredAt),
  index('idx_r2_manifest_retired').on(t.retiredAt),
  index('idx_r2_manifest_tier').on(t.userId, t.siteId, t.table, t.tier, t.retiredAt),
  unique('r2_manifest_object_key_unique').on(t.objectKey),
])

export type R2ManifestInsert = typeof r2Manifest.$inferInsert
export type R2ManifestSelect = typeof r2Manifest.$inferSelect

// Observability: failed R2 writes (D1 path still succeeds; R2 errors recorded here).
export const r2WriteErrors = sqliteTable('r2_write_errors', {
  id: text('id').primaryKey(),
  userId: integer('user_id').notNull(),
  siteId: text('site_id'),
  table: text('table'),
  date: text('date'),
  error: text('error').notNull(),
  createdAt: integer('created_at').notNull().default(sql`(unixepoch())`),
}, t => [
  index('idx_r2_write_errors_user').on(t.userId, t.createdAt),
  index('idx_r2_write_errors_created').on(t.createdAt),
])

export type R2WriteErrorInsert = typeof r2WriteErrors.$inferInsert
export type R2WriteErrorSelect = typeof r2WriteErrors.$inferSelect

// Shadow reads: diffs between D1 primary and R2 shadow (migration observability).
export const r2ShadowDiffs = sqliteTable('r2_shadow_diffs', {
  id: text('id').primaryKey(),
  userId: integer('user_id').notNull(),
  siteId: text('site_id'),
  endpoint: text('endpoint').notNull(),
  diff: text('diff').notNull(),
  createdAt: integer('created_at').notNull().default(sql`(unixepoch())`),
}, t => [
  index('idx_r2_shadow_diffs_user').on(t.userId, t.createdAt),
  index('idx_r2_shadow_diffs_endpoint').on(t.endpoint, t.createdAt),
])

export type R2ShadowDiffInsert = typeof r2ShadowDiffs.$inferInsert
export type R2ShadowDiffSelect = typeof r2ShadowDiffs.$inferSelect

// Cross-isolate mutual-exclusion for writeDay / compaction. Lease-based:
// acquire writes { holderId, acquiredAt, expiresAt }; release only deletes
// when holderId matches.
export const r2Locks = sqliteTable('r2_locks', {
  scope: text('scope').primaryKey(),
  holderId: text('holder_id').notNull(),
  acquiredAt: integer('acquired_at').notNull(),
  expiresAt: integer('expires_at').notNull(),
}, t => [
  index('idx_r2_locks_expires').on(t.expiresAt),
])

export type R2LockInsert = typeof r2Locks.$inferInsert
export type R2LockSelect = typeof r2Locks.$inferSelect

// Per-(user, site, table) newest/oldest synced dates. Written post-flush;
// read by backfill + status endpoints.
export const r2Watermarks = sqliteTable('r2_watermarks', {
  userId: integer('user_id').notNull(),
  siteId: text('site_id').notNull().default(''),
  table: text('table').notNull(),
  newestDateSynced: text('newest_date_synced').notNull(),
  oldestDateSynced: text('oldest_date_synced').notNull(),
  lastSyncAt: integer('last_sync_at').notNull(),
}, t => [
  primaryKey({ columns: [t.userId, t.siteId, t.table] }),
])

export type R2WatermarkInsert = typeof r2Watermarks.$inferInsert
export type R2WatermarkSelect = typeof r2Watermarks.$inferSelect

// Per-(user, site, table, date, searchType) pipeline state for idempotent sync.
// PK includes search_type so non-web slice (discover/news/etc.) syncs don't
// collide with the web slice for the same (user, site, table, date).
// Legacy rows default to '' which inferSearchType normalises to 'web'.
export const r2SyncStates = sqliteTable('r2_sync_states', {
  userId: integer('user_id').notNull(),
  siteId: text('site_id').notNull().default(''),
  table: text('table').notNull(),
  date: text('date').notNull(),
  searchType: text('search_type').notNull().default(''),
  state: text('state', { enum: ['pending', 'inflight', 'done', 'failed'] }).notNull(),
  updatedAt: integer('updated_at').notNull(),
  attempts: integer('attempts').notNull().default(0),
  error: text('error'),
}, t => [
  primaryKey({ columns: [t.userId, t.siteId, t.table, t.date, t.searchType] }),
  index('idx_r2_sync_states_state').on(t.state),
])

export type R2SyncStateInsert = typeof r2SyncStates.$inferInsert
export type R2SyncStateSelect = typeof r2SyncStates.$inferSelect

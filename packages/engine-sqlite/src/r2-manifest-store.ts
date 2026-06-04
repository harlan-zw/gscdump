import type {
  CompactionTier,
  ListLiveFilter,
  LockScope,
  ManifestEntry,
  ManifestStore,
  SearchType,
  SyncState,
  SyncStateDetail,
  SyncStateFilter,
  SyncStateKind,
  SyncStateScope,
  TableName,
  Watermark,
  WatermarkFilter,
  WatermarkScope,
} from '@gscdump/engine'
import type { BatchItem } from 'drizzle-orm/batch'
import type { DrizzleD1Database } from 'drizzle-orm/d1'
import { inferSearchType } from '@gscdump/engine'
import { engineErrors, engineErrorToException } from '@gscdump/engine/errors'
import { and, eq, inArray, isNotNull, isNull, lt, lte, or, sql } from 'drizzle-orm'
import { r2Locks, r2Manifest, r2SyncStates, r2Watermarks } from './r2-manifest-schema'

// Minimal DB contract — we only need .select / .insert / .update / .delete / .batch
// over the four tables the store touches. DrizzleD1Database covers all of them
// plus the batch() method we use for atomic registerVersion flows.
export type AnalyticsManifestDb = DrizzleD1Database<{
  r2Manifest: typeof r2Manifest
  r2Locks: typeof r2Locks
  r2SyncStates: typeof r2SyncStates
  r2Watermarks: typeof r2Watermarks
}>

// D1-backed ManifestStore. Atomicity contract:
// - registerVersion(s) retires `superseding` entries and inserts new entries in one D1 batch.
// - listLive filters retiredAt IS NULL.
// - delete removes rows permanently (after R2 objects themselves are deleted by caller).

function toRow(e: ManifestEntry): typeof r2Manifest.$inferInsert {
  return {
    id: e.objectKey, // object_key is globally unique; use it as primary key
    userId: Number(e.userId),
    siteId: e.siteId ?? null,
    table: e.table,
    partition: e.partition,
    objectKey: e.objectKey,
    rowCount: e.rowCount,
    bytes: e.bytes,
    createdAt: e.createdAt,
    retiredAt: e.retiredAt ?? null,
    tier: e.tier ?? null,
    searchType: e.searchType ?? null,
    schemaVersion: e.schemaVersion ?? null,
  }
}

function fromRow(r: typeof r2Manifest.$inferSelect): ManifestEntry {
  return {
    userId: String(r.userId),
    siteId: r.siteId ?? undefined,
    table: r.table as TableName,
    partition: r.partition,
    objectKey: r.objectKey,
    rowCount: r.rowCount,
    bytes: r.bytes,
    createdAt: r.createdAt,
    retiredAt: r.retiredAt ?? undefined,
    ...(r.tier !== null ? { tier: r.tier as CompactionTier } : {}),
    ...(r.searchType !== null ? { searchType: r.searchType as SearchType } : {}),
    ...(r.schemaVersion !== null ? { schemaVersion: r.schemaVersion } : {}),
  }
}

// Empty-string sentinel: composite PKs on r2_watermarks / r2_sync_states mark
// site_id NOT NULL with default ''. Core passes `siteId?: string | undefined`;
// we coerce here so "" acts as the single canonical scope when no site is set.
const siteIdOf = (s: string | undefined): string => s ?? ''

// searchType sentinel: empty string stores the legacy/`web` slice; other
// values persist verbatim. Reads use inferSearchType() to normalise back.
const searchTypeOf = (s: SearchType | undefined): string => (s === undefined || s === 'web' ? '' : s)

// Lease TTL for r2_locks. Most writes complete sub-second; 30s covers
// compaction on fat partitions without needing a heartbeat in this pass.
const LOCK_TTL_MS = 30_000
const LOCK_ACQUIRE_TIMEOUT_MS = 5_000
const LOCK_RETRY_MIN_MS = 25
const LOCK_RETRY_MAX_MS = 150

function lockScopeKey(scope: LockScope): string {
  return `${scope.userId}|${siteIdOf(scope.siteId)}|${scope.table}|${scope.partition}`
}

function jitterDelay(): number {
  return LOCK_RETRY_MIN_MS + Math.floor(Math.random() * (LOCK_RETRY_MAX_MS - LOCK_RETRY_MIN_MS))
}

// Legacy entries written before `tier` was persisted resolve via
// inferLegacyTier: daily/* → raw, monthly/* → d30. Anything else with a
// null tier is excluded from tier-filtered reads (matches the engine
// behaviour where inferLegacyTier returns undefined for unknown shapes).
function tierMatchCond(target: CompactionTier): ReturnType<typeof or> | ReturnType<typeof eq> {
  const explicit = eq(r2Manifest.tier, target)
  if (target === 'raw')
    return or(explicit, and(isNull(r2Manifest.tier), sql`${r2Manifest.partition} LIKE 'daily/%'`))
  if (target === 'd30')
    return or(explicit, and(isNull(r2Manifest.tier), sql`${r2Manifest.partition} LIKE 'monthly/%'`))
  return explicit
}

export function createD1ManifestStore(db: AnalyticsManifestDb): ManifestStore {
  async function listByFilter(filter: ListLiveFilter, liveOnly: boolean): Promise<ManifestEntry[]> {
    const baseConds = [eq(r2Manifest.userId, Number(filter.userId))]
    if (liveOnly)
      baseConds.push(isNull(r2Manifest.retiredAt))
    if (filter.siteId !== undefined)
      baseConds.push(eq(r2Manifest.siteId, filter.siteId))
    if (filter.table !== undefined)
      baseConds.push(eq(r2Manifest.table, filter.table))
    if (filter.tier !== undefined) {
      const cond = tierMatchCond(filter.tier)
      if (cond)
        baseConds.push(cond)
    }
    if (filter.searchType !== undefined) {
      // r2_manifest.searchType is nullable text (unlike r2_sync_states.searchType
      // which uses '' as a NOT NULL sentinel). Entries written before the column
      // landed, or via writeDay with `ctx.searchType` omitted, store NULL — those
      // are the legacy/web cohort and must match a `searchType: 'web'` filter.
      // Explicit 'web' writes store the literal 'web'; accept both.
      baseConds.push(
        filter.searchType === 'web'
          ? or(eq(r2Manifest.searchType, 'web'), isNull(r2Manifest.searchType))!
          : eq(r2Manifest.searchType, filter.searchType),
      )
    }

    // D1 has a 100-bound-param-per-query limit. Chunk partition IN-clauses
    // (each value is one bound param) to stay safely under that ceiling
    // while leaving headroom for the other conditions above. A multi-month
    // date range expands to 200+ partitions across daily/weekly/monthly/quarterly tiers.
    const PARTITION_CHUNK = 80
    if (filter.partitions && filter.partitions.length > 0) {
      const out: ManifestEntry[] = []
      for (let i = 0; i < filter.partitions.length; i += PARTITION_CHUNK) {
        const slice = filter.partitions.slice(i, i + PARTITION_CHUNK)
        const conds = [...baseConds, inArray(r2Manifest.partition, slice)]
        const rows = await db.select().from(r2Manifest).where(and(...conds))
        for (const r of rows) out.push(fromRow(r))
      }
      return out
    }

    const rows = await db.select().from(r2Manifest).where(and(...baseConds))
    return rows.map(fromRow)
  }

  const listLive = (filter: ListLiveFilter): Promise<ManifestEntry[]> => listByFilter(filter, true)
  const listAll = (filter: ListLiveFilter): Promise<ManifestEntry[]> => listByFilter(filter, false)

  async function registerVersions(
    newEntries: ManifestEntry[],
    superseding?: ManifestEntry[],
  ): Promise<void> {
    const supersededAt = newEntries[0]?.createdAt ?? Date.now()
    const statements: BatchItem<'sqlite'>[] = []

    if (superseding && superseding.length > 0) {
      const keys = superseding.map(s => s.objectKey)
      // D1_BATCH_LIMIT = 95; chunk if needed
      const CHUNK = 90
      for (let i = 0; i < keys.length; i += CHUNK) {
        const slice = keys.slice(i, i + CHUNK)
        statements.push(
          db.update(r2Manifest)
            .set({ retiredAt: supersededAt })
            .where(and(inArray(r2Manifest.objectKey, slice), isNull(r2Manifest.retiredAt))),
        )
      }
    }

    for (const e of newEntries) {
      statements.push(
        db.insert(r2Manifest)
          .values(toRow(e))
          .onConflictDoUpdate({
            target: r2Manifest.objectKey,
            set: {
              userId: sql`excluded.user_id`,
              siteId: sql`excluded.site_id`,
              // `table` is a SQLite reserved word — must be quoted.
              table: sql`excluded."table"`,
              partition: sql`excluded.partition`,
              rowCount: sql`excluded.row_count`,
              bytes: sql`excluded.bytes`,
              createdAt: sql`excluded.created_at`,
              retiredAt: sql`excluded.retired_at`,
              tier: sql`excluded.tier`,
              searchType: sql`excluded.search_type`,
              schemaVersion: sql`excluded.schema_version`,
            },
          }),
      )
    }

    if (statements.length === 0)
      return
    // Always go through db.batch() so D1 runs everything atomically.
    // The single-statement "await builder" path was silently producing
    // "Failed query" errors without a stack — batch() returns the real
    // D1 error (e.g. UNIQUE constraint failed) and is transactional.
    const BATCH_LIMIT = 95
    for (let i = 0; i < statements.length; i += BATCH_LIMIT) {
      const chunk = statements.slice(i, i + BATCH_LIMIT) as [BatchItem<'sqlite'>, ...BatchItem<'sqlite'>[]]
      await db.batch(chunk)
    }
  }

  async function listRetired(olderThan: number): Promise<ManifestEntry[]> {
    const rows = await db.select().from(r2Manifest).where(
      and(isNotNull(r2Manifest.retiredAt), lte(r2Manifest.retiredAt, olderThan)),
    )
    return rows.map(fromRow)
  }

  async function deleteEntries(entries: ManifestEntry[]): Promise<void> {
    if (entries.length === 0)
      return
    const keys = entries.map(e => e.objectKey)
    const CHUNK = 90
    for (let i = 0; i < keys.length; i += CHUNK)
      await db.delete(r2Manifest).where(inArray(r2Manifest.objectKey, keys.slice(i, i + CHUNK)))
  }

  async function getWatermarks(filter: WatermarkFilter): Promise<Watermark[]> {
    const conds = [eq(r2Watermarks.userId, Number(filter.userId))]
    if (filter.siteId !== undefined)
      conds.push(eq(r2Watermarks.siteId, filter.siteId))
    if (filter.table !== undefined)
      conds.push(eq(r2Watermarks.table, filter.table))
    const rows = await db.select().from(r2Watermarks).where(and(...conds))
    return rows.map(r => ({
      userId: String(r.userId),
      siteId: r.siteId === '' ? undefined : r.siteId,
      table: r.table as TableName,
      newestDateSynced: r.newestDateSynced,
      oldestDateSynced: r.oldestDateSynced,
      lastSyncAt: r.lastSyncAt,
    }))
  }

  async function bumpWatermark(scope: WatermarkScope, date: string, at?: number): Promise<void> {
    const lastSyncAt = at ?? Date.now()
    await db.insert(r2Watermarks).values({
      userId: Number(scope.userId),
      siteId: siteIdOf(scope.siteId),
      table: scope.table,
      newestDateSynced: date,
      oldestDateSynced: date,
      lastSyncAt,
    }).onConflictDoUpdate({
      target: [r2Watermarks.userId, r2Watermarks.siteId, r2Watermarks.table],
      set: {
        newestDateSynced: sql`CASE WHEN excluded.newest_date_synced > newest_date_synced THEN excluded.newest_date_synced ELSE newest_date_synced END`,
        oldestDateSynced: sql`CASE WHEN excluded.oldest_date_synced < oldest_date_synced THEN excluded.oldest_date_synced ELSE oldest_date_synced END`,
        lastSyncAt: sql`excluded.last_sync_at`,
      },
    }).run()
  }

  async function getSyncStates(filter: SyncStateFilter): Promise<SyncState[]> {
    const conds = [eq(r2SyncStates.userId, Number(filter.userId))]
    if (filter.siteId !== undefined)
      conds.push(eq(r2SyncStates.siteId, filter.siteId))
    if (filter.table !== undefined)
      conds.push(eq(r2SyncStates.table, filter.table))
    if (filter.state !== undefined)
      conds.push(eq(r2SyncStates.state, filter.state))
    if (filter.searchType !== undefined)
      conds.push(eq(r2SyncStates.searchType, searchTypeOf(filter.searchType)))
    const rows = await db.select().from(r2SyncStates).where(and(...conds))
    return rows.map(r => ({
      userId: String(r.userId),
      siteId: r.siteId === '' ? undefined : r.siteId,
      table: r.table as TableName,
      date: r.date,
      searchType: inferSearchType({ searchType: r.searchType === '' ? undefined : r.searchType as SearchType }),
      state: r.state as SyncStateKind,
      updatedAt: r.updatedAt,
      attempts: r.attempts,
      error: r.error ?? undefined,
    }))
  }

  async function setSyncState(
    scope: SyncStateScope,
    state: SyncStateKind,
    detail?: SyncStateDetail,
  ): Promise<void> {
    const updatedAt = detail?.at ?? Date.now()
    const errorText = detail?.error ?? null
    // attempts increments only when we transition into inflight; done/failed
    // keep the prior count. Use CASE in the ON CONFLICT UPDATE.
    await db.insert(r2SyncStates).values({
      userId: Number(scope.userId),
      siteId: siteIdOf(scope.siteId),
      table: scope.table,
      date: scope.date,
      searchType: searchTypeOf(scope.searchType),
      state,
      updatedAt,
      attempts: state === 'inflight' ? 1 : 0,
      error: errorText,
    }).onConflictDoUpdate({
      target: [r2SyncStates.userId, r2SyncStates.siteId, r2SyncStates.table, r2SyncStates.date, r2SyncStates.searchType],
      set: {
        state: sql`excluded.state`,
        updatedAt: sql`excluded.updated_at`,
        attempts: sql`CASE WHEN excluded.state = 'inflight' THEN attempts + 1 ELSE attempts END`,
        // Clear error only on success. On inflight re-entry, preserve the
        // prior error (otherwise a retry that hasn't surfaced a new error
        // wipes the diagnostic from the last real failure). On failed,
        // overwrite with the fresh error.
        error: sql`CASE
          WHEN excluded.state = 'done' THEN NULL
          WHEN excluded.state = 'inflight' THEN error
          ELSE excluded.error
        END`,
      },
    }).run()
  }

  async function withLock<T>(scope: LockScope, fn: () => Promise<T>): Promise<T> {
    const key = lockScopeKey(scope)
    const holderId = crypto.randomUUID()
    const deadline = Date.now() + LOCK_ACQUIRE_TIMEOUT_MS

    // Acquire: insert the lock row, or steal if the existing lease is expired.
    // The WHERE on the ON CONFLICT UPDATE only overwrites when expires_at < now,
    // so live holders aren't dispossessed. After each attempt we read back and
    // confirm we own the row (holder_id == our id).
    while (true) {
      const now = Date.now()
      const expiresAt = now + LOCK_TTL_MS

      await db.insert(r2Locks).values({
        scope: key,
        holderId,
        acquiredAt: now,
        expiresAt,
      }).onConflictDoUpdate({
        target: r2Locks.scope,
        set: {
          holderId: sql`excluded.holder_id`,
          acquiredAt: sql`excluded.acquired_at`,
          expiresAt: sql`excluded.expires_at`,
        },
        setWhere: lt(r2Locks.expiresAt, now),
      }).run()

      const row = await db.select({ holderId: r2Locks.holderId })
        .from(r2Locks)
        .where(eq(r2Locks.scope, key))
        .get()

      if (row?.holderId === holderId)
        break

      if (Date.now() >= deadline)
        throw engineErrorToException(engineErrors.lockAcquireTimeout(key, LOCK_ACQUIRE_TIMEOUT_MS))

      await new Promise(resolve => setTimeout(resolve, jitterDelay()))
    }

    return await fn().finally(async () => {
      // Release failure is safe: expired lease is reclaimable on next acquire.
      // Wrap through Promise.resolve so the better-sqlite3 test driver
      // (which returns sync objects) and the D1 driver (async) both work.
      await Promise.resolve(
        db.delete(r2Locks)
          .where(and(eq(r2Locks.scope, key), eq(r2Locks.holderId, holderId)))
          .run(),
      ).catch(() => {})
    })
  }

  async function purgeTenant(filter: { userId: string, siteId?: string }): Promise<{
    entriesRemoved: number
    watermarksRemoved: number
    syncStatesRemoved: number
  }> {
    const userIdNum = Number(filter.userId)
    const entriesCond = filter.siteId !== undefined
      ? and(eq(r2Manifest.userId, userIdNum), eq(r2Manifest.siteId, filter.siteId))
      : eq(r2Manifest.userId, userIdNum)
    const watermarksCond = filter.siteId !== undefined
      ? and(eq(r2Watermarks.userId, userIdNum), eq(r2Watermarks.siteId, filter.siteId))
      : eq(r2Watermarks.userId, userIdNum)
    const syncStatesCond = filter.siteId !== undefined
      ? and(eq(r2SyncStates.userId, userIdNum), eq(r2SyncStates.siteId, filter.siteId))
      : eq(r2SyncStates.userId, userIdNum)

    const [entriesRows, watermarkRows, syncStateRows] = await Promise.all([
      db.select({ n: sql<number>`count(*)` }).from(r2Manifest).where(entriesCond).all(),
      db.select({ n: sql<number>`count(*)` }).from(r2Watermarks).where(watermarksCond).all(),
      db.select({ n: sql<number>`count(*)` }).from(r2SyncStates).where(syncStatesCond).all(),
    ])
    const entriesRemoved = Number(entriesRows[0]?.n ?? 0)
    const watermarksRemoved = Number(watermarkRows[0]?.n ?? 0)
    const syncStatesRemoved = Number(syncStateRows[0]?.n ?? 0)

    await db.batch([
      db.delete(r2Manifest).where(entriesCond),
      db.delete(r2Watermarks).where(watermarksCond),
      db.delete(r2SyncStates).where(syncStatesCond),
    ] as unknown as [BatchItem<'sqlite'>, ...BatchItem<'sqlite'>[]])

    return { entriesRemoved, watermarksRemoved, syncStatesRemoved }
  }

  return {
    listLive,
    listAll,
    registerVersion: (entry, superseding) => registerVersions([entry], superseding),
    registerVersions,
    listRetired,
    delete: deleteEntries,
    getWatermarks,
    bumpWatermark,
    getSyncStates,
    setSyncState,
    withLock,
    purgeTenant,
  }
}

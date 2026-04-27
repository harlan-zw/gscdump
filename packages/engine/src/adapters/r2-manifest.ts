// R2-native ManifestStore. Authoritative manifest lives in R2 as a
// pair of objects per (siteId, table) shard:
//
//   u_<userId>/manifest/<siteId>/<table>/HEAD          — one-line snapshot key
//   u_<userId>/manifest/<siteId>/<table>/v<ts>-<id>.json — immutable snapshot
//
// Concurrent writers serialize via R2's `If-Match` conditional PUT on
// HEAD (Workers binding `onlyIf.etagMatches`). On 412 the writer re-reads
// the new HEAD, replays its mutation, and retries. Snapshots are immutable
// so readers can cache them forever.
//
// Sharding per (siteId, table) sidesteps R2's 1-write/sec-per-key cap when
// multi-table sync runs concurrently. Cross-shard reads page through R2
// LIST under the per-user `manifest/` prefix.
//
// `withLock` is a no-op: the engine's atomicity contract is enforced by
// the conditional-PUT on `registerVersion` rather than a coarse cross-
// process lock. GC's grace window covers the gap between `dataSource.write`
// and `registerVersion`.

import type {
  ListLiveFilter,
  LockScope,
  ManifestEntry,
  ManifestStore,
  SyncState,
  SyncStateDetail,
  SyncStateFilter,
  SyncStateKind,
  SyncStateScope,
  TableName,
  Watermark,
  WatermarkFilter,
  WatermarkScope,
} from '../storage'
import { inferLegacyTier, inferSearchType } from '../storage'

/** Shape of the JSON snapshot held under each shard's `v<ts>-<id>.json` key. */
interface ManifestSnapshot {
  version: 1
  entries: ManifestEntry[]
  watermarks: Watermark[]
  syncStates: SyncState[]
}

interface R2ObjectMetadata {
  etag: string
}

interface R2ObjectBody extends R2ObjectMetadata {
  text: () => Promise<string>
}

interface R2ListResult {
  objects: Array<{ key: string }>
  truncated: boolean
  cursor?: string
}

interface R2ConditionalPutOptions {
  /**
   * Workers-binding-style precondition. `etagMatches` rejects with `null`
   *  return on mismatch; `etagDoesNotMatch: '*'` rejects if the key exists.
   */
  onlyIf?: { etagMatches?: string, etagDoesNotMatch?: string }
}

/**
 * Minimal Cloudflare R2 binding shape needed for the manifest CAS loop.
 * Structurally compatible with Cloudflare's `R2Bucket` Workers API.
 */
export interface R2ManifestBucketLike {
  get: (key: string) => Promise<R2ObjectBody | null>
  put: (
    key: string,
    bytes: string | Uint8Array,
    options?: R2ConditionalPutOptions,
  ) => Promise<R2ObjectMetadata | null>
  list: (options?: { prefix?: string, cursor?: string, limit?: number }) => Promise<R2ListResult>
  /**
   * Bulk delete. Required by {@link ManifestStore.purgeTenant}. Cloudflare's
   * `R2Bucket.delete` accepts a single key or a string[] batch; both shapes
   * work here.
   */
  delete: (keys: string | string[]) => Promise<void>
}

/**
 * CAS lifecycle events emitted by the manifest store. Consumers wire these
 * into metrics (prom-client, console.table, the contention harness) to
 * measure rejection rate and latency under real R2 load.
 */
export type R2ManifestEvent
  = | { kind: 'cas-attempt', siteId: string, table: TableName, attempt: number }
    | { kind: 'cas-rejected', siteId: string, table: TableName, attempt: number }
    | { kind: 'cas-committed', siteId: string, table: TableName, attempts: number }

export interface CreateR2ManifestStoreOptions {
  bucket: R2ManifestBucketLike
  /** Tenant scope. All shard keys are prefixed `u_<userId>/manifest/...`. */
  userId: string
  /** Override the snapshot version-id generator. Defaults to `${ts}-${random}`. */
  newSnapshotId?: () => string
  now?: () => number
  /** Maximum CAS retries before giving up. Defaults to 8. */
  maxRetries?: number
  /**
   * Optional telemetry hook. Fired synchronously from the CAS loop on each
   * attempt, rejection, and successful commit. Must not throw; exceptions
   * propagate and will fail the mutation.
   */
  onEvent?: (event: R2ManifestEvent) => void
}

const SHARD_RE = /^u_[^/]+\/manifest\/(?<siteId>[^/]+)\/(?<table>[^/]+)\/HEAD$/

function defaultSnapshotId(): string {
  const ts = Date.now()
  const rnd = Math.random().toString(36).slice(2, 10)
  return `${ts}-${rnd}`
}

function shardPrefix(userId: string, siteId: string, table: TableName): string {
  return `u_${userId}/manifest/${siteId}/${table}/`
}

function headKey(userId: string, siteId: string, table: TableName): string {
  return `${shardPrefix(userId, siteId, table)}HEAD`
}

function snapshotKey(userId: string, siteId: string, table: TableName, snapshotId: string): string {
  return `${shardPrefix(userId, siteId, table)}v${snapshotId}.json`
}

function emptySnapshot(): ManifestSnapshot {
  return { version: 1, entries: [], watermarks: [], syncStates: [] }
}

function shardScopesFromEntries(entries: readonly ManifestEntry[]): Set<string> {
  const out = new Set<string>()
  for (const e of entries) {
    if (e.siteId === undefined)
      throw new Error('R2 manifest store requires entries to carry siteId; cross-site entries are unshardable')
    out.add(`${e.siteId}\0${e.table}`)
  }
  return out
}

function matchesEntryFilter(entry: ManifestEntry, filter: ListLiveFilter): boolean {
  if (filter.siteId !== undefined && entry.siteId !== filter.siteId)
    return false
  if (filter.table !== undefined && entry.table !== filter.table)
    return false
  if (filter.partitions && !filter.partitions.includes(entry.partition))
    return false
  if (filter.tier !== undefined && inferLegacyTier(entry) !== filter.tier)
    return false
  return true
}

function matchesWatermarkFilter(w: Watermark, filter: WatermarkFilter): boolean {
  if (filter.siteId !== undefined && w.siteId !== filter.siteId)
    return false
  if (filter.table !== undefined && w.table !== filter.table)
    return false
  return true
}

function matchesSyncStateFilter(s: SyncState, filter: SyncStateFilter): boolean {
  if (filter.siteId !== undefined && s.siteId !== filter.siteId)
    return false
  if (filter.table !== undefined && s.table !== filter.table)
    return false
  if (filter.state !== undefined && s.state !== filter.state)
    return false
  if (filter.searchType !== undefined && inferSearchType(s) !== filter.searchType)
    return false
  return true
}

export function createR2ManifestStore(opts: CreateR2ManifestStoreOptions): ManifestStore {
  const { bucket, userId } = opts
  const newSnapshotId = opts.newSnapshotId ?? defaultSnapshotId
  const now = opts.now ?? (() => Date.now())
  const maxRetries = opts.maxRetries ?? 8
  const onEvent = opts.onEvent

  async function readShard(siteId: string, table: TableName): Promise<{
    snapshot: ManifestSnapshot
    headEtag: string | undefined
  }> {
    const head = await bucket.get(headKey(userId, siteId, table))
    if (!head)
      return { snapshot: emptySnapshot(), headEtag: undefined }
    const snapshotId = (await head.text()).trim()
    if (!snapshotId)
      return { snapshot: emptySnapshot(), headEtag: head.etag }
    const snap = await bucket.get(snapshotKey(userId, siteId, table, snapshotId))
    if (!snap)
      // HEAD points at a missing snapshot — treat as empty and let the next
      // CAS overwrite. Rare; happens only if a snapshot was manually deleted.
      return { snapshot: emptySnapshot(), headEtag: head.etag }
    const parsed = JSON.parse(await snap.text()) as ManifestSnapshot
    if (parsed.version !== 1)
      throw new Error(`unsupported manifest snapshot version: ${parsed.version}`)
    return { snapshot: parsed, headEtag: head.etag }
  }

  async function writeShard(
    siteId: string,
    table: TableName,
    snapshot: ManifestSnapshot,
    headEtag: string | undefined,
  ): Promise<{ ok: boolean }> {
    const id = newSnapshotId()
    const snapKey = snapshotKey(userId, siteId, table, id)
    // Snapshot is immutable; no precondition needed.
    await bucket.put(snapKey, JSON.stringify(snapshot))
    const conditional: R2ConditionalPutOptions = headEtag
      ? { onlyIf: { etagMatches: headEtag } }
      : { onlyIf: { etagDoesNotMatch: '*' } }
    const result = await bucket.put(headKey(userId, siteId, table), id, conditional)
    return { ok: result !== null }
  }

  async function mutateShard(
    siteId: string,
    table: TableName,
    mutate: (snapshot: ManifestSnapshot) => void | Promise<void>,
  ): Promise<void> {
    let attempt = 0
    while (attempt < maxRetries) {
      onEvent?.({ kind: 'cas-attempt', siteId, table, attempt })
      const { snapshot, headEtag } = await readShard(siteId, table)
      await mutate(snapshot)
      const { ok } = await writeShard(siteId, table, snapshot, headEtag)
      if (ok) {
        onEvent?.({ kind: 'cas-committed', siteId, table, attempts: attempt + 1 })
        return
      }
      onEvent?.({ kind: 'cas-rejected', siteId, table, attempt })
      attempt++
    }
    throw new Error(`R2 manifest CAS exceeded ${maxRetries} retries for ${siteId}/${table}`)
  }

  async function listShards(): Promise<Array<{ siteId: string, table: TableName }>> {
    const shards: Array<{ siteId: string, table: TableName }> = []
    let cursor: string | undefined
    do {
      const res = await bucket.list({ prefix: `u_${userId}/manifest/`, cursor, limit: 1000 })
      for (const obj of res.objects) {
        const m = SHARD_RE.exec(obj.key)
        if (m?.groups)
          shards.push({ siteId: m.groups.siteId!, table: m.groups.table as TableName })
      }
      cursor = res.truncated ? res.cursor : undefined
    } while (cursor)
    return shards
  }

  async function shardsForFilter(filter: { siteId?: string, table?: TableName }): Promise<
    Array<{ siteId: string, table: TableName }>
  > {
    if (filter.siteId !== undefined && filter.table !== undefined)
      return [{ siteId: filter.siteId, table: filter.table }]
    const all = await listShards()
    return all.filter(s =>
      (filter.siteId === undefined || s.siteId === filter.siteId)
      && (filter.table === undefined || s.table === filter.table),
    )
  }

  async function readEntriesAcrossShards(
    filter: ListLiveFilter,
    includeRetired: boolean,
  ): Promise<ManifestEntry[]> {
    const shards = await shardsForFilter(filter)
    const all: ManifestEntry[] = []
    for (const { siteId, table } of shards) {
      const { snapshot } = await readShard(siteId, table)
      for (const entry of snapshot.entries) {
        if (!includeRetired && entry.retiredAt !== undefined)
          continue
        if (matchesEntryFilter(entry, filter))
          all.push(entry)
      }
    }
    return all
  }

  function groupBySiteTable(entries: readonly ManifestEntry[]): Map<string, ManifestEntry[]> {
    const out = new Map<string, ManifestEntry[]>()
    for (const e of entries) {
      const key = `${e.siteId}\0${e.table}`
      if (!out.has(key))
        out.set(key, [])
      out.get(key)!.push(e)
    }
    return out
  }

  async function registerVersionsImpl(
    newEntries: ManifestEntry[],
    superseding?: ManifestEntry[],
  ): Promise<void> {
    if (newEntries.length === 0 && (!superseding || superseding.length === 0))
      return
    const supersededAt = newEntries[0]?.createdAt ?? now()

    // Group both new and superseded by shard so each (siteId, table) is one CAS.
    const byShard = new Map<string, { newEntries: ManifestEntry[], superseding: ManifestEntry[] }>()
    function bucket(entry: ManifestEntry, kind: 'new' | 'super'): void {
      if (entry.siteId === undefined)
        throw new Error('R2 manifest store requires entries to carry siteId')
      const key = `${entry.siteId}\0${entry.table}`
      let bag = byShard.get(key)
      if (!bag) {
        bag = { newEntries: [], superseding: [] }
        byShard.set(key, bag)
      }
      if (kind === 'new')
        bag.newEntries.push(entry)
      else
        bag.superseding.push(entry)
    }
    for (const e of newEntries) bucket(e, 'new')
    if (superseding) {
      for (const e of superseding) bucket(e, 'super')
    }

    for (const [shardKey, { newEntries: news, superseding: supers }] of byShard) {
      const [siteId, table] = shardKey.split('\0') as [string, TableName]
      await mutateShard(siteId, table, (snap) => {
        const byObjectKey = new Map(snap.entries.map(e => [e.objectKey, e]))
        for (const s of supers) {
          const existing = byObjectKey.get(s.objectKey)
          if (existing && existing.retiredAt === undefined)
            byObjectKey.set(s.objectKey, { ...existing, retiredAt: supersededAt })
        }
        for (const n of news) byObjectKey.set(n.objectKey, n)
        snap.entries = Array.from(byObjectKey.values())
      })
    }
  }

  return {
    async listLive(filter) {
      return readEntriesAcrossShards(filter, /* includeRetired */ false)
    },

    async listAll(filter) {
      return readEntriesAcrossShards(filter, /* includeRetired */ true)
    },

    async registerVersion(entry, superseding) {
      return registerVersionsImpl([entry], superseding)
    },

    async registerVersions(entries, superseding) {
      // The contract allows mixed-shard input. We split by shard above so
      // each shard sees one CAS; the public call may touch N shards.
      // Caller responsible for ordering across shards.
      const _ = shardScopesFromEntries(entries) // surfaces missing siteId early
      void _
      return registerVersionsImpl(entries, superseding)
    },

    async listRetired(olderThan) {
      const shards = await listShards()
      const out: ManifestEntry[] = []
      for (const { siteId, table } of shards) {
        const { snapshot } = await readShard(siteId, table)
        for (const e of snapshot.entries) {
          if (e.retiredAt !== undefined && e.retiredAt <= olderThan)
            out.push(e)
        }
      }
      return out
    },

    async delete(toDelete) {
      const grouped = groupBySiteTable(toDelete)
      for (const [shardKey, entries] of grouped) {
        const [siteId, table] = shardKey.split('\0') as [string, TableName]
        await mutateShard(siteId, table, (snap) => {
          const drop = new Set(entries.map(e => e.objectKey))
          snap.entries = snap.entries.filter(e => !drop.has(e.objectKey))
        })
      }
    },

    async getWatermarks(filter) {
      const shards = await shardsForFilter(filter)
      const out: Watermark[] = []
      for (const { siteId, table } of shards) {
        const { snapshot } = await readShard(siteId, table)
        for (const w of snapshot.watermarks) {
          if (matchesWatermarkFilter(w, filter))
            out.push(w)
        }
      }
      return out
    },

    async bumpWatermark(scope: WatermarkScope, date: string, at?: number) {
      if (scope.siteId === undefined)
        throw new Error('R2 manifest store requires watermarks to carry siteId')
      const ts = at ?? now()
      await mutateShard(scope.siteId, scope.table, (snap) => {
        const idx = snap.watermarks.findIndex(w =>
          w.userId === userId
          && w.siteId === scope.siteId
          && w.table === scope.table,
        )
        if (idx === -1) {
          snap.watermarks.push({
            userId,
            siteId: scope.siteId,
            table: scope.table,
            newestDateSynced: date,
            oldestDateSynced: date,
            lastSyncAt: ts,
          })
          return
        }
        const w = snap.watermarks[idx]!
        const newest = date > w.newestDateSynced ? date : w.newestDateSynced
        const oldest = date < w.oldestDateSynced ? date : w.oldestDateSynced
        const lastSyncAt = ts > w.lastSyncAt ? ts : w.lastSyncAt
        snap.watermarks[idx] = { ...w, newestDateSynced: newest, oldestDateSynced: oldest, lastSyncAt }
      })
    },

    async getSyncStates(filter) {
      const shards = await shardsForFilter(filter)
      const out: SyncState[] = []
      for (const { siteId, table } of shards) {
        const { snapshot } = await readShard(siteId, table)
        for (const s of snapshot.syncStates) {
          if (matchesSyncStateFilter(s, filter))
            out.push(s)
        }
      }
      return out
    },

    async setSyncState(scope: SyncStateScope, state: SyncStateKind, detail?: SyncStateDetail) {
      if (scope.siteId === undefined)
        throw new Error('R2 manifest store requires sync states to carry siteId')
      const at = detail?.at ?? now()
      const scopeSearchType = inferSearchType(scope)
      await mutateShard(scope.siteId, scope.table, (snap) => {
        const idx = snap.syncStates.findIndex(s =>
          s.userId === userId
          && s.siteId === scope.siteId
          && s.table === scope.table
          && s.date === scope.date
          && inferSearchType(s) === scopeSearchType,
        )
        if (idx === -1) {
          snap.syncStates.push({
            userId,
            siteId: scope.siteId,
            table: scope.table,
            date: scope.date,
            state,
            updatedAt: at,
            attempts: 1,
            error: detail?.error,
            ...(scope.searchType !== undefined ? { searchType: scope.searchType } : {}),
          })
          return
        }
        const prev = snap.syncStates[idx]!
        const attempts = state === 'inflight' && prev.state !== 'inflight' ? prev.attempts + 1 : prev.attempts
        const error = state === 'done' ? undefined : (detail?.error ?? prev.error)
        snap.syncStates[idx] = {
          ...prev,
          state,
          updatedAt: at,
          attempts,
          error,
        }
      })
    },

    /**
     * No-op. The R2 manifest's CAS loop on `registerVersion` provides
     * single-writer serialization per (siteId, table) shard. Cross-process
     * lock semantics aren't representable on R2 directly; use a Durable
     * Object or D1 lock table if needed.
     */
    async withLock<T>(_scope: LockScope, fn: () => Promise<T>): Promise<T> {
      return fn()
    },

    async purgeTenant(filter) {
      if (filter.userId !== userId)
        throw new Error(`purgeTenant: store is scoped to userId=${userId}, got ${filter.userId}`)
      const shards = await shardsForFilter({ siteId: filter.siteId })
      let entriesRemoved = 0
      let watermarksRemoved = 0
      let syncStatesRemoved = 0
      for (const { siteId, table } of shards) {
        const { snapshot } = await readShard(siteId, table)
        entriesRemoved += snapshot.entries.length
        watermarksRemoved += snapshot.watermarks.length
        syncStatesRemoved += snapshot.syncStates.length
        // Drop every object under the shard prefix: HEAD + all immutable
        // snapshot files. Paginate in case historical snapshots accumulated.
        const prefix = shardPrefix(userId, siteId, table)
        const keys: string[] = []
        let cursor: string | undefined
        do {
          const res = await bucket.list({ prefix, cursor, limit: 1000 })
          for (const obj of res.objects) keys.push(obj.key)
          cursor = res.truncated ? res.cursor : undefined
        } while (cursor)
        if (keys.length > 0)
          await bucket.delete(keys)
      }
      return { entriesRemoved, watermarksRemoved, syncStatesRemoved }
    },
  }
}

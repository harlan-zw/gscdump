import type { DataSource, LockScope, ManifestStore, TableName } from './storage'
import { tenantPrefix } from './layout'

export interface GcDeps {
  dataSource: DataSource
  manifestStore: ManifestStore
}

export interface GcOptions {
  userId?: string
  siteId?: string
  /**
   * Retention for hourly partitions (`hourly/{date}`) in milliseconds.
   * Defaults to 90 days; entries with `createdAt < now - hourlyRetentionMs`
   * are retired and their bytes deleted alongside ordinary orphan sweeping.
   */
  hourlyRetentionMs?: number
}

const DEFAULT_HOURLY_RETENTION_MS = 90 * 24 * 60 * 60 * 1000

const VERSION_RE = /__v(\d+)\.parquet$/

// Parses `u_{userId}[/{siteId}]/{table}/{partition}__v{version}.parquet`
// back into a LockScope so the sweeper can coordinate with writers via withLock.
function parseLockScope(key: string): LockScope | undefined {
  const match = VERSION_RE.exec(key)
  if (!match)
    return undefined
  const base = key.slice(0, match.index)
  const parts = base.split('/')
  if (parts.length < 4)
    return undefined
  const userPart = parts[0]!
  if (!userPart.startsWith('u_'))
    return undefined
  const userId = userPart.slice(2)
  // Last two path segments make up the partition (e.g. `daily/2026-04-10`).
  const partition = parts.slice(-2).join('/')
  const table = parts[parts.length - 3] as TableName
  const siteId = parts.length >= 5 ? parts.slice(1, -3).join('/') : undefined
  return { userId, siteId, table, partition }
}

export async function gcOrphansImpl(
  deps: GcDeps,
  now: number,
  graceMs: number,
  opts: GcOptions = {},
): Promise<{ deleted: number }> {
  const cutoff = now - graceMs

  const retired = await deps.manifestStore.listRetired(cutoff)
  if (retired.length > 0) {
    await deps.dataSource.delete(retired.map(e => e.objectKey))
    await deps.manifestStore.delete(retired)
  }

  // Hourly retention sweep. Hourly partitions are GC-only (never compacted)
  // so a separate age cutoff scrubs anything older than the configured window.
  let hourlyDeleted = 0
  if (opts.userId) {
    const hourlyRetentionMs = opts.hourlyRetentionMs ?? DEFAULT_HOURLY_RETENTION_MS
    const hourlyCutoff = now - hourlyRetentionMs
    const allEntries = await deps.manifestStore.listAll({ userId: opts.userId, siteId: opts.siteId })
    const expiredHourly = allEntries.filter(e => e.partition.startsWith('hourly/') && e.createdAt < hourlyCutoff)
    if (expiredHourly.length > 0) {
      await deps.dataSource.delete(expiredHourly.map(e => e.objectKey))
      await deps.manifestStore.delete(expiredHourly)
      hourlyDeleted = expiredHourly.length
    }
  }

  let sweptOrphans = 0
  if (opts.userId) {
    const prefix = tenantPrefix({ userId: opts.userId, siteId: opts.siteId })
    // Intentionally unfiltered by searchType — orphan sweep must consider
    // every slice's known keys when distinguishing live bytes from orphans.
    const knownEntries = await deps.manifestStore.listAll({ userId: opts.userId, siteId: opts.siteId })
    const knownSet = new Set(knownEntries.map(e => e.objectKey))
    const orphans: string[] = []
    const keyStream = deps.dataSource.streamList
      ? deps.dataSource.streamList(prefix)
      : (async function* (): AsyncIterable<string> {
          const all = await deps.dataSource.list(prefix)
          for (const k of all) yield k
        }())
    for await (const key of keyStream) {
      if (knownSet.has(key))
        continue
      const match = VERSION_RE.exec(key)
      if (!match)
        continue
      const version = Number(match[1])
      if (version <= cutoff)
        orphans.push(key)
    }
    // Group orphans by lock scope so we only acquire each lock once, and take
    // the lock before deleting — that way a writeDay mid-flight (which holds
    // the same scope lock) can't be raced by this sweeper.
    const byScope = new Map<string, { scope: LockScope, keys: string[] }>()
    for (const key of orphans) {
      const scope = parseLockScope(key)
      if (!scope)
        continue
      const sk = `${scope.userId}|${scope.siteId ?? ''}|${scope.table}|${scope.partition}`
      const bucket = byScope.get(sk) ?? { scope, keys: [] }
      bucket.keys.push(key)
      byScope.set(sk, bucket)
    }
    for (const { scope, keys } of byScope.values()) {
      await deps.manifestStore.withLock(scope, async () => {
        // Re-check under lock: a concurrent writeDay may have registered
        // the key while we were waiting. Re-read the manifest's view of known
        // entries for this scope and filter them out.
        const known = await deps.manifestStore.listAll({
          userId: scope.userId,
          siteId: scope.siteId,
          table: scope.table,
          partitions: [scope.partition],
        })
        const knownInScope = new Set(known.map(e => e.objectKey))
        const stillOrphans = keys.filter(k => !knownInScope.has(k))
        if (stillOrphans.length > 0) {
          await deps.dataSource.delete(stillOrphans)
          sweptOrphans += stillOrphans.length
        }
      })
    }
  }

  return { deleted: retired.length + sweptOrphans + hourlyDeleted }
}

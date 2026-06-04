// FilesystemDataSource + FilesystemManifestStore.
//
// Manifest backing: JSON file written atomically via tmp+rename.
// Chosen over better-sqlite3 because:
// - zero native deps, keeps CLI install lean
// - CLI scale is single-user, ~hundreds of partitions (trivial for JSON)
// - trivial to inspect/debug (cat .gscdump/manifest.json)
// If scale demands, swap to better-sqlite3 behind the same interface.

import type {
  DataSource,
  ListLiveFilter,
  LockScope,
  ManifestEntry,
  ManifestStore,
  SyncState,
  SyncStateDetail,
  SyncStateFilter,
  SyncStateKind,
  SyncStateScope,
  Watermark,
  WatermarkFilter,
  WatermarkScope,
} from '../storage'
import { Buffer } from 'node:buffer'
import { randomBytes } from 'node:crypto'
import { mkdir, readdir, readFile, rename, rm, stat, unlink, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { lock as lockFile } from 'proper-lockfile'
import { inferLegacyTier, inferSearchType } from '../layout'

export interface FilesystemDataSourceOptions {
  rootDir: string
}

export function createFilesystemDataSource(opts: FilesystemDataSourceOptions): DataSource {
  const root = resolve(opts.rootDir)

  function pathFor(key: string): string {
    const resolved = resolve(root, key)
    if (!resolved.startsWith(`${root}/`) && resolved !== root)
      throw new Error(`path escapes root: ${key}`)
    return resolved
  }

  return {
    async read(key, range, signal) {
      const path = pathFor(key)
      const bytes = await readFile(path, { signal })
      if (!range)
        return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength)
      const sliced = bytes.subarray(range.offset, range.offset + range.length)
      return new Uint8Array(sliced.buffer, sliced.byteOffset, sliced.byteLength)
    },
    async write(key, bytes) {
      const path = pathFor(key)
      await mkdir(dirname(path), { recursive: true })
      await writeFile(path, Buffer.from(bytes))
    },
    async delete(keys) {
      await Promise.all(keys.map(async (k) => {
        const path = pathFor(k)
        await rm(path, { force: true })
      }))
    },
    async list(prefix) {
      const full = resolve(root, prefix)
      const out: string[] = []
      await walk(full, out)
      return out.map(p => p.slice(root.length + 1))
    },
    async* streamList(prefix) {
      const full = resolve(root, prefix)
      for await (const p of walkStream(full))
        yield p.slice(root.length + 1)
    },
    async head(key) {
      const path = pathFor(key)
      return stat(path).then(
        s => ({ bytes: s.size }),
        (err: NodeJS.ErrnoException) => {
          if (err.code === 'ENOENT')
            return undefined
          throw err
        },
      )
    },
    uri(key) {
      return pathFor(key)
    },
  }
}

async function* walkStream(dir: string): AsyncIterable<string> {
  const entries = await readdir(dir, { withFileTypes: true }).catch((err) => {
    const e = err as NodeJS.ErrnoException
    if (e.code === 'ENOENT')
      return [] as Awaited<ReturnType<typeof readdir>>
    throw err
  })
  for (const entry of entries) {
    const p = join(dir, String(entry.name))
    if (entry.isDirectory())
      yield* walkStream(p)
    else
      yield p
  }
}

async function walk(dir: string, out: string[]): Promise<void> {
  const entries = await readdir(dir, { withFileTypes: true }).catch((err) => {
    const e = err as NodeJS.ErrnoException
    if (e.code === 'ENOENT')
      return [] as Awaited<ReturnType<typeof readdir>>
    throw err
  })
  for (const entry of entries) {
    const p = join(dir, String(entry.name))
    if (entry.isDirectory())
      await walk(p, out)
    else out.push(p)
  }
}

export interface FilesystemManifestStoreOptions {
  path: string
}

interface ManifestFile {
  version: 1
  entries: ManifestEntry[]
  watermarks?: Watermark[]
  syncStates?: SyncState[]
}

function watermarkKey(w: WatermarkScope): string {
  return `${w.userId}|${w.siteId ?? ''}|${w.table}`
}

function matchesWatermarkFilter(w: Watermark, filter: WatermarkFilter): boolean {
  if (w.userId !== filter.userId)
    return false
  if (filter.siteId !== undefined && w.siteId !== filter.siteId)
    return false
  if (filter.table !== undefined && w.table !== filter.table)
    return false
  return true
}

function syncStateKey(s: SyncStateScope): string {
  return `${s.userId}|${s.siteId ?? ''}|${s.table}|${s.date}|${inferSearchType(s)}`
}

function matchesSyncStateFilter(s: SyncState, filter: SyncStateFilter): boolean {
  if (s.userId !== filter.userId)
    return false
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

function mergeSyncState(
  existing: SyncState | undefined,
  scope: SyncStateScope,
  state: SyncStateKind,
  detail?: SyncStateDetail,
): SyncState {
  const at = detail?.at ?? Date.now()
  // Increment attempt counter whenever we enter inflight — that's one "try".
  const attemptsBump = state === 'inflight' ? 1 : 0
  if (!existing) {
    return {
      userId: scope.userId,
      siteId: scope.siteId,
      table: scope.table,
      date: scope.date,
      state,
      updatedAt: at,
      attempts: attemptsBump,
      error: detail?.error,
      ...(scope.searchType !== undefined ? { searchType: scope.searchType } : {}),
    }
  }
  return {
    ...existing,
    state,
    updatedAt: at,
    attempts: existing.attempts + attemptsBump,
    // 'done' clears a prior error; 'failed' records a new one; others preserve.
    error: state === 'done' ? undefined : (detail?.error ?? existing.error),
  }
}

function matchesFilter(entry: ManifestEntry, filter: ListLiveFilter): boolean {
  if (entry.userId !== filter.userId)
    return false
  if (filter.siteId !== undefined && entry.siteId !== filter.siteId)
    return false
  if (filter.table !== undefined && entry.table !== filter.table)
    return false
  if (filter.partitions && !filter.partitions.includes(entry.partition))
    return false
  if (filter.tier !== undefined && inferLegacyTier(entry) !== filter.tier)
    return false
  if (filter.searchType !== undefined && inferSearchType(entry) !== filter.searchType)
    return false
  return true
}

function lockFileFor(locksDir: string, scope: LockScope): string {
  // Encode scope so it's safe as a filename — partition contains `/`.
  const raw = `${scope.userId}|${scope.siteId ?? ''}|${scope.table}|${scope.partition}`
  const safe = raw.replace(/[^\w.-]/g, '_')
  return join(locksDir, `${safe}.lock`)
}

export function createFilesystemManifestStore(opts: FilesystemManifestStoreOptions): ManifestStore {
  const manifestPath = resolve(opts.path)
  const locksDir = join(dirname(manifestPath), 'locks')

  async function load(): Promise<ManifestFile> {
    const content = await readFile(manifestPath, 'utf8').catch((err: NodeJS.ErrnoException) => {
      if (err.code === 'ENOENT')
        return null
      throw err
    })
    if (content === null)
      return { version: 1, entries: [] }
    const parsed = JSON.parse(content) as ManifestFile
    if (parsed.version !== 1)
      throw new Error(`unsupported manifest version ${parsed.version}`)
    return parsed
  }

  async function save(data: ManifestFile): Promise<void> {
    await mkdir(dirname(manifestPath), { recursive: true })
    const tmp = `${manifestPath}.${randomBytes(6).toString('hex')}.tmp`
    await writeFile(tmp, JSON.stringify(data), 'utf8')
    await rename(tmp, manifestPath).catch(async (err) => {
      await unlink(tmp).catch(() => {})
      throw err
    })
  }

  const queue: Array<() => Promise<void>> = []
  let running = false

  function enqueue<T>(fn: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolvePromise, rejectPromise) => {
      queue.push(async () => {
        await fn().then(resolvePromise, rejectPromise)
      })
      drain()
    })
  }

  async function drain(): Promise<void> {
    if (running)
      return
    running = true
    while (queue.length > 0) {
      const fn = queue.shift()!
      await fn().catch(() => {})
    }
    running = false
  }

  function entryKey(e: Pick<ManifestEntry, 'objectKey'>): string {
    return e.objectKey
  }

  async function registerVersionsImpl(
    newEntries: ManifestEntry[],
    superseding?: ManifestEntry[],
  ): Promise<void> {
    const data = await load()
    const supersededAt = newEntries[0]?.createdAt ?? Date.now()
    const byKey = new Map(data.entries.map(e => [entryKey(e), e]))
    if (superseding) {
      for (const s of superseding) {
        const existing = byKey.get(entryKey(s))
        if (existing && existing.retiredAt === undefined)
          byKey.set(entryKey(s), { ...existing, retiredAt: supersededAt })
      }
    }
    for (const e of newEntries) byKey.set(entryKey(e), e)
    data.entries = Array.from(byKey.values())
    await save(data)
  }

  return {
    async listLive(filter) {
      const data = await load()
      return data.entries.filter(e => e.retiredAt === undefined && matchesFilter(e, filter))
    },
    async listAll(filter) {
      const data = await load()
      return data.entries.filter(e => matchesFilter(e, filter))
    },
    async registerVersion(entry, superseding) {
      return enqueue(() => registerVersionsImpl([entry], superseding))
    },
    async registerVersions(entries, superseding) {
      return enqueue(() => registerVersionsImpl(entries, superseding))
    },
    async listRetired(olderThan) {
      const data = await load()
      return data.entries.filter(e => e.retiredAt !== undefined && e.retiredAt <= olderThan)
    },
    async delete(toDelete) {
      return enqueue(async () => {
        const data = await load()
        const toDeleteKeys = new Set(toDelete.map(entryKey))
        data.entries = data.entries.filter(e => !toDeleteKeys.has(entryKey(e)))
        await save(data)
      })
    },
    async getWatermarks(filter) {
      const data = await load()
      return (data.watermarks ?? []).filter(w => matchesWatermarkFilter(w, filter))
    },
    async getSyncStates(filter) {
      const data = await load()
      return (data.syncStates ?? []).filter(s => matchesSyncStateFilter(s, filter))
    },
    async setSyncState(scope, state, detail) {
      return enqueue(async () => {
        const data = await load()
        const key = syncStateKey(scope)
        const byKey = new Map(
          (data.syncStates ?? []).map(s => [syncStateKey(s), s] as const),
        )
        byKey.set(key, mergeSyncState(byKey.get(key), scope, state, detail))
        data.syncStates = Array.from(byKey.values())
        await save(data)
      })
    },
    async withLock(scope, fn) {
      await mkdir(locksDir, { recursive: true })
      const path = lockFileFor(locksDir, scope)
      // proper-lockfile needs the target to exist. Touch an empty sentinel.
      await writeFile(path, '', { flag: 'a' })
      const release = await lockFile(path, {
        realpath: false,
        stale: 30_000,
        retries: { retries: 20, minTimeout: 50, maxTimeout: 500, factor: 1.5 },
      })
      // A failed release leaves a stale lock that blocks the next writer until
      // its `stale` window (30s) elapses. We don't fail `fn()` over a cleanup
      // error (the protected work already succeeded), but the failure MUST be
      // observable rather than silently swallowed.
      return await fn().finally(() =>
        release().catch((releaseErr: unknown) => {
          console.warn(
            `[gscdump/engine] failed to release lock ${path}; it will go stale after ${30_000}ms`,
            releaseErr,
          )
        }),
      )
    },
    async purgeTenant(filter) {
      return enqueue(async () => {
        const data = await load()
        const matches = <T extends { userId: string, siteId?: string }>(r: T): boolean =>
          r.userId === filter.userId
          && (filter.siteId === undefined || r.siteId === filter.siteId)
        const before = {
          entries: data.entries.length,
          watermarks: (data.watermarks ?? []).length,
          syncStates: (data.syncStates ?? []).length,
        }
        data.entries = data.entries.filter(e => !matches(e))
        data.watermarks = (data.watermarks ?? []).filter(w => !matches(w))
        data.syncStates = (data.syncStates ?? []).filter(s => !matches(s))
        await save(data)
        return {
          entriesRemoved: before.entries - data.entries.length,
          watermarksRemoved: before.watermarks - data.watermarks.length,
          syncStatesRemoved: before.syncStates - data.syncStates.length,
        }
      })
    },
    async bumpWatermark(scope, date, at) {
      return enqueue(async () => {
        const data = await load()
        const key = watermarkKey(scope)
        const byKey = new Map(
          (data.watermarks ?? []).map(w => [watermarkKey(w), w] as const),
        )
        const existing = byKey.get(key)
        const nowMs = at ?? Date.now()
        const next: Watermark = existing
          ? {
              ...existing,
              newestDateSynced: date > existing.newestDateSynced ? date : existing.newestDateSynced,
              oldestDateSynced: date < existing.oldestDateSynced ? date : existing.oldestDateSynced,
              lastSyncAt: nowMs > existing.lastSyncAt ? nowMs : existing.lastSyncAt,
            }
          : {
              userId: scope.userId,
              siteId: scope.siteId,
              table: scope.table,
              newestDateSynced: date,
              oldestDateSynced: date,
              lastSyncAt: nowMs,
            }
        byKey.set(key, next)
        data.watermarks = Array.from(byKey.values())
        await save(data)
      })
    },
  }
}

// Probe helper — useful from tests and the CLI's `gscdump store stats` command
export async function filesystemStats(rootDir: string): Promise<{ files: number, bytes: number }> {
  const keys: string[] = []
  await walkForStats(resolve(rootDir), keys)
  let bytes = 0
  for (const k of keys) {
    const s = await stat(k)
    bytes += s.size
  }
  return { files: keys.length, bytes }
}

async function walkForStats(dir: string, out: string[]): Promise<void> {
  const entries = await readdir(dir, { withFileTypes: true }).catch((err) => {
    const e = err as NodeJS.ErrnoException
    if (e.code === 'ENOENT')
      return [] as Awaited<ReturnType<typeof readdir>>
    throw err
  })
  for (const entry of entries) {
    const p = join(dir, String(entry.name))
    if (entry.isDirectory())
      await walkForStats(p, out)
    else
      out.push(p)
  }
}

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
  LockScope,
  ManifestEntry,
  ManifestStore,
  SyncState,
  Watermark,
} from '../storage'
import { Buffer } from 'node:buffer'
import { randomBytes } from 'node:crypto'
import { mkdir, open, readdir, readFile, rename, rm, stat, unlink, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { normalize } from 'pathe'
import { lock as lockFile } from 'proper-lockfile'
import {
  manifestEntryKey,
  matchesManifestEntryFilter,
  matchesSyncStateFilter,
  matchesWatermarkFilter,
  mergeSyncState,
  syncStateKey,
  watermarkKey,
} from '../manifest-store-utils'

export interface FilesystemDataSourceOptions {
  rootDir: string
}

function portablePath(path: string): string {
  // POSIX allows literal backslashes in filenames. Only Windows treats them as separators.
  return sep === '\\' ? normalize(path) : path
}

export function createFilesystemDataSource(opts: FilesystemDataSourceOptions): DataSource {
  const root = resolve(opts.rootDir)
  const readyDirectories = new Map<string, Promise<void>>()

  function pathFor(key: string): string {
    const resolved = resolve(root, key)
    const child = relative(root, resolved)
    if (child === '..' || child.startsWith(`..${sep}`) || isAbsolute(child))
      throw new Error(`path escapes root: ${key}`)
    return resolved
  }

  async function ensureDirectory(path: string): Promise<void> {
    let pending = readyDirectories.get(path)
    if (!pending) {
      pending = mkdir(path, { recursive: true }).then(() => undefined)
      readyDirectories.set(path, pending)
      pending.catch(() => readyDirectories.delete(path))
    }
    await pending
  }

  return {
    async read(key, range, signal) {
      const path = pathFor(key)
      if (!range) {
        const bytes = await readFile(path, { signal })
        return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength)
      }

      // Parquet readers issue small footer/page range reads. Loading the whole
      // file here defeats that contract and makes every local query O(file
      // size) in bytes read. FileHandle.read clamps naturally at EOF.
      signal?.throwIfAborted()
      const handle = await open(path, 'r')
      try {
        const bytes = Buffer.allocUnsafe(range.length)
        let totalRead = 0
        while (totalRead < range.length) {
          signal?.throwIfAborted()
          const { bytesRead } = await handle.read(
            bytes,
            totalRead,
            range.length - totalRead,
            range.offset + totalRead,
          )
          if (bytesRead === 0)
            break
          totalRead += bytesRead
        }
        return new Uint8Array(bytes.buffer, bytes.byteOffset, totalRead)
      }
      finally {
        await handle.close()
      }
    },
    async write(key, bytes) {
      const path = pathFor(key)
      const dir = dirname(path)
      await ensureDirectory(dir)
      try {
        await writeFile(path, bytes)
      }
      catch (error) {
        // Recover if an external process removed a directory after it entered
        // the successful-directory cache.
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
          throw error
        readyDirectories.delete(dir)
        await ensureDirectory(dir)
        await writeFile(path, bytes)
      }
    },
    async delete(keys) {
      let next = 0
      async function worker(): Promise<void> {
        while (true) {
          const index = next++
          if (index >= keys.length)
            return
          await rm(pathFor(keys[index]!), { force: true })
        }
      }
      await Promise.all(Array.from({ length: Math.min(32, keys.length) }, worker))
    },
    async list(prefix) {
      const full = pathFor(prefix)
      const out: string[] = []
      await walk(full, out)
      return out.map(p => portablePath(relative(root, p)))
    },
    async* streamList(prefix) {
      const full = pathFor(prefix)
      for await (const p of walkStream(full))
        yield portablePath(relative(root, p))
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
      return portablePath(pathFor(key))
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
  const pending = [dir]
  let next = 0
  while (next < pending.length) {
    const batch = pending.slice(next, next + 32)
    next += batch.length
    const listings = await Promise.all(batch.map(async current => ({
      current,
      entries: await readdir(current, { withFileTypes: true }).catch((err) => {
        const e = err as NodeJS.ErrnoException
        if (e.code === 'ENOENT')
          return [] as Awaited<ReturnType<typeof readdir>>
        throw err
      }),
    })))
    for (const { current, entries } of listings) {
      for (const entry of entries) {
        const p = join(current, String(entry.name))
        if (entry.isDirectory())
          pending.push(p)
        else
          out.push(p)
      }
    }
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

function lockFileFor(locksDir: string, scope: LockScope): string {
  // Encode scope so it's safe as a filename — partition contains `/`.
  const raw = `${scope.userId}|${scope.siteId ?? ''}|${scope.table}|${scope.partition}`
  const safe = raw.replace(/[^\w.-]/g, '_')
  return join(locksDir, `${safe}.lock`)
}

// Writers in one process queue here per lock file, so the file lock only
// arbitrates between processes. Without the queue, every search type of one
// table and date raced for the same partition lock, and the file-lock retry
// budget ran out once the queue held more than ~8s of work.
const inProcessLockTails = new Map<string, Promise<void>>()

async function withInProcessQueue<T>(path: string, fn: () => Promise<T>): Promise<T> {
  const previous = inProcessLockTails.get(path) ?? Promise.resolve()
  let release!: () => void
  const current = new Promise<void>((resolve) => {
    release = resolve
  })
  const tail = previous.then(() => current)
  inProcessLockTails.set(path, tail)
  await previous
  try {
    return await fn()
  }
  finally {
    release()
    if (inProcessLockTails.get(path) === tail)
      inProcessLockTails.delete(path)
  }
}

export function createFilesystemManifestStore(opts: FilesystemManifestStoreOptions): ManifestStore {
  const manifestPath = resolve(opts.path)
  const locksDir = join(dirname(manifestPath), 'locks')
  const readyDirectories = new Map<string, Promise<void>>()

  async function withFileLock<T>(path: string, fn: () => Promise<T>): Promise<T> {
    // proper-lockfile needs the target to exist. Touch an empty sentinel.
    await writeFile(path, '', { flag: 'a' }).catch(async (error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT')
        throw error
      readyDirectories.delete(locksDir)
      await ensureDirectory(locksDir)
      await writeFile(path, '', { flag: 'a' })
    })
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
  }

  async function ensureDirectory(path: string): Promise<void> {
    let pending = readyDirectories.get(path)
    if (!pending) {
      pending = mkdir(path, { recursive: true }).then(() => undefined)
      readyDirectories.set(path, pending)
      pending.catch(() => readyDirectories.delete(path))
    }
    await pending
  }

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
    const manifestDir = dirname(manifestPath)
    await ensureDirectory(manifestDir)
    const tmp = `${manifestPath}.${randomBytes(6).toString('hex')}.tmp`
    const content = JSON.stringify(data)
    await writeFile(tmp, content, 'utf8').catch(async (error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT')
        throw error
      readyDirectories.delete(manifestDir)
      await ensureDirectory(manifestDir)
      await writeFile(tmp, content, 'utf8')
    })
    await rename(tmp, manifestPath).catch(async (err) => {
      try {
        await unlink(tmp)
      }
      catch (cleanupError) {
        throw new AggregateError([err, cleanupError], `failed to replace manifest and remove temporary file ${tmp}`)
      }
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
      await fn()
    }
    running = false
  }

  async function registerVersionsImpl(
    newEntries: ManifestEntry[],
    superseding?: ManifestEntry[],
  ): Promise<void> {
    const data = await load()
    const supersededAt = newEntries[0]?.createdAt ?? Date.now()
    const byKey = new Map(data.entries.map(e => [manifestEntryKey(e), e]))
    if (superseding) {
      for (const s of superseding) {
        const existing = byKey.get(manifestEntryKey(s))
        if (existing && existing.retiredAt === undefined)
          byKey.set(manifestEntryKey(s), { ...existing, retiredAt: supersededAt })
      }
    }
    for (const e of newEntries) byKey.set(manifestEntryKey(e), e)
    data.entries = Array.from(byKey.values())
    await save(data)
  }

  return {
    async listLive(filter) {
      const data = await load()
      return data.entries.filter(e => e.retiredAt === undefined && matchesManifestEntryFilter(e, filter))
    },
    async listAll(filter) {
      const data = await load()
      return data.entries.filter(e => matchesManifestEntryFilter(e, filter))
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
        const toDeleteKeys = new Set(toDelete.map(manifestEntryKey))
        data.entries = data.entries.filter(e => !toDeleteKeys.has(manifestEntryKey(e)))
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
    async setSyncStates(scopes, state, detail) {
      if (scopes.length === 0)
        return
      return enqueue(async () => {
        const data = await load()
        const byKey = new Map(
          (data.syncStates ?? []).map(s => [syncStateKey(s), s] as const),
        )
        for (const scope of scopes) {
          const key = syncStateKey(scope)
          byKey.set(key, mergeSyncState(byKey.get(key), scope, state, detail))
        }
        data.syncStates = Array.from(byKey.values())
        await save(data)
      })
    },
    async withLock(scope, fn) {
      await ensureDirectory(locksDir)
      const path = lockFileFor(locksDir, scope)
      return withInProcessQueue(path, () => withFileLock(path, fn))
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
              ...(scope.searchType !== undefined ? { searchType: scope.searchType } : {}),
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
  let next = 0
  async function worker(): Promise<void> {
    while (true) {
      const index = next++
      if (index >= keys.length)
        return
      const s = await stat(keys[index]!)
      bytes += s.size
    }
  }
  await Promise.all(Array.from({ length: Math.min(32, keys.length) }, worker))
  return { files: keys.length, bytes }
}

async function walkForStats(dir: string, out: string[]): Promise<void> {
  await walk(dir, out)
}

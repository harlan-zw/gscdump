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
  ManifestEntry,
  ManifestStore,
} from '../storage'
import { Buffer } from 'node:buffer'
import { randomBytes } from 'node:crypto'
import { mkdir, readdir, readFile, rename, rm, stat, unlink, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'

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
    async read(key, range) {
      const path = pathFor(key)
      const bytes = await readFile(path)
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
  return true
}

export function createFilesystemManifestStore(opts: FilesystemManifestStoreOptions): ManifestStore {
  const manifestPath = resolve(opts.path)

  async function load(): Promise<ManifestFile> {
    try {
      const content = await readFile(manifestPath, 'utf8')
      const parsed = JSON.parse(content) as ManifestFile
      if (parsed.version !== 1)
        throw new Error(`unsupported manifest version ${parsed.version}`)
      return parsed
    }
    catch (err) {
      const e = err as NodeJS.ErrnoException
      if (e.code === 'ENOENT')
        return { version: 1, entries: [] }
      throw err
    }
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
  }
}

// Probe helper — useful from tests and the CLI's `gscdump stats` command
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

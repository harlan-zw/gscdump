import type {
  DataSource,
  LockScope,
  ManifestEntry,
  ManifestStore,
  ParquetCodec,
  QueryExecutor,
  Row,
  SyncState,
  Watermark,
} from '../../src/storage'
import {
  manifestEntryKey,
  matchesManifestEntryFilter,
  matchesSyncStateFilter,
  matchesWatermarkFilter,
  mergeSyncState,
  syncStateKey,
  watermarkKey,
} from '../../src/manifest-store-utils'

export function createInMemoryDataSource(initial?: Map<string, Uint8Array>): DataSource & {
  snapshot: () => Map<string, Uint8Array>
} {
  const store = new Map<string, Uint8Array>(initial)

  return {
    read(key, range, signal) {
      if (signal?.aborted)
        return Promise.reject(signal.reason)
      const bytes = store.get(key)
      if (!bytes)
        return Promise.reject(new Error(`key not found: ${key}`))
      if (!range)
        return Promise.resolve(bytes)
      return Promise.resolve(bytes.slice(range.offset, range.offset + range.length))
    },
    write(key, bytes) {
      store.set(key, bytes)
      return Promise.resolve()
    },
    delete(keys) {
      for (const k of keys) store.delete(k)
      return Promise.resolve()
    },
    list(prefix) {
      const out: string[] = []
      for (const k of store.keys()) {
        if (k.startsWith(prefix))
          out.push(k)
      }
      return Promise.resolve(out)
    },
    snapshot() {
      return new Map(store)
    },
  }
}

function lockKey(s: LockScope): string {
  return `${s.userId}|${s.siteId ?? ''}|${s.table}|${s.partition}`
}

export function createInMemoryManifestStore(): ManifestStore & {
  snapshot: () => ManifestEntry[]
  all: () => ManifestEntry[]
} {
  const entries = new Map<string, ManifestEntry>()
  const watermarks = new Map<string, Watermark>()
  const syncStates = new Map<string, SyncState>()
  const lockChains = new Map<string, Promise<unknown>>()

  function registerVersions(newEntries: ManifestEntry[], superseding?: ManifestEntry[]): Promise<void> {
    const supersededAt = newEntries[0]?.createdAt ?? Date.now()
    if (superseding) {
      for (const s of superseding) {
        const existing = entries.get(manifestEntryKey(s))
        if (existing && existing.retiredAt === undefined) {
          entries.set(manifestEntryKey(s), { ...existing, retiredAt: supersededAt })
        }
      }
    }
    for (const e of newEntries) {
      entries.set(manifestEntryKey(e), e)
    }
    return Promise.resolve()
  }

  return {
    listLive(filter) {
      const out: ManifestEntry[] = []
      for (const e of entries.values()) {
        if (e.retiredAt !== undefined)
          continue
        if (matchesManifestEntryFilter(e, filter))
          out.push(e)
      }
      return Promise.resolve(out)
    },
    listAll(filter) {
      const out: ManifestEntry[] = []
      for (const e of entries.values()) {
        if (matchesManifestEntryFilter(e, filter))
          out.push(e)
      }
      return Promise.resolve(out)
    },
    registerVersion(entry, superseding) {
      return registerVersions([entry], superseding)
    },
    registerVersions,
    listRetired(olderThan) {
      const out: ManifestEntry[] = []
      for (const e of entries.values()) {
        if (e.retiredAt !== undefined && e.retiredAt <= olderThan)
          out.push(e)
      }
      return Promise.resolve(out)
    },
    delete(toDelete) {
      for (const e of toDelete) entries.delete(manifestEntryKey(e))
      return Promise.resolve()
    },
    getWatermarks(filter) {
      const out: Watermark[] = []
      for (const w of watermarks.values()) {
        if (matchesWatermarkFilter(w, filter))
          out.push(w)
      }
      return Promise.resolve(out)
    },
    getSyncStates(filter) {
      const out: SyncState[] = []
      for (const s of syncStates.values()) {
        if (matchesSyncStateFilter(s, filter))
          out.push(s)
      }
      return Promise.resolve(out)
    },
    setSyncState(scope, state, detail) {
      const key = syncStateKey(scope)
      syncStates.set(key, mergeSyncState(syncStates.get(key), scope, state, detail))
      return Promise.resolve()
    },
    bumpWatermark(scope, date, at) {
      const key = watermarkKey(scope)
      const existing = watermarks.get(key)
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
      watermarks.set(key, next)
      return Promise.resolve()
    },
    withLock<T>(scope: LockScope, fn: () => Promise<T>): Promise<T> {
      const key = lockKey(scope)
      const prev = lockChains.get(key) ?? Promise.resolve()
      const result = prev.then(() => fn())
      lockChains.set(key, result.catch(() => {}))
      return result
    },
    purgeTenant(filter) {
      const match = <T extends { userId: string, siteId?: string }>(r: T): boolean =>
        r.userId === filter.userId
        && (filter.siteId === undefined || r.siteId === filter.siteId)
      let entriesRemoved = 0
      let watermarksRemoved = 0
      let syncStatesRemoved = 0
      for (const [k, e] of entries) {
        if (match(e)) {
          entries.delete(k)
          entriesRemoved++
        }
      }
      for (const [k, w] of watermarks) {
        if (match(w)) {
          watermarks.delete(k)
          watermarksRemoved++
        }
      }
      for (const [k, s] of syncStates) {
        if (match(s)) {
          syncStates.delete(k)
          syncStatesRemoved++
        }
      }
      return Promise.resolve({ entriesRemoved, watermarksRemoved, syncStatesRemoved })
    },
    snapshot() {
      return Array.from(entries.values()).filter(e => e.retiredAt === undefined)
    },
    all() {
      return Array.from(entries.values())
    },
  }
}

const MAGIC = 'JSONROWS\n'

// Minimal schema header — distinguishes an empty-but-present file from an
// absent one on decode, and carries the table column list so consumers can
// mimic the parquet `union_by_name` behavior even with zero rows.
const SCHEMAS: Record<string, string[]> = {
  pages: ['url', 'date', 'clicks', 'impressions', 'sum_position'],
  queries: ['query', 'date', 'clicks', 'impressions', 'sum_position'],
  countries: ['country', 'date', 'clicks', 'impressions', 'sum_position'],
  dates: ['device', 'date', 'clicks', 'impressions', 'sum_position'],
  page_queries: ['url', 'query', 'date', 'clicks', 'impressions', 'sum_position'],
}

interface JsonCodecFile {
  schema: { table: string, columns: string[] }
  rows: Row[]
}

export function createJsonCodec(): ParquetCodec {
  const enc = new TextEncoder()
  const dec = new TextDecoder()

  function encodeBytes(table: string, rows: Row[]): Uint8Array {
    const body: JsonCodecFile = {
      schema: { table, columns: SCHEMAS[table] ?? [] },
      rows,
    }
    return enc.encode(MAGIC + JSON.stringify(body))
  }

  function decodeBytes(bytes: Uint8Array): JsonCodecFile {
    const text = dec.decode(bytes)
    if (!text.startsWith(MAGIC))
      throw new Error('not a JSON-codec blob')
    return JSON.parse(text.slice(MAGIC.length)) as JsonCodecFile
  }

  return {
    async writeRows(ctx, rows, key, dataSource) {
      const bytes = encodeBytes(ctx.table, rows)
      await dataSource.write(key, bytes)
      return { bytes: bytes.byteLength, rowCount: rows.length }
    },
    async readRows(_ctx, key, dataSource) {
      const bytes = await dataSource.read(key)
      return decodeBytes(bytes).rows
    },
    async compactRows(ctx, inputKeys, outputKey, dataSource) {
      const rows: Row[] = []
      for (const key of inputKeys) {
        const part = decodeBytes(await dataSource.read(key))
        for (const r of part.rows) rows.push(r)
      }
      const bytes = encodeBytes(ctx.table, rows)
      await dataSource.write(outputKey, bytes)
      return { bytes: bytes.byteLength, rowCount: rows.length }
    },
  }
}

export function createUnionExecutor(codec: ParquetCodec): QueryExecutor {
  return {
    async execute({ sql, fileKeys, dataSource, table, signal }) {
      signal?.throwIfAborted()
      const rows: Row[] = []
      const seen = new Set<string>()
      for (const keys of Object.values(fileKeys)) {
        for (const key of keys) {
          if (seen.has(key))
            continue
          seen.add(key)
          signal?.throwIfAborted()
          const part = await codec.readRows({ table }, key, dataSource)
          for (const r of part) rows.push(r)
        }
      }
      return { rows, sql }
    },
  }
}

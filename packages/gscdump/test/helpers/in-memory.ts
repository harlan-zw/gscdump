import type {
  DataSource,
  ListLiveFilter,
  LockScope,
  ManifestEntry,
  ManifestStore,
  ParquetCodec,
  QueryExecutor,
  Row,
  SyncState,
  SyncStateDetail,
  SyncStateFilter,
  SyncStateKind,
  SyncStateScope,
  Watermark,
  WatermarkFilter,
  WatermarkScope,
} from '../../src/analytics/storage'

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

function entryKey(e: Pick<ManifestEntry, 'objectKey'>): string {
  return e.objectKey
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
  return `${s.userId}|${s.siteId ?? ''}|${s.table}|${s.date}`
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
  return true
}

function mergeSyncState(
  existing: SyncState | undefined,
  scope: SyncStateScope,
  state: SyncStateKind,
  detail?: SyncStateDetail,
): SyncState {
  const at = detail?.at ?? Date.now()
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
    }
  }
  return {
    ...existing,
    state,
    updatedAt: at,
    attempts: existing.attempts + attemptsBump,
    error: state === 'done' ? undefined : (detail?.error ?? existing.error),
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
        const existing = entries.get(entryKey(s))
        if (existing && existing.retiredAt === undefined) {
          entries.set(entryKey(s), { ...existing, retiredAt: supersededAt })
        }
      }
    }
    for (const e of newEntries) {
      entries.set(entryKey(e), e)
    }
    return Promise.resolve()
  }

  return {
    listLive(filter) {
      const out: ManifestEntry[] = []
      for (const e of entries.values()) {
        if (e.retiredAt !== undefined)
          continue
        if (matchesFilter(e, filter))
          out.push(e)
      }
      return Promise.resolve(out)
    },
    listAll(filter) {
      const out: ManifestEntry[] = []
      for (const e of entries.values()) {
        if (matchesFilter(e, filter))
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
      for (const e of toDelete) entries.delete(entryKey(e))
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
  keywords: ['query', 'date', 'clicks', 'impressions', 'sum_position'],
  countries: ['country', 'date', 'clicks', 'impressions', 'sum_position'],
  devices: ['device', 'date', 'clicks', 'impressions', 'sum_position'],
  page_keywords: ['url', 'query', 'date', 'clicks', 'impressions', 'sum_position'],
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

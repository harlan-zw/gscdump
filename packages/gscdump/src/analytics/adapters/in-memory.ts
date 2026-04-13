import type {
  DataSource,
  ListLiveFilter,
  ManifestEntry,
  ManifestStore,
  ParquetCodec,
  QueryExecutor,
  Row,
  TableName,
} from '../storage'

export function createInMemoryDataSource(initial?: Map<string, Uint8Array>): DataSource & {
  snapshot: () => Map<string, Uint8Array>
} {
  const store = new Map<string, Uint8Array>(initial)

  return {
    read(key, range) {
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

export function createInMemoryManifestStore(): ManifestStore & {
  snapshot: () => ManifestEntry[]
  all: () => ManifestEntry[]
} {
  const entries = new Map<string, ManifestEntry>()

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
    snapshot() {
      return Array.from(entries.values()).filter(e => e.retiredAt === undefined)
    },
    all() {
      return Array.from(entries.values())
    },
  }
}

const MAGIC = 'JSONROWS\n'
const TRAILING_NULLS_RE = /\0+$/

export function createJsonCodec(): ParquetCodec {
  const enc = new TextEncoder()
  const dec = new TextDecoder()

  return {
    encode(_table, rows) {
      const json = JSON.stringify(rows)
      return Promise.resolve(enc.encode(MAGIC + json))
    },
    decode(bytes) {
      const text = dec.decode(bytes)
      if (!text.startsWith(MAGIC))
        return Promise.reject(new Error('not a JSON-codec blob'))
      return Promise.resolve(JSON.parse(text.slice(MAGIC.length)) as Row[])
    },
  }
}

export function createFixedSizeCodec(bytesPerRow: number): ParquetCodec {
  const enc = new TextEncoder()
  const dec = new TextDecoder()

  return {
    encode(_table: TableName, rows) {
      const json = JSON.stringify(rows)
      const encoded = enc.encode(MAGIC + json)
      const target = Math.max(encoded.length, bytesPerRow * rows.length)
      const out = new Uint8Array(target)
      out.set(encoded, 0)
      return Promise.resolve(out)
    },
    decode(bytes) {
      const text = dec.decode(bytes)
      const start = text.indexOf(MAGIC)
      if (start < 0)
        return Promise.reject(new Error('not a fixed-size JSON blob'))
      const body = text.slice(start + MAGIC.length).replace(TRAILING_NULLS_RE, '')
      const end = findJsonEnd(body)
      return Promise.resolve(JSON.parse(body.slice(0, end)) as Row[])
    },
  }
}

export function createUnionExecutor(codec: ParquetCodec): QueryExecutor {
  return {
    async execute({ files, table }) {
      const rows: Row[] = []
      for (const f of files) {
        const decoded = await codec.decode(f.bytes, table)
        for (const r of decoded) rows.push(r)
      }
      return rows
    },
  }
}

function findJsonEnd(s: string): number {
  let depth = 0
  let inStr = false
  let escape = false
  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    if (escape) {
      escape = false
      continue
    }
    if (c === '\\') {
      escape = true
      continue
    }
    if (c === '"') {
      inStr = !inStr
      continue
    }
    if (inStr)
      continue
    if (c === '[' || c === '{') {
      depth++
    }
    else if (c === ']' || c === '}') {
      depth--
      if (depth === 0)
        return i + 1
    }
  }
  return s.length
}

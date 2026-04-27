// Read-only HTTP adapters for running the engine against remote Parquet files
// and a remote JSON manifest. Intended for the browser (DuckDB-WASM + httpfs)
// and for any other client that wants to read analytics data without carrying
// a full filesystem / manifest store.
//
// Writes are unsupported — the browser has no business mutating shared state.
// All write-path methods throw so that misconfiguration fails loudly instead
// of silently desyncing.

import type {
  DataSource,
  ListLiveFilter,
  LockScope,
  ManifestEntry,
  ManifestStore,
  SyncStateFilter,
  Watermark,
  WatermarkFilter,
} from '../storage'
import { inferLegacyTier } from '../storage'

function readOnly(name: string): never {
  throw new Error(`http adapter is read-only: ${name} is not supported`)
}

export interface HttpDataSourceOptions {
  /**
   * Base URL to prefix each object key with. MUST NOT have a trailing slash.
   * E.g. `https://pub-abcdef.r2.dev/gscdump-data`.
   */
  baseUrl: string
  /**
   * Optional transformer that produces the final URL for a key. Use this when
   * keys need signing (pre-signed URLs, per-request tokens, etc.). If omitted,
   * the default is `${baseUrl}/${encodeKey(key)}` where forward slashes in the
   * key are preserved.
   */
  signUrl?: (key: string) => string
  /**
   * Whether `uri(key)` should return the HTTPS URL so DuckDB's httpfs can
   * fetch directly. Default true (browser, Workers, anywhere httpfs is
   * loaded). Set to false for environments where httpfs isn't available —
   * the executor will fall back to `read(key)` and buffer the bytes itself.
   */
  useDuckDBHttpfs?: boolean
}

function encodeKey(key: string): string {
  return key.split('/').map(encodeURIComponent).join('/')
}

const TRAILING_SLASH = /\/$/

export function createHttpDataSource(opts: HttpDataSourceOptions): DataSource {
  const base = opts.baseUrl.replace(TRAILING_SLASH, '')
  const sign = opts.signUrl ?? ((key: string) => `${base}/${encodeKey(key)}`)
  const useHttpfs = opts.useDuckDBHttpfs ?? true

  async function readBytes(key: string, range?: { offset: number, length: number }, signal?: AbortSignal): Promise<Uint8Array> {
    const url = sign(key)
    const headers: Record<string, string> = {}
    if (range)
      headers.Range = `bytes=${range.offset}-${range.offset + range.length - 1}`
    const res = await fetch(url, { headers, signal })
    if (!res.ok)
      throw new Error(`http read failed ${res.status} ${res.statusText} for ${url}`)
    return new Uint8Array(await res.arrayBuffer())
  }

  return {
    read: readBytes,
    async write() { readOnly('write') },
    async delete() { readOnly('delete') },
    async list() {
      readOnly('list')
    },
    async head(key) {
      const res = await fetch(sign(key), { method: 'HEAD' })
      if (!res.ok)
        return undefined
      const len = res.headers.get('content-length')
      return len == null ? undefined : { bytes: Number(len) }
    },
    uri(key) {
      return useHttpfs ? sign(key) : undefined
    },
  }
}

export interface HttpManifestStoreOptions {
  /**
   * URL of a JSON manifest snapshot. The response MUST be:
   *   { version: 1, entries: ManifestEntry[], watermarks?: Watermark[] }
   * (Matches the on-disk layout produced by the filesystem adapter.)
   */
  manifestUrl: string
  /** Override fetch for tests / custom origins. */
  fetchImpl?: typeof fetch
}

interface ManifestSnapshot {
  version: 1
  entries: ManifestEntry[]
  watermarks?: Watermark[]
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
  return true
}

function matchesWatermark(w: Watermark, filter: WatermarkFilter): boolean {
  if (w.userId !== filter.userId)
    return false
  if (filter.siteId !== undefined && w.siteId !== filter.siteId)
    return false
  if (filter.table !== undefined && w.table !== filter.table)
    return false
  return true
}

export function createHttpManifestStore(opts: HttpManifestStoreOptions): ManifestStore {
  const fetchImpl = opts.fetchImpl ?? fetch
  let cache: Promise<ManifestSnapshot> | null = null

  async function load(): Promise<ManifestSnapshot> {
    if (!cache) {
      cache = (async () => {
        const res = await fetchImpl(opts.manifestUrl)
        if (!res.ok)
          throw new Error(`manifest fetch failed ${res.status} ${res.statusText} for ${opts.manifestUrl}`)
        const parsed = await res.json() as ManifestSnapshot
        if (parsed.version !== 1)
          throw new Error(`unsupported manifest version ${parsed.version}`)
        return parsed
      })()
    }
    return cache
  }

  return {
    async listLive(filter) {
      const { entries } = await load()
      return entries.filter(e => e.retiredAt === undefined && matchesFilter(e, filter))
    },
    async listAll(filter) {
      const { entries } = await load()
      return entries.filter(e => matchesFilter(e, filter))
    },
    async getWatermarks(filter) {
      const { watermarks = [] } = await load()
      return watermarks.filter(w => matchesWatermark(w, filter))
    },
    async getSyncStates(_filter: SyncStateFilter) { return [] },
    async listRetired() { return [] },
    async registerVersion() { readOnly('registerVersion') },
    async registerVersions() { readOnly('registerVersions') },
    async delete() { readOnly('delete') },
    async bumpWatermark() { readOnly('bumpWatermark') },
    async setSyncState() { readOnly('setSyncState') },
    async withLock<T>(_: LockScope, fn: () => Promise<T>) {
      // Reads don't need locking; pass through so engine.runSQL doesn't break.
      return fn()
    },
    async purgeTenant() { readOnly('purgeTenant') },
  }
}

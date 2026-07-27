import type { TenantCtx } from '@gscdump/contracts'
import type { DataSource } from '../storage'
import { encodeJsonBigintSafe } from '@gscdump/lakehouse/bigint'
import { readOptional } from '../adapters/read-optional'
import { hashUrl, indexingMetadataIndexKey } from '../entity-keys'

export interface IndexingMetadataRecord {
  url: string
  capturedAt: string
  /** ISO-8601 notifyTime of the latest `URL_UPDATED` notification we've seen. */
  latestUpdateAt?: string
  /** ISO-8601 notifyTime of the latest `URL_REMOVED` notification we've seen. */
  latestRemoveAt?: string
  raw?: unknown
}

export interface IndexingMetadataIndex {
  version: 1
  records: Record<string, IndexingMetadataRecord>
}

export interface IndexingMetadataStore {
  writeBatch: (ctx: TenantCtx, records: readonly IndexingMetadataRecord[]) => Promise<void>
  loadIndex: (ctx: TenantCtx) => Promise<IndexingMetadataIndex>
  getLatest: (ctx: TenantCtx, url: string) => Promise<IndexingMetadataRecord | undefined>
}

export interface CreateIndexingMetadataStoreOptions {
  dataSource: DataSource
  hash?: (url: string) => string
}

export function createIndexingMetadataStore(
  opts: CreateIndexingMetadataStoreOptions,
): IndexingMetadataStore {
  const ds = opts.dataSource
  const hash = opts.hash ?? hashUrl

  async function readIndex(key: string): Promise<IndexingMetadataIndex> {
    // Absent index → the empty default (first-run no-op). A real read failure or
    // a parse error propagates rather than masquerading as a fresh empty index,
    // which would clobber real state on the next `writeBatch`.
    const bytes = await readOptional(ds, key)
    if (bytes === undefined)
      return { version: 1, records: {} }
    return JSON.parse(new TextDecoder().decode(bytes)) as IndexingMetadataIndex
  }

  return {
    async writeBatch(ctx, records) {
      if (records.length === 0)
        return
      const key = indexingMetadataIndexKey(ctx)
      const index = await readIndex(key)
      for (const r of records) index.records[hash(r.url)] = r
      await ds.write(key, encodeJsonBigintSafe(index))
    },

    async loadIndex(ctx) {
      return readIndex(indexingMetadataIndexKey(ctx))
    },

    async getLatest(ctx, url) {
      const index = await readIndex(indexingMetadataIndexKey(ctx))
      return index.records[hash(url)]
    },
  }
}

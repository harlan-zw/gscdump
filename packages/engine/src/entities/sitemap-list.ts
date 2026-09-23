// Search Console's own sitemap list for a site: the submitted feeds with
// their status and counts. One JSON document per site, replaced on each
// fetch. URL membership lives in the sitemap generation store instead.

import type { TenantCtx } from '@gscdump/contracts'
import type { DataSource } from '../storage'
import { encodeJsonBigintSafe } from '@gscdump/lakehouse/bigint'
import { readOptional } from '../adapters/read-optional'
import { sitemapListKey } from '../entity-keys'

export interface SitemapListContent {
  type: string
  submitted: number
  /** Google deprecated this count. It is null when the API omits it. */
  indexed: number | null
}

export interface SitemapListEntry {
  path: string
  type: string | null
  isPending: boolean
  isSitemapsIndex: boolean
  lastSubmitted: string | null
  lastDownloaded: string | null
  warnings: number
  errors: number
  contents: SitemapListContent[]
}

export interface SitemapListDoc {
  version: 1
  /** ISO-8601 time of the Search Console fetch. */
  fetchedAt: string
  sitemaps: SitemapListEntry[]
}

export interface SitemapListStore {
  /** The last saved list, or `undefined` when none was saved. A real read failure propagates. */
  load: (ctx: TenantCtx) => Promise<SitemapListDoc | undefined>
  save: (ctx: TenantCtx, doc: SitemapListDoc) => Promise<{ key: string, bytes: number }>
}

export interface CreateSitemapListStoreOptions {
  dataSource: DataSource
}

export function createSitemapListStore(opts: CreateSitemapListStoreOptions): SitemapListStore {
  const ds = opts.dataSource
  return {
    async load(ctx) {
      const bytes = await readOptional(ds, sitemapListKey(ctx))
      if (bytes === undefined)
        return undefined
      return JSON.parse(new TextDecoder().decode(bytes)) as SitemapListDoc
    },
    async save(ctx, doc) {
      const key = sitemapListKey(ctx)
      const bytes = encodeJsonBigintSafe(doc)
      await ds.write(key, bytes)
      return { key, bytes: bytes.byteLength }
    },
  }
}

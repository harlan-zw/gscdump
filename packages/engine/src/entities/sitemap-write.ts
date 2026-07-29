import type { CreateSitemapStoreOptions, SitemapStore } from './sitemap-shared'
import { createSitemapReadStore } from './sitemap'
import { createSitemapGenerationWriteMethods } from './sitemap-generation'

export function createSitemapStore(opts: CreateSitemapStoreOptions): SitemapStore {
  return {
    ...createSitemapReadStore(opts),
    ...createSitemapGenerationWriteMethods(opts),
  }
}

import type {
  CreateSitemapReadStoreOptions,
  DateRange,
  SitemapMembershipEvent,
  SitemapReadStore,
  SitemapSiteGenerationManifest,
} from './sitemap-shared'
import { decodeParquetToRows } from '../adapters/hyparquet'
import { readOptional } from '../adapters/read-optional'
import { sitemapSiteManifestKey } from '../entity-keys'
import { createSitemapGenerationReadMethods } from './sitemap-generation'

function dateInRange(date: string, range: DateRange | undefined): boolean {
  return (!range?.from || date >= range.from) && (!range?.to || date <= range.to)
}

function rowToMembershipEvent(row: Record<string, unknown>): SitemapMembershipEvent | undefined {
  const op = String(row.op)
  if (op !== 'added' && op !== 'removed' && op !== 'updated')
    return undefined
  return {
    feedpath: String(row.feedpath),
    feedpathHash: String(row.feedpath_hash),
    urlHash: String(row.url_hash),
    op,
    loc: String(row.loc),
    lastmod: row.lastmod == null ? undefined : String(row.lastmod),
    previousLastmod: row.previous_lastmod == null ? undefined : String(row.previous_lastmod),
    generationId: String(row.generation_id),
    observedAt: Number(row.observed_at),
    sequence: Number(row.sequence),
    projectsState: Boolean(row.projects_state),
  }
}

export function createSitemapReadStore(opts: CreateSitemapReadStoreOptions): SitemapReadStore {
  const ds = opts.dataSource
  const generationReads = createSitemapGenerationReadMethods(opts)

  async function readManifest(key: string): Promise<SitemapSiteGenerationManifest | undefined> {
    const bytes = await readOptional(ds, key)
    return bytes === undefined
      ? undefined
      : JSON.parse(new TextDecoder().decode(bytes)) as SitemapSiteGenerationManifest
  }

  return {
    ...generationReads,
    async* loadEvents(ctx, dateRange) {
      const current = await readManifest(sitemapSiteManifestKey(ctx))
      if (!current)
        return

      const ancestry: SitemapSiteGenerationManifest[] = []
      const seen = new Set<string>()
      let cursor: SitemapSiteGenerationManifest | undefined = current
      while (cursor) {
        const observedDate = new Date(cursor.observedAt).toISOString().slice(0, 10)
        if (dateRange?.from && observedDate < dateRange.from)
          break
        ancestry.push(cursor)
        if (!cursor.previousManifestKey)
          break
        if (seen.has(cursor.previousManifestKey))
          throw new Error('sitemap generation manifest ancestry cycle')
        seen.add(cursor.previousManifestKey)
        const previous = await readManifest(cursor.previousManifestKey)
        if (!previous || previous.generationId !== cursor.previousGenerationId)
          throw new Error('sitemap generation manifest ancestry is incomplete')
        cursor = previous
      }

      for (const manifest of ancestry.reverse()) {
        const observedDate = new Date(manifest.observedAt).toISOString().slice(0, 10)
        if (!dateInRange(observedDate, dateRange))
          continue
        for (const key of manifest.eventKeys) {
          const bytes = await readOptional(ds, key)
          if (!bytes)
            throw new Error(`published sitemap event missing: ${key}`)
          const rows = await decodeParquetToRows(bytes)
          rows.sort((left, right) =>
            Number(left.sequence) - Number(right.sequence)
            || String(left.url_hash).localeCompare(String(right.url_hash)),
          )
          for (const row of rows) {
            const event = rowToMembershipEvent(row)
            if (event)
              yield event
          }
        }
      }
    },
  }
}

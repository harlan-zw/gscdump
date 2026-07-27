import type { CreateSitemapReadStoreOptions, SitemapIndex, SitemapPendingGeneration, SitemapReadStore } from './sitemap-shared'
import { decodeParquetToRows } from '../adapters/hyparquet'
import { readOptional } from '../adapters/read-optional'
import { hashUrl, parseSitemapUrlsDeltaKey, sitemapIndexKey, sitemapUrlsEventsPrefix, sitemapUrlsIndexKey, sitemapUrlsPendingGenerationsPrefix, sitemapUrlsPrefix, sitemapUrlsProjectionManifestKey } from '../entity-keys'
import { mapEntityIo } from './io'
import { decodeSitemapProjectionManifest, selectSitemapProjectionFiles } from './sitemap-projection'
import { applySitemapDeltaFiles, createSitemapUrlState, dateInRange, readSitemapDeltaFiles, SITEMAP_URLS_EVENT_PREFIX_RE } from './sitemap-shared'

export function createSitemapReadStore(opts: CreateSitemapReadStoreOptions): SitemapReadStore {
  const ds = opts.dataSource
  const hash = opts.hash ?? hashUrl

  async function readJson<T>(key: string): Promise<T | undefined> {
    const bytes = await readOptional(ds, key)
    return bytes === undefined
      ? undefined
      : JSON.parse(new TextDecoder().decode(bytes)) as T
  }

  return {
    async loadIndex(ctx) {
      return (await readJson<SitemapIndex>(sitemapIndexKey(ctx))) ?? { version: 1, records: {} }
    },

    async getLatest(ctx, path) {
      const index = await readJson<SitemapIndex>(sitemapIndexKey(ctx))
      return index?.records[hash(path)]
    },

    async* loadUrls(ctx, feedpath, loadOpts) {
      const feedpathHash = hash(feedpath)
      const listedDeltaKeys = (await ds.list(`${sitemapUrlsPrefix(ctx)}/deltas/`))
        .filter(key => parseSitemapUrlsDeltaKey(key)?.feedpathHash === feedpathHash)
      // Load listed delta bytes before reading the projection watermark. A
      // compactor may publish a newer base while this read is in flight; the
      // grace window keeps these bytes available until every pre-publish
      // reader has finished.
      const listedDeltaFiles = await readSitemapDeltaFiles(ds, listedDeltaKeys)
      const manifestBytes = await readOptional(ds, sitemapUrlsProjectionManifestKey(ctx))
      const manifest = manifestBytes
        ? decodeSitemapProjectionManifest(new TextDecoder().decode(manifestBytes))
        : undefined
      // Base publication precedes the manifest watermark. Reading the base
      // after the manifest prevents the stale combination of old base plus new
      // watermark, which would filter the only delta carrying the new state.
      const indexRows = await readOptional(ds, sitemapUrlsIndexKey(ctx, feedpathHash))
        .then(bytes => bytes ? decodeParquetToRows(bytes) : [])
      const currentDeltaKeys = new Set(
        selectSitemapProjectionFiles([], listedDeltaKeys, manifest).deltaKeys,
      )
      const state = createSitemapUrlState(indexRows)
      applySitemapDeltaFiles(
        state,
        listedDeltaFiles.filter(file => currentDeltaKeys.has(file.key)),
      )
      for (const record of state.live.values())
        yield record
      if (loadOpts?.includeRemoved) {
        for (const record of state.removed.values())
          yield record
      }
    },

    async* loadDeltas(ctx, dateRange) {
      const [listedKeys, manifestBytes] = await Promise.all([
        ds.list(`${sitemapUrlsPrefix(ctx)}/deltas/`),
        readOptional(ds, sitemapUrlsProjectionManifestKey(ctx)),
      ])
      const manifest = manifestBytes
        ? decodeSitemapProjectionManifest(new TextDecoder().decode(manifestBytes))
        : undefined
      const keys = selectSitemapProjectionFiles([], listedKeys, manifest).deltaKeys.filter((key) => {
        const parsed = parseSitemapUrlsDeltaKey(key)
        return Boolean(parsed && dateInRange(parsed.date, dateRange))
      })
      const files = await readSitemapDeltaFiles(ds, keys)
      for (const file of files) {
        for (const row of file.rows) {
          const op = String(row.op)
          if (op !== 'added' && op !== 'removed')
            continue
          yield {
            feedpath: String(row.feedpath),
            feedpathHash: String(row.feedpath_hash),
            urlHash: String(row.url_hash),
            op,
            loc: String(row.loc),
            lastmod: row.lastmod == null ? undefined : String(row.lastmod),
            at: Number(row.at),
          }
        }
      }
    },

    async* loadEvents(ctx, dateRange) {
      // List immutable events before pending descriptors. A concurrent writer
      // publishes its descriptor first, so any event visible in this listing is
      // either already committed or will be excluded by the later pending read.
      const listedEventKeys = await ds.list(`${sitemapUrlsEventsPrefix(ctx)}/`)
      const pendingKeys = await ds.list(`${sitemapUrlsPendingGenerationsPrefix(ctx)}/`)
      const pendingEvents = new Set(
        (await mapEntityIo(pendingKeys, key => readJson<SitemapPendingGeneration>(key)))
          .filter((pending): pending is SitemapPendingGeneration => pending !== undefined)
          .map(pending => pending.eventKey),
      )
      const keys = listedEventKeys
        .filter((key) => {
          const match = SITEMAP_URLS_EVENT_PREFIX_RE.exec(key)
          return !pendingEvents.has(key)
            && Boolean(match?.[1] && dateInRange(match[1], dateRange))
        })
        .sort()
      for (const key of keys) {
        const bytes = await readOptional(ds, key)
        if (!bytes)
          continue
        const rows = await decodeParquetToRows(bytes)
        rows.sort((a, b) =>
          Number(a.observed_at) - Number(b.observed_at)
          || Number(a.sequence) - Number(b.sequence)
          || String(a.url_hash).localeCompare(String(b.url_hash)),
        )
        for (const row of rows) {
          const op = String(row.op)
          if (op !== 'added' && op !== 'removed')
            continue
          yield {
            feedpath: String(row.feedpath),
            feedpathHash: String(row.feedpath_hash),
            urlHash: String(row.url_hash),
            op,
            loc: String(row.loc),
            lastmod: row.lastmod == null ? undefined : String(row.lastmod),
            generationId: String(row.generation_id),
            observedAt: Number(row.observed_at),
            sequence: Number(row.sequence),
            projectsState: Boolean(row.projects_state),
          }
        }
      }
    },
  }
}

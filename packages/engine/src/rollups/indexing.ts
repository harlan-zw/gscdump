import type { SitemapSiteGenerationManifest } from '../entities'
import type { RollupDef } from './core'
import { readOptional } from '../adapters/read-optional'
import {
  createIndexingMetadataStore,
  createSitemapReadStore,
  inspectionParquetKey,
} from '../entities'
import { DEFAULT_SEARCH_TYPE } from '../layout'
import { utcDateMinusDays } from './dates'
import { partitionsInRange } from './windows'

/**
 * Aggregates the per-URL Indexing API metadata entity store (populated by
 * `gscdump entities indexing snapshot`) into daily counts of `URL_UPDATED`
 * and `URL_REMOVED` notifications. Covers the third entity-snapshot shape
 * without needing its own parquet family — publish events are sparse and
 * aggregate cleanly into a small JSON rollup.
 *
 * Safe no-op when the entity store is empty: returns `{ totals: {...}, days: [] }`
 * so downstream readers don't have to special-case first-run sites.
 */
export const indexingMetadataRollup: RollupDef = {
  id: 'indexing_metadata',
  windowDays: null,
  async build({ dataSource, ctx }) {
    const store = createIndexingMetadataStore({ dataSource })
    const index = await store.loadIndex(ctx)
    const records = Object.values(index.records)

    const updatesByDay = new Map<string, number>()
    const removesByDay = new Map<string, number>()
    let totalUpdates = 0
    let totalRemoves = 0
    let latestUpdate: string | undefined
    let latestRemove: string | undefined

    for (const r of records) {
      if (r.latestUpdateAt) {
        totalUpdates++
        const day = r.latestUpdateAt.slice(0, 10)
        updatesByDay.set(day, (updatesByDay.get(day) ?? 0) + 1)
        if (!latestUpdate || r.latestUpdateAt > latestUpdate)
          latestUpdate = r.latestUpdateAt
      }
      if (r.latestRemoveAt) {
        totalRemoves++
        const day = r.latestRemoveAt.slice(0, 10)
        removesByDay.set(day, (removesByDay.get(day) ?? 0) + 1)
        if (!latestRemove || r.latestRemoveAt > latestRemove)
          latestRemove = r.latestRemoveAt
      }
    }

    const days = new Set<string>([...updatesByDay.keys(), ...removesByDay.keys()])
    const perDay = Array.from(days)
      .sort()
      .map(day => ({
        day,
        updates: updatesByDay.get(day) ?? 0,
        removes: removesByDay.get(day) ?? 0,
      }))

    return {
      totals: {
        urls: records.length,
        updates: totalUpdates,
        removes: totalRemoves,
        latestUpdateAt: latestUpdate ?? null,
        latestRemoveAt: latestRemove ?? null,
      },
      days: perDay,
    }
  },
}

// ---------------------------------------------------------------------------
// §C: Indexing & sitemap rollups (replaces D1 timeseries tables)
// ---------------------------------------------------------------------------

/**
 * Indexing-API health by day: per `inspectedAt` date, counts of indexed,
 * soft-404, redirect, not-found, mobile passes, rich-results passes, and
 * canonical mismatches. Sourced from the inspections parquet sidecar
 * (`InspectionStore.parquetUri`), which holds the latest record per URL.
 *
 * Empty-payload no-op when the sidecar URI is unavailable (in-memory
 * `DataSource`, or before `materialize` has run).
 */
export const indexingHealthRollup: RollupDef = {
  id: 'indexing_health',
  windowDays: 90,
  sliceOrthogonal: true,
  async build({ engine, ctx, dataSource, windowAnchorMs }) {
    // Skip when the parquet sidecar hasn't been materialized yet. We probe
    // with `head` (cheap; no body) rather than `parquetUri` because we now
    // route the read through `fileSets.keys` so DuckDB pre-fetches bytes —
    // the URI itself is no longer the gate.
    const key = inspectionParquetKey(ctx)
    const exists = await dataSource.head?.(key)
    if (!exists)
      return { days: [] }
    const cutoff = utcDateMinusDays(windowAnchorMs, 90)
    // `read_parquet({{INSPECTIONS}}, union_by_name = true)` flows through the
    // executor's prefetch path: bytes are read via the `DataSource` (R2
    // binding) and registered as a virtual file before query. Crucial under
    // the duckdb-worker, whose httpfs path bypasses `r2://` URIs (see
    // docs/repros/ducklings-r2-httpfs.md).
    //
    // Explicit `CAST(... AS VARCHAR)` per string column: DuckDB-WASM
    // (ducklings) mis-types all-null UTF8 parquet columns as INT32, which
    // makes `<col> = 'PASS'` fail with a string-to-INT32 conversion error on
    // small sites where every row's verdict is null. The cast forces the
    // string interpretation regardless of inference.
    const sql = `
      SELECT
        substr(CAST(inspectedAt AS VARCHAR), 1, 10) AS date,
        COUNT(*)::BIGINT AS total_urls,
        SUM(CASE WHEN CAST(indexStatus AS VARCHAR) = 'PASS' THEN 1 ELSE 0 END)::BIGINT AS indexed_count,
        SUM(CASE WHEN CAST(pageFetchState AS VARCHAR) = 'SOFT_404' THEN 1 ELSE 0 END)::BIGINT AS soft_404,
        SUM(CASE WHEN CAST(pageFetchState AS VARCHAR) = 'REDIRECT_ERROR' THEN 1 ELSE 0 END)::BIGINT AS redirect,
        SUM(CASE WHEN CAST(pageFetchState AS VARCHAR) = 'NOT_FOUND' THEN 1 ELSE 0 END)::BIGINT AS not_found,
        SUM(CASE WHEN CAST(mobileUsabilityVerdict AS VARCHAR) = 'PASS' THEN 1 ELSE 0 END)::BIGINT AS mobile_passes,
        SUM(CASE WHEN CAST(richResultsVerdict AS VARCHAR) = 'PASS' THEN 1 ELSE 0 END)::BIGINT AS rich_results_passes,
        SUM(CASE WHEN canonicalMismatchKind IN ('path', 'cross_domain') THEN 1 ELSE 0 END)::BIGINT AS canonical_mismatches
      FROM read_parquet({{INSPECTIONS}}, union_by_name = true)
      WHERE substr(CAST(inspectedAt AS VARCHAR), 1, 10) >= '${cutoff}'
      GROUP BY 1
      ORDER BY 1
    `
    const result = await engine.runSQL({
      ctx,
      table: 'pages',
      fileSets: { INSPECTIONS: { table: 'pages', keys: [key] } },
      sql,
    })
    return {
      days: result.rows.map(r => ({
        date: String(r.date),
        total_urls: Number(r.total_urls),
        indexed_count: Number(r.indexed_count),
        soft_404: Number(r.soft_404),
        redirect: Number(r.redirect),
        not_found: Number(r.not_found),
        mobile_passes: Number(r.mobile_passes),
        rich_results_passes: Number(r.rich_results_passes),
        canonical_mismatches: Number(r.canonical_mismatches),
      })),
    }
  },
}

/**
 * Per-day index-percent: ratio of (sitemap URLs that received GSC clicks on
 * that date) / (total published sitemap URLs). The published generation
 * manifest supplies the exact immutable feed bases. No storage listing or
 * derived projection participates in authority.
 */
export const indexPercentRollup: RollupDef = {
  id: 'index_percent',
  windowDays: 90,
  sliceOrthogonal: true,
  async build({ engine, ctx, dataSource, windowAnchorMs, searchType }) {
    const generation = await createSitemapReadStore({ dataSource }).getSitemapGeneration(ctx)
    if (generation._tag === 'unavailable')
      return { totalSitemapUrls: 0, days: [] }
    const baseKeys = Object.values(generation.manifest.feeds)
      .sort((left, right) => left.feedpath.localeCompare(right.feedpath))
      .map(feed => feed.baseKey)
    if (baseKeys.length === 0)
      return { totalSitemapUrls: 0, days: [] }
    const sitemapFileSets = {
      SITEMAP_BASES: { table: 'pages' as const, keys: baseKeys },
    }
    const currentMembership = 'read_parquet({{SITEMAP_BASES}}, union_by_name = true)'
    const cutoff = utcDateMinusDays(windowAnchorMs, 90)
    // Numerator: per-day distinct sitemap URLs with clicks>0. This rollup is
    // written at the legacy path, so omitted searchType means the web slice,
    // not a cross-type union. URLS is a direct-keys
    // sidecar (entity store, not slice-partitioned) so searchType doesn't
    // apply to it.
    const factSearchType = searchType ?? DEFAULT_SEARCH_TYPE
    const pagesParts = await engine.listPartitions({
      ctx,
      table: 'pages',
      searchType: factSearchType,
    })
    const pagesPartitions = partitionsInRange(pagesParts, cutoff, utcDateMinusDays(windowAnchorMs, 0))
    const numerator = await engine.runSQL({
      ctx,
      table: 'pages',
      fileSets: {
        PAGES: { table: 'pages', partitions: pagesPartitions },
        ...sitemapFileSets,
      },
      searchType: factSearchType,
      sql: `
        SELECT
          p.date AS date,
          COUNT(DISTINCT p.url)::BIGINT AS clicked_urls
        FROM read_parquet({{PAGES}}, union_by_name = true) p
        INNER JOIN ${currentMembership} s
          ON s.loc = p.url
        WHERE p.clicks > 0 AND p.date >= '${cutoff}'
        GROUP BY p.date
        ORDER BY p.date
      `,
    })
    // Denominator: total live sitemap URLs
    const denom = await engine.runSQL({
      ctx,
      table: 'pages',
      fileSets: sitemapFileSets,
      sql: `
        SELECT COUNT(DISTINCT loc)::BIGINT AS total
        FROM ${currentMembership}
      `,
    })
    const total = Number(denom.rows[0]?.total ?? 0)
    return {
      totalSitemapUrls: total,
      days: numerator.rows.map((r) => {
        const clicked = Number(r.clicked_urls)
        return {
          date: String(r.date),
          clicked_urls: clicked,
          total_sitemap_urls: total,
          ratio: total === 0 ? 0 : clicked / total,
        }
      }),
    }
  },
}

const SITEMAP_HEALTH_GENERATION_LIMIT = 10_000

async function loadSitemapGenerationAncestry(
  dataSource: Parameters<typeof readOptional>[0],
  current: SitemapSiteGenerationManifest,
  cutoff: string,
): Promise<SitemapSiteGenerationManifest[]> {
  const ancestry: SitemapSiteGenerationManifest[] = []
  const seen = new Set<string>()
  let cursor: SitemapSiteGenerationManifest | undefined = current
  while (cursor) {
    const day = new Date(cursor.observedAt).toISOString().slice(0, 10)
    if (day < cutoff)
      break
    if (ancestry.length >= SITEMAP_HEALTH_GENERATION_LIMIT)
      throw new Error('sitemap health generation ancestry limit exceeded')
    ancestry.push(cursor)
    if (!cursor.previousManifestKey)
      break
    if (seen.has(cursor.previousManifestKey))
      throw new Error('sitemap generation manifest ancestry cycle')
    seen.add(cursor.previousManifestKey)
    const bytes = await readOptional(dataSource, cursor.previousManifestKey)
    if (!bytes)
      throw new Error('sitemap generation manifest ancestry is incomplete')
    const previous = JSON.parse(new TextDecoder().decode(bytes)) as SitemapSiteGenerationManifest
    if (previous.generationId !== cursor.previousGenerationId)
      throw new Error('sitemap generation manifest ancestry is incomplete')
    cursor = previous
  }
  return ancestry
}

/**
 * Sitemap-health history derives exclusively from published complete
 * generations. The newest generation observed on each day is retained.
 */
export const sitemapHealthRollup: RollupDef = {
  id: 'sitemap_health',
  windowDays: 90,
  sliceOrthogonal: true,
  async build({ dataSource, ctx, windowAnchorMs }) {
    const store = createSitemapReadStore({ dataSource })
    const generation = await store.getSitemapGeneration(ctx)
    if (generation._tag === 'unavailable')
      return { days: [], feeds: [] }
    const cutoff = utcDateMinusDays(windowAnchorMs, 90)
    const ancestry = await loadSitemapGenerationAncestry(dataSource, generation.manifest, cutoff)
    const byDay = new Map<string, {
      day: string
      feeds: number
      total_urls: number
      errors: number
      warnings: number
    }>()
    for (const manifest of ancestry) {
      const day = new Date(manifest.observedAt).toISOString().slice(0, 10)
      if (byDay.has(day))
        continue
      const manifestFeeds = Object.values(manifest.feeds)
      byDay.set(day, {
        day,
        feeds: manifestFeeds.length,
        total_urls: manifestFeeds.reduce((total, feed) => total + feed.urlCount, 0),
        errors: 0,
        warnings: 0,
      })
    }

    const days = Array.from(byDay.values()).sort((a, b) => (a.day < b.day ? -1 : 1))
    const capturedAt = new Date(generation.manifest.observedAt).toISOString()
    const feeds = Object.values(generation.manifest.feeds)
      .sort((left, right) => left.feedpath.localeCompare(right.feedpath))
      .map(feed => ({
        path: feed.feedpath,
        urlCount: feed.urlCount,
        errors: 0,
        warnings: 0,
        contentHash: feed.payloadHash,
        lastDownloaded: null,
        capturedAt,
      }))
    return { days, feeds }
  },
}

interface RecentSitemapChange {
  loc: string
  feedpath: string
  at: number
  sequence: number
}

const RECENT_SITEMAP_CHANGE_LIMIT = 200

function isLessRecent(a: RecentSitemapChange, b: RecentSitemapChange): boolean {
  return a.at < b.at || (a.at === b.at && a.sequence > b.sequence)
}

/** Keep the newest changes in a worst-first min-heap, preserving stable ties. */
function retainRecentSitemapChange(heap: RecentSitemapChange[], change: RecentSitemapChange): void {
  if (heap.length < RECENT_SITEMAP_CHANGE_LIMIT) {
    heap.push(change)
    let index = heap.length - 1
    while (index > 0) {
      const parent = (index - 1) >> 1
      if (!isLessRecent(heap[index]!, heap[parent]!))
        break
      const parentValue = heap[parent]!
      heap[parent] = heap[index]!
      heap[index] = parentValue
      index = parent
    }
    return
  }

  if (!isLessRecent(heap[0]!, change))
    return
  heap[0] = change
  let index = 0
  for (;;) {
    const left = index * 2 + 1
    const right = left + 1
    let leastRecent = index
    if (left < heap.length && isLessRecent(heap[left]!, heap[leastRecent]!))
      leastRecent = left
    if (right < heap.length && isLessRecent(heap[right]!, heap[leastRecent]!))
      leastRecent = right
    if (leastRecent === index)
      return
    const childValue = heap[leastRecent]!
    heap[leastRecent] = heap[index]!
    heap[index] = childValue
    index = leastRecent
  }
}

/**
 * Trailing-28-day sitemap URL changes: per-day per-feedpath {added, removed}
 * counts plus rolling top-200 added and removed URLs. Streams from
 * retained `SitemapReadStore.loadEvents()` history. State compaction cannot
 * erase analytics input; memory scales independently of total site state.
 */
export const sitemapChanges28dRollup: RollupDef = {
  id: 'sitemap_changes_28d',
  windowDays: 28,
  sliceOrthogonal: true,
  async build({ dataSource, ctx, windowAnchorMs }) {
    const store = createSitemapReadStore({ dataSource })
    const from = utcDateMinusDays(windowAnchorMs, 28)
    const to = utcDateMinusDays(windowAnchorMs, 0)

    interface DayKey {
      day: string
      feedpath: string
    }
    const counts = new Map<string, { day: string, feedpath: string, added: number, removed: number }>()
    const addedTop: RecentSitemapChange[] = []
    const removedTop: RecentSitemapChange[] = []
    let sequence = 0

    function key(k: DayKey): string {
      return `${k.day}\x00${k.feedpath}`
    }

    for await (const d of store.loadEvents(ctx, { from, to })) {
      if (d.op === 'updated')
        continue
      const day = new Date(d.observedAt).toISOString().slice(0, 10)
      const k = key({ day, feedpath: d.feedpath })
      const cur = counts.get(k) ?? { day, feedpath: d.feedpath, added: 0, removed: 0 }
      const change = { loc: d.loc, feedpath: d.feedpath, at: d.observedAt, sequence: sequence++ }
      if (d.op === 'added') {
        cur.added += 1
        retainRecentSitemapChange(addedTop, change)
      }
      else {
        cur.removed += 1
        retainRecentSitemapChange(removedTop, change)
      }
      counts.set(k, cur)
    }

    const days = Array.from(counts.values()).sort((a, b) => {
      if (a.day !== b.day)
        return a.day < b.day ? -1 : 1
      return a.feedpath < b.feedpath ? -1 : 1
    })
    // The heaps are bounded while streaming; only the retained 200 need sorting.
    const toRecentList = (heap: RecentSitemapChange[]): Array<{ loc: string, feedpath: string, at: number }> => heap
      .sort((a, b) => b.at - a.at || a.sequence - b.sequence)
      .map(({ loc, feedpath, at }) => ({ loc, feedpath, at }))
    return {
      days,
      topAdded: toRecentList(addedTop),
      topRemoved: toRecentList(removedTop),
    }
  },
}

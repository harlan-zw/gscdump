// Local entity I/O for `sync` and `dump`: the Search Console sitemap list,
// sitemap URL generations, and URL Inspection history. The engine owns the
// storage layout; this module wires it to the CLI and shapes dump rows.

import type { InspectionParquetRow, InspectionRecord, ParsedUrl, SitemapListDoc, SitemapListEntry } from '@gscdump/engine/entities'
import type { EncodeFlexOptions } from '@gscdump/engine/hyparquet'
import type { googleSearchConsole } from 'gscdump/client'
import type { ApiSitemap } from 'gscdump/sites'
import type { DataSource, Row, TenantCtx } from './local-store'
import {
  createIndexingMetadataStore,
  createInspectionStore,
  createSitemapListStore,
  createSitemapReadStore,
  createSitemapStore,
  hashUrl,
  parseSitemapFeedIdentity,
} from '@gscdump/engine/entities'
import { latestByUrl, planInspections, recentMonths, scheduleOf, toInspectionRecord } from './inspection-record'
import { runWithConcurrency } from './utils'

type GscClient = ReturnType<typeof googleSearchConsole>
type ColumnDefs = EncodeFlexOptions['columns']

// ---------------------------------------------------------------------------
// Inspection history
// ---------------------------------------------------------------------------

/** Every stored inspection record for the site, oldest month first. */
export async function loadInspectionHistory(dataSource: DataSource, ctx: TenantCtx): Promise<InspectionRecord[]> {
  const inspector = createInspectionStore({ dataSource })
  const months = await inspector.listHistoryMonths(ctx)
  const records: InspectionRecord[] = []
  for (const month of months) {
    const shard = await inspector.loadHistory(ctx, month)
    if (shard)
      records.push(...shard.records)
  }
  return records
}

/** What planning and recording need: the newest record per URL and the last 24 hours of calls. */
export interface InspectionState {
  latest: Map<string, InspectionRecord>
  recent: InspectionRecord[]
}

/**
 * Read the newest record per URL from `index.parquet` and only the history
 * months that cover the last 24 hours. A Store without an index falls back
 * to the full history once; the next recorded batch writes the index.
 */
export async function loadInspectionState(dataSource: DataSource, ctx: TenantCtx, now: Date): Promise<InspectionState> {
  const inspector = createInspectionStore({ dataSource })
  const indexed = await inspector.loadMaterialized(ctx)
  if (!indexed) {
    const history = await loadInspectionHistory(dataSource, ctx)
    return { latest: latestByUrl(history), recent: history }
  }
  const recent: InspectionRecord[] = []
  for (const month of recentMonths(now)) {
    const shard = await inspector.loadHistory(ctx, month)
    if (shard)
      recent.push(...shard.records)
  }
  return { latest: latestByUrl([...indexed.map(fromParquetRow), ...recent]), recent }
}

function fromParquetRow(row: InspectionParquetRow): InspectionRecord {
  const record: InspectionRecord = { url: row.url, inspectedAt: row.inspectedAt }
  for (const field of ['indexStatus', 'lastCrawlTime', 'googleCanonical', 'userCanonical', 'coverageState', 'robotsTxtState', 'indexingState', 'pageFetchState', 'mobileUsabilityVerdict', 'richResultsVerdict'] as const) {
    const value = row[field]
    if (value != null)
      record[field] = value
  }
  if (row.scheduleNextAt != null && row.scheduleConsecutiveUnchanged != null && row.schedulePolicyVersion != null) {
    record.raw = {
      schedule: {
        nextAt: row.scheduleNextAt,
        consecutiveUnchanged: row.scheduleConsecutiveUnchanged,
        policyVersion: row.schedulePolicyVersion,
      },
    }
  }
  return record
}

function toParquetRow(record: InspectionRecord): InspectionParquetRow {
  const schedule = scheduleOf(record)
  return {
    urlHash: hashUrl(record.url),
    url: record.url,
    inspectedAt: record.inspectedAt,
    indexStatus: record.indexStatus ?? null,
    lastCrawlTime: record.lastCrawlTime ?? null,
    googleCanonical: record.googleCanonical ?? null,
    userCanonical: record.userCanonical ?? null,
    coverageState: record.coverageState ?? null,
    robotsTxtState: record.robotsTxtState ?? null,
    indexingState: record.indexingState ?? null,
    pageFetchState: record.pageFetchState ?? null,
    mobileUsabilityVerdict: record.mobileUsabilityVerdict ?? null,
    richResultsVerdict: record.richResultsVerdict ?? null,
    scheduleNextAt: schedule.nextAt,
    scheduleConsecutiveUnchanged: schedule.consecutiveUnchanged,
    schedulePolicyVersion: schedule.policyVersion,
  }
}

/** Append inspection records to the history. One call writes one shard, so a caller can save each result as it arrives. */
export async function appendInspections(dataSource: DataSource, ctx: TenantCtx, records: readonly InspectionRecord[]): Promise<void> {
  if (records.length > 0)
    await createInspectionStore({ dataSource }).appendHistory(ctx, records)
}

/**
 * Rewrite the latest-per-URL `index.parquet` from the previous newest record
 * per URL plus the new records, so DuckDB readers see the newest state.
 */
export async function materializeInspectionIndex(
  dataSource: DataSource,
  ctx: TenantCtx,
  latest: ReadonlyMap<string, InspectionRecord>,
  records: readonly InspectionRecord[],
): Promise<{ indexKey: string, indexRows: number }> {
  const merged = latestByUrl([...latest.values(), ...records])
  const result = await createInspectionStore({ dataSource }).materialize(ctx, [...merged.values()].map(toParquetRow))
  return { indexKey: result.key, indexRows: result.rowCount }
}

/**
 * Append new inspection records to the history, then rewrite the
 * latest-per-URL `index.parquet` so DuckDB readers see the newest state.
 */
export async function recordInspections(
  dataSource: DataSource,
  ctx: TenantCtx,
  latest: ReadonlyMap<string, InspectionRecord>,
  records: readonly InspectionRecord[],
): Promise<{ indexKey: string, indexRows: number } | undefined> {
  if (records.length === 0)
    return undefined
  await appendInspections(dataSource, ctx, records)
  return materializeInspectionIndex(dataSource, ctx, latest, records)
}

/** True when `url` belongs to the Search Console property `siteUrl`. */
export function urlInProperty(siteUrl: string, url: string): boolean {
  let parsed: URL
  try {
    parsed = new URL(url)
  }
  catch {
    return false
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')
    return false
  if (siteUrl.startsWith('sc-domain:')) {
    const domain = siteUrl.slice('sc-domain:'.length).toLowerCase()
    const host = parsed.hostname.toLowerCase()
    return host === domain || host.endsWith(`.${domain}`)
  }
  return url.startsWith(siteUrl)
}

/**
 * Turn stored page paths into absolute URLs. The analytics tables keep only
 * the path. A URL-prefix property supplies its own origin. A domain property
 * uses the most common origin among `knownUrls` (sitemap URLs), else
 * `https://<domain>`.
 */
export function resolvePagePaths(paths: readonly string[], siteUrl: string, knownUrls: readonly string[]): string[] {
  let origin: string | undefined
  if (siteUrl.startsWith('sc-domain:')) {
    const counts = new Map<string, number>()
    for (const url of knownUrls) {
      if (!urlInProperty(siteUrl, url))
        continue
      const o = new URL(url).origin
      counts.set(o, (counts.get(o) ?? 0) + 1)
    }
    origin = [...counts].sort((a, b) => b[1] - a[1])[0]?.[0] ?? `https://${siteUrl.slice('sc-domain:'.length)}`
  }
  const out: string[] = []
  for (const value of paths) {
    try {
      out.push(new URL(value, origin ?? siteUrl).toString())
    }
    catch {
      // A malformed stored path cannot be inspected; leave it out.
    }
  }
  return out
}

export type InspectionSyncResult
  = | {
    _tag: 'inspected'
    inspected: number
    failed: number
    failures: Array<{ url: string, error: string }>
    deferred: number
    quotaLeft: number
  }
  | { _tag: 'nothing_due', candidates: number, quotaLeft: number }

/**
 * Inspect the URLs due under the engine's inspection policy, up to `limit`
 * and the daily quota, and append the results to the inspection history.
 * Per-URL API failures are counted; a storage failure rejects.
 */
export async function syncInspections(deps: {
  client: Pick<GscClient, 'inspect'>
  dataSource: DataSource
  ctx: TenantCtx
  siteUrl: string
  candidates: readonly string[]
  limit: number
  concurrency: number
  now: () => Date
  onProgress?: (done: number, total: number) => void
}): Promise<InspectionSyncResult> {
  const { latest, recent } = await loadInspectionState(deps.dataSource, deps.ctx, deps.now())
  const candidates = deps.candidates.filter(url => urlInProperty(deps.siteUrl, url))
  const plan = planInspections({ candidates, latest, recent, now: deps.now(), limit: deps.limit })
  if (plan.urls.length === 0)
    return { _tag: 'nothing_due', candidates: candidates.length, quotaLeft: plan.quotaLeft }

  const records: InspectionRecord[] = []
  const failures: Array<{ url: string, error: string }> = []
  let done = 0
  await runWithConcurrency(plan.urls, deps.concurrency, async (url) => {
    const response = await deps.client.inspect(deps.siteUrl, url).catch((error: Error) => error)
    if (response instanceof Error) {
      failures.push({ url, error: response.message })
    }
    else {
      records.push(toInspectionRecord({
        url,
        result: response.inspectionResult,
        inspectedAt: deps.now(),
        previous: latest.get(url),
      }))
    }
    done++
    deps.onProgress?.(done, plan.urls.length)
  })

  await recordInspections(deps.dataSource, deps.ctx, latest, records)
  return {
    _tag: 'inspected',
    inspected: records.length,
    failed: failures.length,
    failures,
    deferred: plan.deferred,
    quotaLeft: Math.max(0, plan.quotaLeft - plan.urls.length),
  }
}

// ---------------------------------------------------------------------------
// Sitemaps
// ---------------------------------------------------------------------------

export type LoadFeedResult
  = | { _tag: 'ok', entries: ParsedUrl[], complete: boolean }
    | { _tag: 'error', message: string }

export type FeedOutcome
  = | { _tag: 'read', path: string, urls: number, complete: boolean }
    | { _tag: 'unreachable', path: string, message: string }

export type SitemapSyncResult
  = | {
    _tag: 'saved'
    sitemaps: number
    urls: number
    feeds: FeedOutcome[]
    generation: 'published' | 'unchanged'
  }
  | {
    /** The list was saved; the stored URL generation was kept as it was. */
    _tag: 'list_only'
    sitemaps: number
    feeds: FeedOutcome[]
    reason: string
  }
  | { _tag: 'failed', reason: string }

function toCount(value: string | null | undefined): number {
  const n = Number(value)
  return Number.isFinite(n) ? n : 0
}

export function toSitemapListEntry(sitemap: ApiSitemap): SitemapListEntry | undefined {
  if (!sitemap.path)
    return undefined
  return {
    path: sitemap.path,
    type: sitemap.type ?? null,
    isPending: sitemap.isPending ?? false,
    isSitemapsIndex: sitemap.isSitemapsIndex ?? false,
    lastSubmitted: sitemap.lastSubmitted ?? null,
    lastDownloaded: sitemap.lastDownloaded ?? null,
    warnings: toCount(sitemap.warnings),
    errors: toCount(sitemap.errors),
    contents: (sitemap.contents ?? []).map(content => ({
      type: content.type ?? 'unknown',
      submitted: toCount(content.submitted),
      indexed: content.indexed == null ? null : toCount(content.indexed),
    })),
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Save the Search Console sitemap list, then read each listed feed and
 * publish one sitemap URL generation. A feed that cannot be read is left out
 * of the generation, unless the stored generation already has it: then the
 * stored generation is kept, so a transient failure never drops its URLs.
 */
export async function syncSitemaps(deps: {
  client: Pick<GscClient, 'sitemaps'>
  dataSource: DataSource
  ctx: TenantCtx
  siteUrl: string
  loadFeed: (url: string) => Promise<LoadFeedResult>
  now: () => Date
  generationId: () => string
}): Promise<SitemapSyncResult> {
  const listed = await deps.client.sitemaps.list(deps.siteUrl).catch((error: unknown) => new Error(errorMessage(error)))
  if (listed instanceof Error)
    return { _tag: 'failed', reason: `Search Console sitemap list failed: ${listed.message}` }

  const fetchedAt = deps.now()
  const sitemaps = listed.flatMap(sitemap => toSitemapListEntry(sitemap) ?? [])
  const doc: SitemapListDoc = { version: 1, fetchedAt: fetchedAt.toISOString(), sitemaps }
  await createSitemapListStore({ dataSource: deps.dataSource }).save(deps.ctx, doc)

  // One local process writes the store, so the mutation lock is a pass-through.
  const store = createSitemapStore({
    dataSource: deps.dataSource,
    withMutation: (_ctx, effect) => effect(),
    now: () => deps.now().getTime(),
  })
  const current = await store.getSitemapGeneration(deps.ctx)
  const published = new Set(current._tag === 'available'
    ? Object.values(current.manifest.feeds).map(feed => feed.feedpath)
    : [])
  if (sitemaps.length === 0 && published.size === 0)
    return { _tag: 'saved', sitemaps: 0, urls: 0, feeds: [], generation: 'unchanged' }

  const generation = { _tag: 'complete' as const, id: deps.generationId(), observedAt: fetchedAt.getTime() }
  const feeds: FeedOutcome[] = []
  const staged: string[] = []
  let urls = 0
  let keepReason: string | undefined
  for (const sitemap of sitemaps) {
    const loaded = await deps.loadFeed(sitemap.path)
    if (loaded._tag === 'error') {
      feeds.push({ _tag: 'unreachable', path: sitemap.path, message: loaded.message })
      const identity = parseSitemapFeedIdentity(sitemap.path)
      if (identity._tag === 'ok' && published.has(identity.url)) {
        keepReason = `${sitemap.path} could not be read: ${loaded.message}`
        break
      }
      continue
    }
    const result = await store.stageSitemapGenerationFeed(deps.ctx, generation, sitemap.path, loaded.entries)
    if (result._tag !== 'staged') {
      feeds.push({ _tag: 'unreachable', path: sitemap.path, message: `not stored (${result._tag}: ${result.reason})` })
      continue
    }
    staged.push(sitemap.path)
    urls += loaded.entries.length
    feeds.push({ _tag: 'read', path: sitemap.path, urls: loaded.entries.length, complete: loaded.complete })
  }

  if (keepReason) {
    await store.abortSitemapGeneration(deps.ctx, generation)
    return { _tag: 'list_only', sitemaps: sitemaps.length, feeds, reason: keepReason }
  }
  const finalized = await store.finalizeSitemapGeneration(deps.ctx, generation, {
    _tag: 'complete',
    expectedFeedpaths: staged,
  })
  if (finalized._tag === 'published' || finalized._tag === 'unchanged')
    return { _tag: 'saved', sitemaps: sitemaps.length, urls, feeds, generation: finalized._tag }
  await store.abortSitemapGeneration(deps.ctx, generation)
  return { _tag: 'list_only', sitemaps: sitemaps.length, feeds, reason: `sitemap URLs not stored: ${finalized._tag}` }
}

/** Every URL in the stored sitemap generation. Empty when none was published. */
export async function loadSitemapGenerationUrls(dataSource: DataSource, ctx: TenantCtx): Promise<string[]> {
  const result = await createSitemapReadStore({ dataSource }).iterateSitemapGenerationUrls(ctx)
  if (result._tag !== 'iterator')
    return []
  const urls: string[] = []
  for await (const record of result.items)
    urls.push(record.loc)
  return urls
}

// ---------------------------------------------------------------------------
// Dump datasets
// ---------------------------------------------------------------------------

export const ENTITY_DATASETS = ['inspections', 'inspection_history', 'sitemaps', 'sitemap_urls', 'indexing_metadata'] as const
export type EntityDataset = typeof ENTITY_DATASETS[number]

export function isEntityDataset(name: string): name is EntityDataset {
  return (ENTITY_DATASETS as readonly string[]).includes(name)
}

export interface EntityDatasetRows {
  dataset: EntityDataset
  columns: ColumnDefs
  rows: Row[]
}

const INSPECTION_COLUMNS: ColumnDefs = [
  { name: 'url', type: 'VARCHAR', nullable: false },
  { name: 'inspected_at', type: 'VARCHAR', nullable: false },
  { name: 'index_status', type: 'VARCHAR', nullable: true },
  { name: 'coverage_state', type: 'VARCHAR', nullable: true },
  { name: 'indexing_state', type: 'VARCHAR', nullable: true },
  { name: 'page_fetch_state', type: 'VARCHAR', nullable: true },
  { name: 'robots_txt_state', type: 'VARCHAR', nullable: true },
  { name: 'last_crawl_time', type: 'VARCHAR', nullable: true },
  { name: 'google_canonical', type: 'VARCHAR', nullable: true },
  { name: 'user_canonical', type: 'VARCHAR', nullable: true },
  { name: 'mobile_usability_verdict', type: 'VARCHAR', nullable: true },
  { name: 'rich_results_verdict', type: 'VARCHAR', nullable: true },
  { name: 'next_check_at', type: 'VARCHAR', nullable: true },
  { name: 'raw', type: 'VARCHAR', nullable: true },
]

const SITEMAP_COLUMNS: ColumnDefs = [
  { name: 'path', type: 'VARCHAR', nullable: false },
  { name: 'type', type: 'VARCHAR', nullable: true },
  { name: 'is_pending', type: 'INTEGER', nullable: false },
  { name: 'is_sitemaps_index', type: 'INTEGER', nullable: false },
  { name: 'last_submitted', type: 'VARCHAR', nullable: true },
  { name: 'last_downloaded', type: 'VARCHAR', nullable: true },
  { name: 'warnings', type: 'BIGINT', nullable: false },
  { name: 'errors', type: 'BIGINT', nullable: false },
  { name: 'submitted', type: 'BIGINT', nullable: false },
  { name: 'contents', type: 'VARCHAR', nullable: false },
  { name: 'fetched_at', type: 'VARCHAR', nullable: false },
]

const SITEMAP_URL_COLUMNS: ColumnDefs = [
  { name: 'sitemap_path', type: 'VARCHAR', nullable: false },
  { name: 'url', type: 'VARCHAR', nullable: false },
  { name: 'lastmod', type: 'VARCHAR', nullable: true },
  { name: 'first_seen_at', type: 'VARCHAR', nullable: false },
  { name: 'last_seen_at', type: 'VARCHAR', nullable: false },
]

const INDEXING_METADATA_COLUMNS: ColumnDefs = [
  { name: 'url', type: 'VARCHAR', nullable: false },
  { name: 'captured_at', type: 'VARCHAR', nullable: false },
  { name: 'latest_update_at', type: 'VARCHAR', nullable: true },
  { name: 'latest_remove_at', type: 'VARCHAR', nullable: true },
]

function inspectionRow(record: InspectionRecord): Row {
  const nextAt = scheduleOf(record).nextAt
  return {
    url: record.url,
    inspected_at: record.inspectedAt,
    index_status: record.indexStatus ?? null,
    coverage_state: record.coverageState ?? null,
    indexing_state: record.indexingState ?? null,
    page_fetch_state: record.pageFetchState ?? null,
    robots_txt_state: record.robotsTxtState ?? null,
    last_crawl_time: record.lastCrawlTime ?? null,
    google_canonical: record.googleCanonical ?? null,
    user_canonical: record.userCanonical ?? null,
    mobile_usability_verdict: record.mobileUsabilityVerdict ?? null,
    rich_results_verdict: record.richResultsVerdict ?? null,
    next_check_at: Number.isFinite(nextAt) && nextAt > 0 ? new Date(nextAt).toISOString() : null,
    raw: record.raw ? JSON.stringify(record.raw) : null,
  }
}

function sitemapRow(entry: SitemapListEntry, fetchedAt: string): Row {
  return {
    path: entry.path,
    type: entry.type,
    is_pending: entry.isPending,
    is_sitemaps_index: entry.isSitemapsIndex,
    last_submitted: entry.lastSubmitted,
    last_downloaded: entry.lastDownloaded,
    warnings: entry.warnings,
    errors: entry.errors,
    submitted: entry.contents.reduce((sum, content) => sum + content.submitted, 0),
    contents: JSON.stringify(entry.contents),
    fetched_at: fetchedAt,
  }
}

async function sitemapUrlRows(dataSource: DataSource, ctx: TenantCtx): Promise<Row[]> {
  const result = await createSitemapReadStore({ dataSource }).iterateSitemapGenerationUrls(ctx)
  if (result._tag !== 'iterator')
    return []
  const rows: Row[] = []
  for await (const record of result.items) {
    rows.push({
      sitemap_path: record.feedpath,
      url: record.loc,
      lastmod: record.lastmod ?? null,
      first_seen_at: new Date(record.firstSeenAt).toISOString(),
      last_seen_at: new Date(record.lastSeenAt).toISOString(),
    })
  }
  return rows
}

/** Read the requested entity datasets for one site as flat rows. */
export async function readEntityDatasets(
  dataSource: DataSource,
  ctx: TenantCtx,
  wanted: readonly EntityDataset[],
): Promise<EntityDatasetRows[]> {
  const want = new Set(wanted)
  const out: EntityDatasetRows[] = []
  if (want.has('inspections') || want.has('inspection_history')) {
    const history = (await loadInspectionHistory(dataSource, ctx))
      .sort((a, b) => a.url.localeCompare(b.url) || a.inspectedAt.localeCompare(b.inspectedAt))
    if (want.has('inspections')) {
      const latest = [...latestByUrl(history).values()].sort((a, b) => a.url.localeCompare(b.url))
      out.push({ dataset: 'inspections', columns: INSPECTION_COLUMNS, rows: latest.map(inspectionRow) })
    }
    if (want.has('inspection_history'))
      out.push({ dataset: 'inspection_history', columns: INSPECTION_COLUMNS, rows: history.map(inspectionRow) })
  }
  if (want.has('sitemaps')) {
    const doc = await createSitemapListStore({ dataSource }).load(ctx)
    out.push({
      dataset: 'sitemaps',
      columns: SITEMAP_COLUMNS,
      rows: doc ? doc.sitemaps.map(entry => sitemapRow(entry, doc.fetchedAt)) : [],
    })
  }
  if (want.has('sitemap_urls'))
    out.push({ dataset: 'sitemap_urls', columns: SITEMAP_URL_COLUMNS, rows: await sitemapUrlRows(dataSource, ctx) })
  if (want.has('indexing_metadata')) {
    const index = await createIndexingMetadataStore({ dataSource }).loadIndex(ctx)
    out.push({
      dataset: 'indexing_metadata',
      columns: INDEXING_METADATA_COLUMNS,
      rows: Object.values(index.records)
        .sort((a, b) => a.url.localeCompare(b.url))
        .map(record => ({
          url: record.url,
          captured_at: record.capturedAt,
          latest_update_at: record.latestUpdateAt ?? null,
          latest_remove_at: record.latestRemoveAt ?? null,
        })),
    })
  }
  return out
}

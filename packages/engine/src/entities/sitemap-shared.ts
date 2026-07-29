import type { ColumnDef, Row, TenantCtx } from '@gscdump/contracts'
import type { DataSource } from '../storage'

export interface ParsedUrl {
  loc: string
  lastmod?: string
}

export interface SitemapUrlRecord {
  feedpath: string
  feedpathHash: string
  urlHash: string
  loc: string
  lastmod?: string
  firstSeenAt: number
  lastSeenAt: number
  removedAt?: number
}

export interface SitemapGenerationFeedManifest {
  feedpath: string
  feedpathHash: string
  baseKey: string
  eventKey: string | null
  membershipHash: string
  payloadHash: string
  urlCount: number
  observedAt: number
}

export type SitemapLegacyImportEvidence
  = | { _tag: 'none' }
    | {
      _tag: 'metadata_only'
      importedAt: number
      recordCount: number
      source: 'gsc_sitemaps'
    }

export interface SitemapSiteGenerationManifest {
  version: 1
  generationId: string
  observedAt: number
  publishedAt: number
  completeness: { _tag: 'complete' }
  membershipHistoryAvailableFrom: number | null
  legacyImport: SitemapLegacyImportEvidence
  previousGenerationId: string | null
  previousManifestKey: string | null
  eventKeys: string[]
  feeds: Record<string, SitemapGenerationFeedManifest>
}

export interface SitemapStagedFeed {
  version: 1
  generationId: string
  observedAt: number
  feed: SitemapGenerationFeedManifest
}

export type StageSitemapGenerationFeedResult
  = | {
    _tag: 'staged'
    generationId: string
    feedpath: string
    membershipChanged: boolean
    payloadChanged: boolean
    added: number
    removed: number
    updated: number
  }
  | { _tag: 'invalid_feed', reason: 'credentials' | 'empty' | 'invalid_url' | 'unsupported_protocol' }
  | { _tag: 'invalid_generation', reason: 'empty_id' | 'invalid_observed_at' }
  | { _tag: 'conflict', reason: 'stale_generation' | 'generation_reused' }

export interface CompleteSitemapTraversal {
  _tag: 'complete'
  expectedFeedpaths: readonly string[]
}

export type FinalizeSitemapGenerationResult
  = | { _tag: 'published', generationId: string, observedAt: number, feedCount: number }
    | { _tag: 'unchanged', generationId: string, observedAt: number, feedCount: number }
    | { _tag: 'incomplete', missingFeedpaths: string[], invalidFeedpaths: string[] }
    | { _tag: 'conflict', reason: 'stale_generation' | 'generation_reused' | 'publication_changed' }
    | { _tag: 'invalid_generation', reason: 'empty_id' | 'invalid_observed_at' }

export type SitemapGenerationReadResult
  = | { _tag: 'available', manifest: SitemapSiteGenerationManifest }
    | { _tag: 'unavailable', reason: 'no_generation' | 'generation_not_found' }

export interface IterateSitemapGenerationUrlsOptions {
  generationId?: string
  feedpath?: string
}

export type IterateSitemapGenerationUrlsResult
  = | {
    _tag: 'iterator'
    generationId: string
    observedAt: number
    items: AsyncIterable<SitemapUrlRecord>
    completeness: { _tag: 'complete' }
    membershipHistoryAvailableFrom: number | null
  }
  | { _tag: 'invalid_request', reason: 'invalid_feed' }
  | { _tag: 'unavailable', reason: 'no_generation' | 'generation_not_found' }

export interface ListSitemapGenerationUrlsOptions {
  generationId?: string
  feedpath?: string
  cursor?: string
  limit?: number
}

export type ListSitemapGenerationUrlsResult
  = | {
    _tag: 'page'
    generationId: string
    observedAt: number
    items: SitemapUrlRecord[]
    nextCursor: string | null
    completeness: { _tag: 'complete' }
    membershipHistoryAvailableFrom: number | null
  }
  | { _tag: 'invalid_request', reason: 'invalid_limit' | 'invalid_cursor' | 'invalid_feed' }
  | { _tag: 'unavailable', reason: 'no_generation' | 'generation_not_found' }

export type SitemapMembershipEvidence
  = | {
    _tag: 'present'
    url: string
    feedpath: string
    lastmod: string | null
    firstSeenAt: number
    lastSeenAt: number
  }
  | { _tag: 'absent', url: string, observedAt: number }
  | { _tag: 'unknown', url: string, reason: 'no_generation' | 'generation_not_found' }

export type QuerySitemapGenerationMembershipResult
  = | {
    _tag: 'result'
    generationId: string
    observedAt: number
    evidence: SitemapMembershipEvidence[]
    completeness: { _tag: 'complete' }
    membershipHistoryAvailableFrom: number | null
  }
  | { _tag: 'unavailable', reason: 'no_generation' | 'generation_not_found' }

export type RecordSitemapLegacyImportResult
  = | { _tag: 'recorded', evidence: Extract<SitemapLegacyImportEvidence, { _tag: 'metadata_only' }> }
    | { _tag: 'existing', evidence: Extract<SitemapLegacyImportEvidence, { _tag: 'metadata_only' }> }
    | { _tag: 'invalid', reason: 'invalid_imported_at' | 'invalid_record_count' }

export interface CompleteSitemapGeneration {
  _tag: 'complete'
  id: string
  observedAt: number
}

export interface SitemapMembershipEvent {
  feedpath: string
  feedpathHash: string
  urlHash: string
  op: 'added' | 'removed' | 'updated'
  loc: string
  lastmod?: string
  previousLastmod?: string
  generationId: string
  observedAt: number
  sequence: number
  projectsState: boolean
}

export interface DateRange {
  from?: string
  to?: string
}

export const URLS_INDEX_COLUMNS: readonly ColumnDef[] = [
  { name: 'feedpath', type: 'VARCHAR', nullable: false },
  { name: 'feedpath_hash', type: 'VARCHAR', nullable: false },
  { name: 'url_hash', type: 'VARCHAR', nullable: false },
  { name: 'loc', type: 'VARCHAR', nullable: false },
  { name: 'lastmod', type: 'VARCHAR', nullable: true },
  { name: 'first_seen_at', type: 'BIGINT', nullable: false },
  { name: 'last_seen_at', type: 'BIGINT', nullable: false },
  { name: 'removed_at', type: 'BIGINT', nullable: true },
]

export const URLS_EVENT_COLUMNS: readonly ColumnDef[] = [
  { name: 'feedpath', type: 'VARCHAR', nullable: false },
  { name: 'feedpath_hash', type: 'VARCHAR', nullable: false },
  { name: 'url_hash', type: 'VARCHAR', nullable: false },
  { name: 'op', type: 'VARCHAR', nullable: false },
  { name: 'loc', type: 'VARCHAR', nullable: false },
  { name: 'lastmod', type: 'VARCHAR', nullable: true },
  { name: 'previous_lastmod', type: 'VARCHAR', nullable: true },
  { name: 'generation_id', type: 'VARCHAR', nullable: false },
  { name: 'observed_at', type: 'BIGINT', nullable: false },
  { name: 'sequence', type: 'INTEGER', nullable: false },
  { name: 'projects_state', type: 'INTEGER', nullable: false },
]

export function rowToUrlRecord(row: Row): SitemapUrlRecord {
  return {
    feedpath: String(row.feedpath),
    feedpathHash: String(row.feedpath_hash),
    urlHash: String(row.url_hash),
    loc: String(row.loc),
    lastmod: row.lastmod == null ? undefined : String(row.lastmod),
    firstSeenAt: Number(row.first_seen_at),
    lastSeenAt: Number(row.last_seen_at),
    removedAt: row.removed_at == null ? undefined : Number(row.removed_at),
  }
}

export function urlRecordToRow(record: SitemapUrlRecord): Row {
  return {
    feedpath: record.feedpath,
    feedpath_hash: record.feedpathHash,
    url_hash: record.urlHash,
    loc: record.loc,
    lastmod: record.lastmod ?? null,
    first_seen_at: record.firstSeenAt,
    last_seen_at: record.lastSeenAt,
    removed_at: record.removedAt ?? null,
  }
}

export interface SitemapReadStore {
  loadEvents: (ctx: TenantCtx, dateRange?: DateRange) => AsyncIterable<SitemapMembershipEvent>
  getSitemapGeneration: (ctx: TenantCtx, generationId?: string) => Promise<SitemapGenerationReadResult>
  iterateSitemapGenerationUrls: (
    ctx: TenantCtx,
    opts?: IterateSitemapGenerationUrlsOptions,
  ) => Promise<IterateSitemapGenerationUrlsResult>
  listSitemapGenerationUrls: (
    ctx: TenantCtx,
    opts?: ListSitemapGenerationUrlsOptions,
  ) => Promise<ListSitemapGenerationUrlsResult>
  querySitemapGenerationMembership: (
    ctx: TenantCtx,
    opts: { generationId?: string, urls: readonly string[] },
  ) => Promise<QuerySitemapGenerationMembershipResult>
}

export interface SitemapStore extends SitemapReadStore {
  stageSitemapGenerationFeed: (
    ctx: TenantCtx,
    generation: CompleteSitemapGeneration,
    feedpath: string,
    urls: readonly ParsedUrl[],
  ) => Promise<StageSitemapGenerationFeedResult>
  finalizeSitemapGeneration: (
    ctx: TenantCtx,
    generation: CompleteSitemapGeneration,
    traversal: CompleteSitemapTraversal,
  ) => Promise<FinalizeSitemapGenerationResult>
  abortSitemapGeneration: (
    ctx: TenantCtx,
    generation: CompleteSitemapGeneration,
  ) => Promise<void>
  recordSitemapLegacyImport: (
    ctx: TenantCtx,
    input: { importedAt: number, recordCount: number },
  ) => Promise<RecordSitemapLegacyImportResult>
}

export interface CreateSitemapReadStoreOptions {
  dataSource: DataSource
}

export type SitemapMutation = <T>(ctx: TenantCtx, effect: () => Promise<T>) => Promise<T>

export interface CreateSitemapStoreOptions extends CreateSitemapReadStoreOptions {
  withMutation: SitemapMutation
  now?: () => number
}

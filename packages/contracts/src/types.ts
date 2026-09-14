import type { FileResolutionResponse } from './file-resolution'
import type { AccountNextAction, AccountStatus, PartnerLifecycleSite } from './onboarding'
import type { GscSearchType } from './search-types'

export type {
  PartnerLifecycleAccount,
  PartnerLifecycleResponse,
  PartnerLifecycleSite,
} from './onboarding'

export type TableName = 'pages' | 'queries' | 'countries' | 'page_queries' | 'dates' | 'search_appearance' | 'search_appearance_pages' | 'search_appearance_queries' | 'search_appearance_page_queries' | 'hourly_pages'
/**
 * Temporal granularity axis. Daily callers (`'day'`, default) read/write rows
 *  keyed by `date`; hourly callers (`'hour'`) read/write rows that additionally
 *  carry a `hour` field. Composes with `searchType` — hourly is only meaningful
 *  for Discover at the moment but the engine is generic.
 */
export type Grain = 'day' | 'hour'
export type Row = Record<string, unknown>
export type ColumnType = 'DATE' | 'VARCHAR' | 'INTEGER' | 'BIGINT' | 'DOUBLE'

export interface ColumnDef {
  name: string
  type: ColumnType
  nullable: boolean
}

export interface TableSchema {
  name: TableName
  columns: ColumnDef[]
  sortKey: string[]
  version: number
}

export interface TenantCtx {
  userId: string
  siteId?: string
}

export type Dimension = 'page' | 'query' | 'queryCanonical' | 'country' | 'device' | 'date' | 'searchAppearance' | 'hour'
export type Metric = 'clicks' | 'impressions' | 'ctr' | 'position'
// Wire-format filter — server-side normalizer accepts both the JSON filter form
// (`{ type, column, value, ... }`) and the branded builder form from
// `gscdump/query` (`{ __filterBrand, _filters, _groupType, ... }`). Kept
// `unknown` here so callers can pass either without type-system friction.
export type Filter = unknown

// Wire shape of an analytics query. Matches the gscdump.com server normalizer
// (`normalizeBuilderState` in gscdump.com `server/utils/normalize-filter.ts`)
// and the builder output of `gsc(...).getState()` from `gscdump/query`.
export interface BuilderStateWire {
  dimensions: Dimension[]
  metrics?: Metric[]
  filter?: Filter
  orderBy?: { column: Metric | 'date', dir: 'asc' | 'desc' }
  rowLimit?: number
  startRow?: number
  searchType?: GscSearchType
}

export interface GscApiRange {
  start: string
  end: string
}

export interface CountryRow {
  country: string
  clicks: number
  impressions: number
  sum_position: number
}

export interface CountriesResponse {
  rows: CountryRow[]
  range: GscApiRange
  generatedAt: string
  source: 'gsc-api' | 'engine'
}

export interface SearchAppearanceRow {
  searchAppearance: string
  clicks: number
  impressions: number
  sum_position: number
}

export interface SearchAppearanceResponse {
  rows: SearchAppearanceRow[]
  range: GscApiRange
  generatedAt: string
  source: 'gsc-api' | 'engine'
}

export interface SiteListItem {
  id: string
  tier: 'free' | 'pro'
  tierExpiresAt: number | null
  label: string
  hostname: string
  propertyType: 'domain' | 'url-prefix'
  readBackend?: 'd1' | 'r2'
}

export interface ScheduleState {
  nextAt: number
  consecutiveUnchanged: number
  policyVersion: number
}

/**
 * Wire-format extension carried under `InspectionHistoryRecord.raw`.
 *
 * Source of truth: D1 `url_indexing_status` (per the 2026-05-19 redesign).
 * Most fields are JSON-encoded TEXT in D1 and surface here unchanged as
 * `string | null`; consumers parse on read.
 *
 * Additional keys are tolerated (`[key: string]: unknown`) for
 * forward-compatibility — new fields can ship without a contract bump.
 */
export interface InspectionRecordRaw {
  /** Adaptive recheck schedule owned by `inspectionPolicy.observe`. */
  schedule?: ScheduleState
  /** Unix seconds. Mirrors the `next_check_after` column. */
  nextCheckAfter?: number
  /** Mirrors the `next_check_priority` column. */
  priority?: 'high' | 'medium' | 'low' | 'critical' | 'elevated' | 'normal' | 'dormant'
  /** JSON-encoded `string[]` of sitemap URLs containing this URL. */
  sitemaps?: string | null
  /** JSON-encoded `string[]` of referring URLs Google reported. */
  referringUrls?: string | null
  /** Crawler that fetched the URL (`Googlebot smartphone` etc.). */
  crawlingUserAgent?: string | null
  /** JSON-encoded mobile-usability issues. */
  mobileIssues?: string | null
  /** JSON-encoded rich-results items array. */
  richResultsItems?: string | null
  /** Deep link into the GSC URL Inspection tool. */
  inspectionResultLink?: string | null
  [key: string]: unknown
}

export interface InspectionHistoryRecord {
  url: string
  inspectedAt: string
  indexStatus?: string
  lastCrawlTime?: string
  googleCanonical?: string
  userCanonical?: string
  coverageState?: string
  robotsTxtState?: string
  indexingState?: string
  pageFetchState?: string
  mobileUsabilityVerdict?: string
  richResultsVerdict?: string
  raw?: InspectionRecordRaw
}

export interface InspectionHistoryResponse {
  url: string | null
  records: InspectionHistoryRecord[]
}

export interface InspectionIndex {
  version: 1
  records: Record<string, InspectionHistoryRecord>
}

export interface RollupEnvelope<T = unknown> {
  version: 1
  id: string
  builtAt: number
  windowDays: number | null
  payload: T
}

export interface GscRowQueryMeta {
  sourceName: string
  sourceKind: 'row' | 'sql'
  queryMs: number
}

export interface GscRowQueryResponse<T = Record<string, unknown>> {
  rows: T[]
  meta: GscRowQueryMeta
}

export type IndexingUrlStatus = 'indexed' | 'not_indexed' | 'pending'

export interface IndexingUrlRow {
  url: string
  issueType?: string | null
  verdict: string | null
  coverageState: string | null
  indexingState: string | null
  robotsTxtState: string | null
  pageFetchState: string | null
  lastCrawlTime: string | null
  crawlingUserAgent: string | null
  userCanonical: string | null
  googleCanonical: string | null
  sitemaps: string[] | null
  referringUrls: string[] | null
  mobileVerdict: string | null
  mobileIssues: unknown[] | null
  richResultsVerdict: string | null
  richResultsItems: unknown[] | null
  inspectionResultLink: string | null
  firstCheckedAt: string
  lastCheckedAt: string
  checkCount: number
}

export interface IndexingUrlsResponse {
  urls: IndexingUrlRow[]
  pagination: { total: number, limit: number, offset: number, hasMore: boolean }
  meta: { siteUrl: string, status: string, issue: string | null }
}

export type IndexingIssueSeverity = 'error' | 'warning' | 'info'

export interface IndexingIssue {
  type: string
  label: string
  severity: IndexingIssueSeverity
  count: number
  description: string
  fix: string
}

export interface IndexingDiagnostics {
  summary: {
    totalUrls: number
    indexed: number
    indexedPercent: number
  }
  issues: IndexingIssue[]
  samples?: Record<string, IndexingUrlRow[]>
  meta: {
    siteUrl: string
    indexingStatus?: 'pending' | 'partial' | 'complete'
    indexingProgress?: number
    sitemapTotal?: number
    inspectedCount?: number
    rollupBuiltAt?: number
  }
}

export interface IndexingDiagnosticsParams {
  sampleIssues?: string[] | string
  sampleLimit?: number
}

export interface IndexingInspectRequest {
  urls: string[]
}

export interface IndexingInspectResult {
  url: string
  verdict: string | null
  coverageState: string | null
  indexingState: string | null
  robotsTxtState: string | null
  pageFetchState: string | null
  lastCrawlTime: string | null
  crawlingUserAgent: string | null
  userCanonical: string | null
  googleCanonical: string | null
  sitemaps: string | null
  referringUrls: string | null
  mobileVerdict: string | null
  mobileIssues: string | null
  richResultsVerdict: string | null
  richResultsItems: string | null
  inspectionResultLink: string | null
}

export interface IndexingInspectRateLimit {
  reserved: number
  remaining: number
  limit: number
}

export interface IndexingInspectResponse {
  siteId: string
  rateLimit: IndexingInspectRateLimit
  results: IndexingInspectResult[]
  errors: Array<{ url: string, error: string }>
  skipped: Array<{ url: string, reason: string }>
}

export interface IndexingInspectRateLimited {
  error: 'rate_limited'
  message: string
  rateLimit: { reserved: 0, remaining: 0, limit: number }
  retryAfterSeconds: number
}

export interface SitemapAddedRow {
  url: string
  sitemap: string
  firstSeenAt: number
}

export interface SitemapRemovedRow {
  url: string
  sitemap: string
  removedAt: number
}

export type SitemapChangesCompleteness
  = | {
    _tag: 'complete'
    scannedUrls: number
  }
  | {
    _tag: 'truncated'
    scannedUrls: number
    reasons: Array<'scan_limit' | 'added_limit' | 'removed_limit' | 'updated_limit' | 'history_unavailable'>
    historyAvailableFrom?: number
    limits: {
      scannedUrls: number
      added: number
      removed: number
      updated: number
    }
  }

export interface SitemapChangesResponse {
  added: SitemapAddedRow[]
  removed: SitemapRemovedRow[]
  summary: { totalAdded: number, totalRemoved: number, totalUpdated: number, period: { days: number } }
  completeness: SitemapChangesCompleteness
}

export type AnalysisSourcesResponse = GscdumpAnalysisSourcesResponse

export interface SourceInfoResponse {
  name: string
  kind: 'row' | 'sql'
  capabilities: { attachedTables?: boolean, [k: string]: unknown }
  supportedAnalyzerIds: string[]
  browserAttachEligible: boolean
  identityAttrs?: Record<string, unknown> | null
}

export interface WhoamiResponse {
  userId?: string | null
  plan?: string | null
  attrs?: Record<string, unknown>
}

export interface BackfillRange {
  startDate: string
  endDate: string
}

export interface BackfillResponse {
  ok?: boolean
  queued?: boolean
  [key: string]: unknown
}

// GSC Search Analytics wire types (request/response shapes for the live
// google.com/webmasters API) are owned by the `gscdump` package — see
// `gscdump/contracts`. They are deliberately not duplicated here; nothing
// in `@gscdump/contracts` consumes them.

export type GscComparisonFilter = 'new' | 'lost' | 'improving' | 'declining'

export interface GscdumpDataRow {
  page?: string
  query?: string
  queryCanonical?: string
  country?: string
  device?: string
  date?: string
  clicks: number
  impressions: number
  ctr: number
  position: number
  prevClicks?: number
  prevImpressions?: number
  prevCtr?: number
  prevPosition?: number
  topKeyword?: string
  topPage?: string
  variantCount?: number
  variants?: Array<{ query: string, clicks: number, impressions: number, position: number }>
  difficulty?: number
  searchVolume?: number
  cpc?: number
  firstDate?: string
  lastDate?: string
}

export interface GscdumpMeta {
  siteUrl: string
  syncStatus: string
  newestDateSynced: string | null
  oldestDateSynced: string | null
  dataDelay?: string
  dataEndDate?: string | null
  warnings?: string[]
  enrichment?: {
    lastEnriched: number
    isDue: boolean
  }
  backfill?: {
    percent: number
    daysRemaining?: number
  }
}

export interface GscdumpTotals {
  clicks: number
  impressions: number
  ctr: number
  position: number
}

export interface GscdumpDataResponse {
  rows: GscdumpDataRow[]
  totalCount: number
  totals: GscdumpTotals
  meta: GscdumpMeta
}

export interface GscdumpDataDetailResponse {
  daily: Array<{
    date: string
    clicks: number
    impressions: number
    ctr: number
    position: number
  }>
  previousDaily?: Array<{
    date: string
    clicks: number
    impressions: number
    ctr: number
    position: number
  }>
  totals: GscdumpTotals
  previousTotals?: GscdumpTotals
  meta: GscdumpMeta
}

export interface GscdumpUserRegistration {
  userId: string
  apiKey?: string
  isNew?: boolean
  status?: 'provisioning' | 'ready'
}

export interface GscdumpUserStatus {
  userId: string
  status: 'provisioning' | 'ready' | 'reauth_required'
  databaseReady?: boolean
  needsReauth?: boolean
  reauthRequired?: boolean
  reauthReason?: string | null
  authFailureCount?: number
  nextAction?: 'reconnect_google' | 'none'
  grantedScopes?: string | null
}

export interface GscdumpUserTokenUpdate {
  userId: string
  updated: boolean
  sites: GscdumpAvailableSite[]
}

export interface GscdumpAvailableSite {
  siteUrl: string
  permissionLevel: string
  registered: boolean
  siteId?: string
  /** Integer alias (`user_sites.int_id`) — the int JOIN key partners denormalize into their own catalog namespaces. Present on registered sites. */
  intId?: number | null
  syncStatus?: 'pending' | 'syncing' | 'synced' | 'error' | null
  syncProgress?: { completed: number, failed?: number, total: number, percent: number }
  lastSyncAt?: number | null
  newestDateSynced?: string | null
  oldestDateSynced?: string | null
}

export interface GscdumpSiteIntIdCrosswalkEntry {
  siteId: string
  intId: number
  siteUrl: string
}

export interface GscdumpSiteIntIdCrosswalkResponse {
  crosswalk: Record<string, number>
  sites: GscdumpSiteIntIdCrosswalkEntry[]
}

export interface GscdumpSiteRegistration {
  siteId: string
  /** Integer alias (`user_sites.int_id`) — the int JOIN key partners denormalize into their own catalog namespaces. */
  intId?: number | null
  /** Team-scoped catalog identifier (`user_sites.catalog_site_id`). Echoes caller input or defaults to `intId`. */
  catalogSiteId?: number | null
  status: 'idle' | 'pending' | 'syncing' | 'synced' | 'error'
  message?: string
  existing?: boolean
  indexingEligible?: boolean
  indexingIneligibleReason?: 'free_plan' | 'missing_gsc_read_scope' | 'insufficient_gsc_permission'
  indexingPermissionLevel?: string | null
  grantedScopes?: string[]
  site?: PartnerLifecycleSite | null
}

export type GscVerificationMethod = 'META' | 'FILE' | 'DNS_TXT' | 'DNS_CNAME' | 'ANALYTICS' | 'TAG_MANAGER'

export interface GscVerificationSite {
  type: 'SITE' | 'INET_DOMAIN'
  identifier: string
}

export interface GscVerificationDnsRecord {
  type: 'TXT' | 'CNAME'
  host: string
  value: string
}

export interface GscVerificationRequest {
  userId?: string
  siteUrl: string
  method?: GscVerificationMethod
}

export interface GscVerificationTokenResponse {
  siteUrl: string
  site: GscVerificationSite
  method: GscVerificationMethod
  token: string
  metaContent: string | null
  dnsRecord: GscVerificationDnsRecord | null
}

export interface GscAddAndVerifyResponse {
  siteUrl: string
  site: GscVerificationSite
  method: GscVerificationMethod
  verified: true
  owners: string[]
}

export interface GscdumpUserSite {
  tier: 'free' | 'pro'
  tierExpiresAt: number | null
  siteId: string
  siteUrl: string
  analyticsSyncStatus?: 'idle' | 'pending' | 'syncing' | 'synced' | 'error'
  analyticsSyncProgress?: {
    completed: number
    failed?: number
    total: number
    percent: number
  }
  syncStatus: 'idle' | 'pending' | 'syncing' | 'synced' | 'error'
  syncProgress?: {
    completed: number
    failed?: number
    total: number
    percent: number
  }
  indexingEligible?: boolean
  indexingIneligibleReason?: 'free_plan' | 'missing_gsc_read_scope' | 'insufficient_gsc_permission'
  indexingPermissionLevel?: string | null
  grantedScopes?: string[]
  indexingStatus?: 'not_started' | 'indexing' | 'complete'
  indexingProgress?: {
    completed: number
    failed?: number
    total: number
    percent: number
  }
  indexingUrl?: string
  lastSyncAt: number | null
  newestDateSynced: string | null
  oldestDateSynced: string | null
}

export interface GscdumpSyncStatusResponse {
  siteUrl: string
  syncStatus: 'pending' | 'syncing' | 'synced' | 'error'
  oldestDateAvailable: string | null
  oldestDateSynced: string | null
  newestDateSynced: string | null
  lastSyncAt: number | null
  lastError: string | null
  jobs: {
    queued: number
    processing: number
    completed: number
    failed: number
  }
  progress: number
  jobProgress: number
  daysSynced: number
  daysAvailable: number
  isSyncing: boolean
  hasData: boolean
  isComplete: boolean
  tables: Record<string, {
    queued: number
    processing: number
    completed: number
    failed: number
    totalRows: number
  }>
  days?: Record<string, {
    tables: Record<string, {
      status: string
      rowsFetched: number
      rowsInserted: number
      error: string | null
    }>
  }>
  failedJobs?: Array<{
    date: string
    tableName: string
    error: string
    retryCount: number
  }>
}

export interface GscdumpSitemap {
  path: string
  errors: number
  warnings: number
  urlCount: number
  isIndex: boolean
  contentHash: string | null
  lastDownloaded: string | null
  lastError: string | null
  isPending: boolean
  fetchedAt: number
}

export interface GscdumpSitemapHistory {
  date: string
  errors: number
  warnings: number
  urlCount: number
  urlDelta: number
}

export interface GscdumpPerSitemapHistoryEntry {
  date: string
  urlCount: number
  changed: boolean
  urlDelta: number
}

export interface GscdumpSitemapsResponse {
  sitemaps: GscdumpSitemap[]
  history: GscdumpSitemapHistory[]
  perSitemapHistory: Record<string, GscdumpPerSitemapHistoryEntry[]>
  meta: {
    siteUrl: string
    gscPropertyUrl?: string
    syncStatus: string | null
    sitemapScope: {
      excludedCount: number
      duplicateCount: number
    }
  }
  generation: GscdumpSitemapGeneration | null
}

export interface GscdumpSitemapChangesResponse {
  added: { url: string, sitemap: string, firstSeenAt: number }[]
  removed: { url: string, sitemap: string, removedAt: number }[]
  updated: {
    url: string
    sitemap: string
    previousLastmod: string | null
    lastmod: string | null
    observedAt: number
  }[]
  summary?: { totalAdded: number, totalRemoved: number, totalUpdated: number, period: { days: number } }
  completeness: SitemapChangesCompleteness
  generation: GscdumpSitemapGeneration | null
}

export interface GscdumpSitemapGeneration {
  id: string
  observedAt: number
  publishedAt: number
  completeness: { _tag: 'complete' }
  membershipHistoryAvailableFrom: number | null
  legacyImport:
    | { _tag: 'none' }
    | {
      _tag: 'metadata_only'
      importedAt: number
      recordCount: number
      source: 'gsc_sitemaps'
    }
}

export type PartnerSitemapAction
  = | { action: 'submit' | 'delete', sitemapUrl: string }
    | { action: 'refresh' | 'auto-discover' }

export type PartnerSitemapActionResponse
  = | { success: boolean, action: 'submitted' | 'deleted', sitemapUrl: string, sitemapCount: number }
    | { success: true, action: 'refreshed', sitemapCount: number, changed: boolean, deltas?: unknown }
    | { success: boolean, action: 'auto-discover', discovered: string | null, submitError?: string | null, sitemapCount: number }

export interface GscdumpSitemapMembershipParams {
  urls: string[]
  generationId?: string
}

export type GscdumpSitemapMembershipEvidence
  = | {
    _tag: 'present'
    url: string
    feedpath: string
    lastmod: string | null
    firstSeenAt: number
    lastSeenAt: number
  }
  | { _tag: 'absent', url: string, observedAt: number }
  | {
    _tag: 'unknown'
    url: string
    reason: 'no_generation' | 'generation_not_found' | 'generation_incomplete' | 'history_pruned' | 'invalid_url'
  }

export interface GscdumpSitemapMembershipResponse {
  generation: GscdumpSitemapGeneration | null
  evidence: GscdumpSitemapMembershipEvidence[]
  meta: {
    requested: number
    checked: number
    matched: number
  }
}

export interface GscdumpSitemapUrlsResponse {
  generation: GscdumpSitemapGeneration
  items: Array<{
    url: string
    feedpath: string
    lastmod: string | null
    firstSeenAt: number
    lastSeenAt: number
  }>
  page: { nextCursor: string | null, limit: number }
}

export interface GscdumpSitemapExportResponse {
  generation: GscdumpSitemapGeneration
  export:
    | {
      _tag: 'url'
      url: string
      expiresAt: number
      contentType: 'application/x-ndjson'
      contentEncoding: 'identity' | 'gzip'
    }
    | { _tag: 'unavailable', reason: 'generation_not_found' | 'export_unavailable' }
}

export interface GscdumpIndexingTrendPoint {
  date: string
  totalUrls: number
  indexedCount: number | null
  notIndexedCount: number | null
  errorCount: number | null
  indexedPercent: number
  issues: {
    blockedByRobots: number | null
    noindexDetected: number | null
    soft404: number | null
    redirect: number | null
    notFound: number | null
    serverError: number | null
  }
  coverage: {
    submittedIndexed: number | null
    crawledNotIndexed: number | null
    discoveredNotCrawled: number | null
  }
  signals: {
    mobilePass: number
    mobileFail: number
    richResultsPass: number
    richResultsFail: number
  }
}

export interface GscdumpIndexingResponse {
  trend: GscdumpIndexingTrendPoint[]
  summary: {
    totalUrls: number
    indexed: number
    notIndexed: number
    pending: number
    indexedPercent: number
    oldestCheck: string | null
    newestCheck: string | null
    change7d: number | null
    change28d: number | null
    signals: {
      mobilePass: number
      mobileFail: number
      mobileUnspecified: number
      richResultsPass: number
      richResultsFail: number
      richResultTypes: Array<{ type: string, count: number }>
      crawlingMobile: number
      crawlingDesktop: number
    }
  }
  meta: {
    siteUrl: string
    syncStatus: string | null
    indexingStatus: 'pending' | 'partial' | 'complete'
    indexingProgress: number
    sitemapTotal: number
    inspectedCount: number
    noSitemapsSubmitted: boolean
    sitemapsPending: boolean
    rollupBuiltAt?: number
  }
}

export type GscdumpIndexingUrlStatus = 'indexed' | 'not_indexed' | 'pending'
export type GscdumpIndexingIssueSeverity = 'error' | 'warning' | 'info'
export type GscdumpCanonicalDifferenceKind = 'none' | 'formatting' | 'path' | 'cross_domain'

export interface GscdumpRichResultItem {
  richResultType: string
  items?: unknown[]
}

export interface GscdumpIndexingUrl {
  url: string
  issueType?: string | null
  verdict: string | null
  coverageState: string | null
  indexingState: string | null
  robotsTxtState?: string | null
  pageFetchState?: string | null
  lastCrawlTime: string | null
  crawlingUserAgent?: string | null
  userCanonical?: string | null
  googleCanonical?: string | null
  canonicalMismatchKind: GscdumpCanonicalDifferenceKind
  sitemaps?: string[] | null
  referringUrls?: string[] | null
  mobileVerdict?: string | null
  mobileIssues?: string[] | null
  richResultsVerdict?: string | null
  richResultsItems?: GscdumpRichResultItem[] | null
  inspectionResultLink?: string | null
  firstCheckedAt: string
  lastCheckedAt: string
  checkCount?: number
}

export interface GscdumpIndexingUrlsResponse {
  urls: GscdumpIndexingUrl[]
  pagination: { total: number, limit: number, offset: number, hasMore: boolean }
  meta: { siteUrl: string, gscPropertyUrl?: string, status: string, issue: string | null }
}

export interface GscdumpIndexingDiagnosticsResponse {
  summary: { totalUrls: number, indexed: number, indexedPercent: number }
  issues: Array<{
    type: string
    label: string
    severity: GscdumpIndexingIssueSeverity
    count: number
    description: string
    fix: string
  }>
  samples?: Record<string, GscdumpIndexingUrl[]>
  meta: {
    siteUrl: string
    indexingStatus?: 'pending' | 'partial' | 'complete'
    indexingProgress?: number
    sitemapTotal?: number
    inspectedCount?: number
    rollupBuiltAt?: number
  }
}

export type GscdumpIndexingInspectRequest = IndexingInspectRequest
export type GscdumpIndexingInspectResult = IndexingInspectResult
export type GscdumpIndexingInspectResponse = IndexingInspectResponse
export type GscdumpIndexingInspectRateLimited = IndexingInspectRateLimited

export type GscdumpAnalysisPreset
  = | 'striking-distance'
    | 'opportunity'
    | 'decay'
    | 'zero-click'
    | 'non-brand'
    | 'brand-only'
    | 'movers-rising'
    | 'movers-declining'

export interface GscdumpAnalysisParams {
  preset: GscdumpAnalysisPreset
  startDate: string
  endDate: string
  prevStartDate?: string
  prevEndDate?: string
  brandTerms?: string
  limit?: number
  offset?: number
  search?: string
  minImpressions?: number
  minPosition?: number
  maxPosition?: number
  maxCtr?: number
  searchType?: GscSearchType
}

export interface GscdumpAnalysisResponse {
  preset: GscdumpAnalysisPreset
  keywords: Array<Record<string, unknown>>
  totalCount: number
  summary?: Record<string, unknown> | null
  meta: {
    siteUrl: string
    params: {
      brandTerms?: string[]
      startDate?: string
      endDate?: string
      prevStartDate?: string
      prevEndDate?: string
    }
    presetDescription?: string
  }
}

export interface GscdumpAnalysisBundleParams extends Omit<GscdumpAnalysisParams, 'preset'> {
  presets: GscdumpAnalysisPreset[]
}

export interface GscdumpAnalysisBundleResponse {
  bundle: Record<string, {
    keywords: Array<Record<string, unknown>>
    totalCount: number
    summary?: Record<string, unknown> | null
    presetDescription: string
  }>
  meta: GscdumpAnalysisResponse['meta']
}

export interface RegisterPartnerUserParams {
  userGoogleId: string
  userEmail: string
  userName?: string
  accessToken: string
  refreshToken: string
  tokenExpiresAt?: number
}

export interface UpdatePartnerUserTokensParams {
  accessToken: string
  refreshToken: string
  tokenExpiresAt?: number
}

export interface RegisterPartnerSiteParams {
  userId: string
  tier?: 'free' | 'pro'
  siteUrl: string
  requestedUrl?: string
  gscPropertyUrl?: string
  externalSiteId?: string
  externalSiteUrl?: string
  webhookUrl?: string
  webhookEvents?: WebhookEventType[]
  teamId?: string
  enabledSearchTypes?: GscSearchType[]
  catalogSiteId?: number
}

export interface BulkRegisterPartnerSitesParams {
  userId?: string
  siteUrls?: string[]
  sites?: Array<{
    siteUrl?: string
    requestedUrl?: string
    gscPropertyUrl?: string
    externalSiteId?: string
    externalSiteUrl?: string
    webhookUrl?: string
    webhookEvents?: WebhookEventType[]
    enabledSearchTypes?: GscSearchType[]
  }>
}

export interface BulkRegisterPartnerSiteResult {
  siteUrl: string
  siteId?: string
  status: 'registered' | 'already_exists' | 'not_found' | 'error'
  error?: string
  site?: PartnerLifecycleSite | null
  indexingEligible?: boolean
  indexingIneligibleReason?: 'free_plan' | 'missing_gsc_read_scope' | 'insufficient_gsc_permission'
  indexingPermissionLevel?: string | null
  grantedScopes?: string[]
}

export interface BulkRegisterPartnerSitesResponse {
  results: BulkRegisterPartnerSiteResult[]
  summary: {
    registered: number
    alreadyExists: number
    notFound: number
    errors: number
  }
}

export interface DeletePartnerUserResponse {
  ok: true
  queued: true
  userId: number
  publicId: string
}

export type GscdumpAnalysisSourcesResponse = FileResolutionResponse

export interface SearchTypeOptions {
  searchType?: GscSearchType
}

export interface SourceInfoOptions extends SearchTypeOptions {
  start?: string
  end?: string
  startDate?: string
  endDate?: string
}

export interface AnalysisSourcesOptions extends SearchTypeOptions {
  tables?: string[] | string
  start?: string
  end?: string
  startDate?: string
  endDate?: string
  /** Client-derived browser attachment byte ceiling. */
  maxBytes?: number
  /** Client-derived browser attachment row ceiling. */
  maxRows?: number
  /** Client-derived per-table parquet file-count ceiling. */
  maxFiles?: number
}

export interface DataQueryOptions {
  comparison?: BuilderStateWire
  filter?: GscComparisonFilter
  searchType?: GscSearchType
}

export interface DataDetailOptions {
  comparison?: BuilderStateWire
  searchType?: GscSearchType
}

export interface IndexingUrlsParams {
  limit?: number
  offset?: number
  status?: GscdumpIndexingUrlStatus
  issue?: string
  search?: string
  /**
   * Pass `0`/`false` to skip the total COUNT(*) — a second full scan of the
   * joined url_indexing_status/sitemap_urls set. Sample callers that read only
   * `urls` (e.g. the assess page-issue collector) should opt out; paginated UI
   * reads that show an exact total leave it unset.
   */
  count?: 0 | false
}

export interface GscdumpUserSettings {
  browserAnalyzerEnabled: boolean
}

export interface GscdumpPermissionRecovery {
  success: boolean
  permissionLevel: string | null
  jobsQueued: number
  message: string
}

export interface GscdumpTopAssociationParams {
  type: 'topPage' | 'topKeyword'
  identifier: string
  startDate: string
  endDate: string
}

export interface GscdumpTopAssociationResponse {
  value: string | null
}

export interface GscdumpKeywordSparklinesParams {
  keywords: string[]
  startDate: string
  endDate: string
  searchType?: GscSearchType
}

export interface GscdumpKeywordSparklinesResponse {
  sparklines: Record<string, number[]>
}

export interface GscdumpQueryTrendParams {
  startDate: string
  endDate: string
  prevStartDate?: string
  prevEndDate?: string
  searchType?: GscSearchType
}

export interface GscdumpQueryTrendResponse {
  daily: Array<{ date: string, queryCount: number }>
  total: number
  previousTotal?: number
  meta: { siteUrl: string, syncStatus: string | null }
}

export interface GscdumpPageTrendParams {
  startDate: string
  endDate: string
  prevStartDate?: string
  prevEndDate?: string
  searchType?: GscSearchType
}

export interface GscdumpPageTrendResponse {
  daily: Array<{ date: string, pageCount: number }>
  total: number
  previousTotal?: number
  meta: { siteUrl: string, syncStatus: string | null }
}

export interface GscdumpCanonicalMismatchRow {
  url: string
  userCanonical: string
  googleCanonical: string
  verdict: string | null
  coverageState: string | null
  lastCrawlTime: string | null
  lastCheckedAt: string | null
  kind: Extract<GscdumpCanonicalDifferenceKind, 'path' | 'cross_domain'>
}

export interface GscdumpCanonicalMismatchesResponse {
  mismatches: GscdumpCanonicalMismatchRow[]
  totalCount: number
  consolidationTargets: Array<{ google_canonical: string, count: number }>
  trend: Array<{ date: string, count: number }>
  meta: { siteUrl: string, syncStatus: string | null }
}

export interface GscdumpIndexPercentTrendPoint {
  date: string
  percent: number
  total: number
  visible: number
  added: number | null
  removed: number | null
}

export interface GscdumpInvisibleUrlRow {
  url: string
  firstSeen?: string
  lastmod: string | null
}

export interface GscdumpOrphanPageRow {
  url: string
  impressions: number | null
  clicks: number | null
}

export interface GscdumpIndexPercentSitemap {
  path: string
  urlCount: number
  isIndex: boolean
}

export interface GscdumpIndexPercentResponse {
  trend: GscdumpIndexPercentTrendPoint[]
  invisibleUrls: GscdumpInvisibleUrlRow[]
  invisibleCount: number
  orphanPages: GscdumpOrphanPageRow[]
  orphanCount: number
  sitemaps: GscdumpIndexPercentSitemap[]
  summary: {
    currentPercent: number
    totalSitemapUrls: number
    visibleUrls: number
    change7d: number | null
    change28d: number | null
    dataDate: string
  }
  meta: {
    siteUrl: string
    syncStatus: string | null
    newestDateSynced: string | null
  }
}

export interface GscdumpUserMeResponse {
  id: string
  name?: string
  email: string
  picture?: string
  setupComplete: boolean
  databaseReady: boolean
  plan: string
  accountStatus: AccountStatus
  accountNextAction: AccountNextAction
  missingScopes: string[]
  browserAnalyzerEnabled: boolean
  stats: {
    activeSessions: number
    totalApiCalls: number
    lastUsed: number | null
  } | null
}

export interface GscdumpHealthResponse {
  timestamp: number
  jobs: {
    byStatus: Record<string, number>
    byQueue: Record<string, number>
    stuck: number
    oldCompleted: number
  }
  failures: { lastHour: number }
  users: { needsReauth: number }
  throughput: { completedLastHour: number }
  totals: {
    users: number
    sites: number
    byPlan: Record<string, number>
  }
}

export interface GscdumpSyncProgressDateStatus {
  date: string
  status: 'completed' | 'queued' | 'processing' | 'failed'
}

export interface GscdumpSyncProgressPhaseCounts {
  total: number
  done: number
  pending: number
  stuck: number
  failed: number
  percent: number
  rows: number
}

export interface GscdumpSyncProgressSite {
  id: string
  userId: number
  partnerId: string | null
  siteUrl: string
  syncStatus: string | null
  lastError: string | null
  createdAt: number
  oldestDateSynced: string | null
  newestDateSynced: string | null
  oldestDateAvailable: string | null
  userEmail: string | null
  partnerName: string | null
  needsReauth: boolean
  authFailureCount: number
  currentPhase: 'initial' | 'backfill' | 'complete'
  isStalled: boolean
  stallDays: number
  needsContinuation: boolean
  missingDays: number
  initial: GscdumpSyncProgressPhaseCounts
  backfill: GscdumpSyncProgressPhaseCounts & { processing: number, daysTarget: number, daysQueued: number }
  tables: Record<string, { percent: number, rows: number }>
  overallPercent: number
  totalRows: number
  dateStatuses: GscdumpSyncProgressDateStatus[]
}

export interface GscdumpSyncProgressResponse {
  summary: {
    total: number
    inInitial: number
    inBackfill: number
    complete: number
    stalled: number
    authBlocked: number
    totalRows: number
    avgInitialPercent: number
    avgBackfillPercent: number
  }
  sites: GscdumpSyncProgressSite[]
  pagination: { total: number, limit: number, offset: number, hasMore: boolean }
  hasD1Stats: boolean
}

export type GscdumpSyncJobStatus = 'queued' | 'processing' | 'completed' | 'failed' | 'scheduled'

export interface GscdumpSyncJobItem {
  id: number
  userSiteId: string | null
  tableName?: string
  tableTier?: string
  date?: string
  priority?: string
  status: GscdumpSyncJobStatus
  siteUrl: string | null
  userEmail?: string | null
  rowsFetched: number | null
  rowsInserted: number | null
  error: string | null
  retryCount: number
  queuedAt: number
  startedAt: number | null
  completedAt: number | null
}

export interface GscdumpSyncJobsQueueCounts {
  queued: number
  processing: number
}

export interface GscdumpSyncJobsResponse {
  jobs: GscdumpSyncJobItem[]
  summary: {
    queued: number
    processing: number
    completed: number
    failed: number
  }
  queues: Record<string, GscdumpSyncJobsQueueCounts>
  tiers?: {
    critical: GscdumpSyncJobsQueueCounts | undefined
    standard: GscdumpSyncJobsQueueCounts | undefined
    extended: GscdumpSyncJobsQueueCounts | undefined
  }
}

export interface GscdumpSiteReportResponse<TResult = unknown> {
  status: 'done' | 'error'
  cached: boolean
  result?: TResult
  error?: string
}

export interface GscdumpTeamRow {
  id: string
  ownerId: number
  name: string
  personalTeam: boolean
  createdAt: number
  updatedAt: number
}

export interface GscdumpTeamMemberRow {
  userId: number
  publicId: string
  name: string | null
  email: string
  picture: string | null
  role: 'admin' | 'editor' | 'viewer'
  joinedAt: number
}

export interface CreatePartnerTeamParams {
  ownerUserId: string
  name: string
  personalTeam?: boolean
}

export interface AddPartnerTeamMemberParams {
  userId: string
  role: GscdumpTeamMemberRow['role']
}

export interface BindPartnerSiteTeamParams {
  teamId: string | null
}

export interface GscdumpTeamCatalogRef {
  teamId: string
  catalogUri: string | null
  warehouse: string | null
  bucket: string | null
  namespace: string | null
  provisioningState: string | null
  keyEncoding: string | null
  catalogTablesReady: boolean
  readsEnabled: boolean
}

export interface BindPartnerTeamCatalogParams {
  catalogUri: string
  warehouse: string
  namespace?: string
  bucket?: string
}

export interface BindPartnerTeamCatalogResponse {
  teamId: string
  status: 'ready'
  catalogUri: string
  warehouse: string
  bucket: string
  namespace: string
}

export type CanonicalWebhookEventType
  = | 'user.lifecycle.changed'
    | 'site.lifecycle.changed'
    | 'site.analytics.ready'
    | 'site.indexing.ready'
    | 'site.auth.failed'
    | 'job.failed'

export type WebhookEventType = CanonicalWebhookEventType

export interface WebhookEnvelope<TData extends Record<string, unknown> = Record<string, unknown>> {
  contractVersion: string
  deliveryId: string
  event: CanonicalWebhookEventType
  partnerId: string
  userId: string | null
  siteId?: string
  externalUserId?: string | null
  externalSiteId?: string | null
  lifecycleRevision: number
  occurredAt: string
  data: TData
}

export type PartnerWebhookData = Record<string, unknown>

export interface CreateWebhookEnvelopeOptions<TData extends Record<string, unknown> = Record<string, unknown>> {
  event: CanonicalWebhookEventType
  partnerId: string
  userId: string | null
  siteId?: string
  externalUserId?: string | null
  externalSiteId?: string | null
  lifecycleRevision: number
  data: TData
  deliveryId?: string
  occurredAt?: string | Date
  contractVersion?: string
}

export interface PartnerWebhookHeaders {
  event?: string | null
  delivery?: string | null
  contractVersion?: string | null
  timestamp?: string | null
  signature?: string | null
}

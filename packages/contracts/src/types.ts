import type { AccountNextAction, AccountStatus, PartnerLifecycleResponse, PartnerLifecycleSite } from './onboarding'

export type {
  PartnerLifecycleAccount,
  PartnerLifecycleResponse,
  PartnerLifecycleSite,
} from './onboarding'

export type TableName = 'pages' | 'keywords' | 'countries' | 'devices' | 'page_keywords' | 'search_appearance'
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

export type Dimension = 'page' | 'query' | 'queryCanonical' | 'country' | 'device' | 'date' | 'searchAppearance'
export type Metric = 'clicks' | 'impressions' | 'ctr' | 'position'
// Wire-format filter — server-side normalizer accepts both the JSON filter form
// (`{ type, column, value, ... }`) and the branded builder form from
// `gscdump/query` (`{ __filterBrand, _filters, _groupType, ... }`). Kept
// `unknown` here so callers can pass either without type-system friction.
export type Filter = unknown

// Wire shape of an analytics query. Matches the gscdump.com server normalizer
// (`normalizeBuilderState` in gscdump.com `server/utils/normalize-filter.ts`)
// and the builder output of `gsc(...).getState()` from `gscdump/query`.
export interface BuilderState {
  dimensions: Dimension[]
  metrics?: Metric[]
  filter?: Filter
  orderBy?: { column: Metric | 'date', dir: 'asc' | 'desc' }
  rowLimit?: number
  startRow?: number
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

export interface SitemapHistoryRecord {
  path: string
  capturedAt: string
  lastDownloaded?: string
  lastSubmitted?: string
  type?: string
  isPending?: boolean
  isSitemapsIndex?: boolean
  errors?: string
  warnings?: string
  contents?: Array<{ type?: string, submitted?: string, indexed?: string }>
  raw?: unknown
  urlCount?: number
  contentHash?: string
  schedule?: ScheduleState
}

export interface SitemapHistoryResponse {
  path: string | null
  snapshots: SitemapHistoryRecord[]
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
  raw?: {
    schedule?: ScheduleState
    [key: string]: unknown
  }
}

export interface InspectionHistoryResponse {
  url: string | null
  records: InspectionHistoryRecord[]
}

export interface SitemapIndex {
  version: 1
  records: Record<string, SitemapHistoryRecord>
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
}

export interface IndexingDiagnostics {
  summary: {
    totalUrls: number
    indexed: number
    indexedPercent: number
  }
  issues: IndexingIssue[]
  meta: { siteUrl: string }
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

export interface SitemapChangesResponse {
  added: SitemapAddedRow[]
  removed: SitemapRemovedRow[]
  summary: { totalAdded: number, totalRemoved: number, period: { days: number } }
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

export interface AnalyticsClient {
  whoami: () => Promise<WhoamiResponse>
  listSites: () => Promise<SiteListItem[]>
  getSourceInfo: (siteId: string) => Promise<SourceInfoResponse>
  getAnalysisSources: (siteId: string, tables?: string[] | string) => Promise<AnalysisSourcesResponse>
  analyze: <T = unknown>(siteId: string, params: unknown) => Promise<T>
  queryRows: <T = Record<string, unknown>>(siteId: string, state: unknown) => Promise<GscRowQueryResponse<T>>
  getRollup: <T = unknown>(siteId: string, rollupId: string, params?: { start?: string, end?: string }) => Promise<RollupEnvelope<T>>
  requestBackfill: (siteId: string, range: BackfillRange) => Promise<BackfillResponse>
  getSitemaps: (siteId: string) => Promise<SitemapIndex>
  getSitemapHistory: (siteId: string, hash: string) => Promise<SitemapHistoryResponse>
  getSitemapChanges: (siteId: string, params?: { days?: number }) => Promise<SitemapChangesResponse>
  getInspections: (siteId: string) => Promise<InspectionIndex>
  getInspectionHistory: (siteId: string, hash: string) => Promise<InspectionHistoryResponse>
  getIndexingUrls: (siteId: string, params?: { limit?: number, offset?: number, status?: IndexingUrlStatus, issue?: string, search?: string }) => Promise<IndexingUrlsResponse>
  getIndexingDiagnostics: (siteId: string) => Promise<IndexingDiagnostics>
  requestIndexingInspect: (siteId: string, body: IndexingInspectRequest) => Promise<IndexingInspectResponse | IndexingInspectRateLimited>
  getCountries: (siteId: string, range: { start: string, end: string }) => Promise<CountriesResponse>
  getSearchAppearance: (siteId: string, range: { start: string, end: string }) => Promise<SearchAppearanceResponse>
}

export type GscSearchAnalyticsDimension = 'page' | 'query' | 'country' | 'device' | 'date' | 'searchAppearance'

export type GscSearchAnalyticsFilterOperator
  = | 'equals'
    | 'notEquals'
    | 'contains'
    | 'notContains'
    | 'includingRegex'
    | 'excludingRegex'

export interface GscSearchAnalyticsFilter {
  dimension: GscSearchAnalyticsDimension
  expression: string
  operator?: GscSearchAnalyticsFilterOperator
}

export interface GscSearchAnalyticsFilterGroup {
  groupType?: 'and' | 'or'
  filters: GscSearchAnalyticsFilter[]
}

export type GscSearchType = 'web' | 'image' | 'video' | 'news' | 'discover' | 'googleNews'

export interface GscSearchAnalyticsRequest {
  startDate: string
  endDate: string
  dimensions?: GscSearchAnalyticsDimension[]
  dimensionFilterGroups?: GscSearchAnalyticsFilterGroup[]
  rowLimit?: number
  startRow?: number
  searchType?: GscSearchType
}

export interface GscSearchAnalyticsRow {
  keys: string[]
  clicks: number
  impressions: number
  ctr: number
  position: number
}

export interface GscSearchAnalyticsResponse {
  rows?: GscSearchAnalyticsRow[]
  responseAggregationType?: string
}

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
  dataDelay: string
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
  syncStatus?: 'pending' | 'syncing' | 'synced' | 'error'
  syncProgress?: { completed: number, failed?: number, total: number, percent: number }
  lastSyncAt?: number | null
  newestDateSynced?: string | null
  oldestDateSynced?: string | null
}

export interface GscdumpSiteRegistration {
  siteId: string
  status: 'idle' | 'pending' | 'syncing' | 'synced' | 'error'
  message?: string
  existing?: boolean
  indexingEligible?: boolean
  indexingIneligibleReason?: 'missing_indexing_scope' | 'insufficient_gsc_permission'
  indexingPermissionLevel?: string | null
  grantedScopes?: string[]
}

export interface GscdumpUserSite {
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
  indexingIneligibleReason?: 'missing_indexing_scope' | 'insufficient_gsc_permission'
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
    syncStatus: string | null
  }
}

export interface GscdumpSitemapChangesResponse {
  added: { url: string, sitemap: string, firstSeenAt: number }[]
  removed: { url: string, sitemap: string, removedAt: number }[]
  summary?: { totalAdded: number, totalRemoved: number, period: { days: number } }
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

export interface GscdumpIndexingUrl {
  url: string
  verdict: string | null
  coverageState: string | null
  indexingState: string | null
  robotsTxtState?: string | null
  pageFetchState?: string | null
  lastCrawlTime: string | null
  crawlingUserAgent?: string | null
  userCanonical?: string | null
  googleCanonical?: string | null
  sitemaps?: string[] | null
  referringUrls?: string[] | null
  mobileVerdict?: string | null
  mobileIssues?: unknown[] | null
  richResultsVerdict?: string | null
  richResultsItems?: unknown[] | null
  inspectionResultLink?: string | null
  firstCheckedAt: string
  lastCheckedAt: string
  checkCount?: number
}

export interface GscdumpIndexingUrlsResponse {
  urls: GscdumpIndexingUrl[]
  pagination: { total: number, limit: number, offset: number, hasMore: boolean }
  meta: { siteUrl: string, status: string, issue: string | null }
}

export interface GscdumpIndexingDiagnosticsResponse {
  summary: { totalUrls: number, indexed: number, indexedPercent: number }
  issues: { type: string, label: string, severity: string, count: number }[]
  meta: { siteUrl: string }
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
}

export interface GscdumpAnalysisResponse {
  preset: GscdumpAnalysisPreset
  keywords: Array<Record<string, unknown>>
  totalCount: number
  summary?: Record<string, unknown>
  meta: GscdumpMeta
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
  siteUrl: string
  requestedUrl?: string
  gscPropertyUrl?: string
  externalSiteId?: string
  externalSiteUrl?: string
  webhookUrl?: string
  webhookEvents?: WebhookEventType[]
  teamId?: string
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
  }>
}

export interface BulkRegisterPartnerSiteResult {
  siteUrl: string
  siteId?: string
  status: 'registered' | 'already_exists' | 'not_found' | 'error'
  error?: string
  site?: PartnerLifecycleSite | null
  indexingEligible?: boolean
  indexingIneligibleReason?: 'missing_indexing_scope' | 'insufficient_gsc_permission'
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

export interface GscdumpAnalysisSourcesResponse {
  tables: Record<string, string[]>
  generatedAt: string
  manifestVersion: string
}

export interface DataQueryOptions {
  comparison?: BuilderState
  filter?: GscComparisonFilter
}

export interface DataDetailOptions {
  comparison?: BuilderState
}

export interface IndexingUrlsParams {
  limit?: number
  offset?: number
  status?: GscdumpIndexingUrlStatus
  issue?: string
  search?: string
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
}

export interface GscdumpKeywordSparklinesResponse {
  sparklines: Record<string, number[]>
}

export interface GscdumpQueryTrendParams {
  startDate: string
  endDate: string
  prevStartDate?: string
  prevEndDate?: string
}

export interface GscdumpQueryTrendResponse {
  daily: Array<{ date: string, queryCount: number }>
  total: number
  previousTotal?: number
  meta: { siteUrl: string, syncStatus: string | null }
}

export interface GscdumpDateRangeParams {
  startDate: string
  endDate: string
}

export interface GscdumpCanonicalMismatchRow {
  url: string
  userCanonical: string
  googleCanonical: string
  verdict: string | null
  coverageState: string | null
  lastCrawlTime: string | null
  lastCheckedAt: string | null
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
  partnerId: number | null
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

export interface PartnerClient {
  registerUser: (params: RegisterPartnerUserParams) => Promise<GscdumpUserRegistration>
  updateUserTokens: (userId: string, params: UpdatePartnerUserTokensParams) => Promise<GscdumpUserTokenUpdate>
  getUserStatus: (userId: string) => Promise<GscdumpUserStatus>
  getUserLifecycle: (userId: string) => Promise<PartnerLifecycleResponse>
  waitForUserReady: (userId: string, options?: { attempts?: number, intervalMs?: number }) => Promise<GscdumpUserStatus>
  getUserSites: (userId: string) => Promise<{ sites: GscdumpUserSite[] }>
  getAvailableSites: (userId: string) => Promise<{ sites: GscdumpAvailableSite[] }>
  registerSite: (params: RegisterPartnerSiteParams) => Promise<GscdumpSiteRegistration>
  bulkRegisterSites: (params: BulkRegisterPartnerSitesParams) => Promise<BulkRegisterPartnerSitesResponse>
  deleteUser: (userId: string) => Promise<DeletePartnerUserResponse>
  deleteSite: (siteId: string) => Promise<{ success: boolean }>
  getAnalysisSources: (siteId: string, tables?: string[] | string) => Promise<GscdumpAnalysisSourcesResponse>
  getSiteSyncStatus: (siteId: string) => Promise<GscdumpSyncStatusResponse>
  getData: (siteId: string, state: BuilderState, options?: DataQueryOptions) => Promise<GscdumpDataResponse>
  getDataDetail: (siteId: string, state: BuilderState, options?: DataDetailOptions) => Promise<GscdumpDataDetailResponse>
  getAnalysis: (siteId: string, params: GscdumpAnalysisParams) => Promise<GscdumpAnalysisResponse>
  getSitemaps: (siteId: string) => Promise<GscdumpSitemapsResponse>
  getSitemapChanges: (siteId: string, days?: number) => Promise<GscdumpSitemapChangesResponse>
  submitSitemap: (siteId: string, sitemapUrl: string, action?: 'submit' | 'delete') => Promise<{ success: boolean, action: 'submitted' | 'deleted', sitemapUrl: string }>
  refreshSitemaps: (siteId: string) => Promise<{ success: boolean, action: 'refreshed', sitemapCount: number, changed: boolean }>
  getIndexing: (siteId: string, days?: number) => Promise<GscdumpIndexingResponse>
  getIndexingUrls: (siteId: string, params?: IndexingUrlsParams) => Promise<GscdumpIndexingUrlsResponse>
  getIndexingDiagnostics: (siteId: string) => Promise<GscdumpIndexingDiagnosticsResponse>
  requestIndexingInspect: (siteId: string, body: IndexingInspectRequest) => Promise<IndexingInspectResponse | IndexingInspectRateLimited>
  getUserSettings: () => Promise<GscdumpUserSettings>
  patchUserSettings: (body: Partial<GscdumpUserSettings>) => Promise<GscdumpUserSettings>
  recoverPermission: (siteId: string) => Promise<GscdumpPermissionRecovery>
  getTopAssociation: (siteId: string, params: GscdumpTopAssociationParams) => Promise<GscdumpTopAssociationResponse>
  getKeywordSparklines: (siteId: string, params: GscdumpKeywordSparklinesParams) => Promise<GscdumpKeywordSparklinesResponse>
  getQueryTrend: (siteId: string, params: GscdumpQueryTrendParams) => Promise<GscdumpQueryTrendResponse>
  getCanonicalMismatches: (siteId: string) => Promise<GscdumpCanonicalMismatchesResponse>
  getContentVelocity: <T = unknown>(siteId: string, days?: number) => Promise<T>
  getCtrCurve: <T = unknown>(siteId: string, params: GscdumpDateRangeParams) => Promise<T>
  getDarkTraffic: <T = unknown>(siteId: string, params: GscdumpDateRangeParams) => Promise<T>
  getDeviceGap: <T = unknown>(siteId: string, params: GscdumpDateRangeParams) => Promise<T>
  getIndexPercent: (siteId: string, params?: { invisibleLimit?: number, invisibleOffset?: number, orphanLimit?: number }) => Promise<GscdumpIndexPercentResponse>
  getKeywordBreadth: <T = unknown>(siteId: string, params: GscdumpDateRangeParams) => Promise<T>
  getPositionDistribution: <T = unknown>(siteId: string, params: GscdumpDateRangeParams) => Promise<T>
  createTeam: (params: CreatePartnerTeamParams) => Promise<{ team: GscdumpTeamRow }>
  renameTeam: (teamId: string, params: { name: string }) => Promise<{ ok: true, name: string }>
  deleteTeam: (teamId: string) => Promise<{ ok: true }>
  listTeamMembers: (teamId: string) => Promise<{ members: GscdumpTeamMemberRow[] }>
  addTeamMember: (teamId: string, params: AddPartnerTeamMemberParams) => Promise<{ ok: true, role: string, alreadyExisted?: boolean }>
  updateTeamMemberRole: (teamId: string, userId: string, params: { role: GscdumpTeamMemberRow['role'] }) => Promise<{ ok: true, role: string }>
  removeTeamMember: (teamId: string, userId: string) => Promise<{ ok: true }>
  bindSiteToTeam: (userId: string, siteId: string, params: BindPartnerSiteTeamParams) => Promise<{ ok: true, teamId: string | null }>
}

export type PartnerRealtimeEventType
  = | 'sync.progress'
    | 'sync.complete'
    | 'sync.job_complete'
    | 'sync.site_complete'
    | 'sync.failed'
    | 'job.failed'
    | 'auth.failed'
    | 'auth.needs_reauth'
    | 'site.added'
    | 'site.removed'
    | 'enrichment.complete'

export interface RealtimeSyncProgressEvent {
  event: 'sync.progress'
  siteId: string
  siteUrl: string
  table: string
  date: string
  progress: number
}

export interface RealtimeSyncCompleteEvent {
  event: 'sync.complete'
  userId: number
  siteId: string
  siteUrl: string
  table: string
  date: string
  rowsFetched: number
  rowsInserted: number
  timestamp: number
}

export interface RealtimeSyncJobCompleteEvent {
  event: 'sync.job_complete'
  userId: number
  siteId: string
  siteUrl: string
  table: string
  date: string
  rowsFetched: number
  rowsInserted: number
  syncStatus: string
  timestamp: number
}

export interface RealtimeSyncSiteCompleteEvent {
  event: 'sync.site_complete'
  userId: number
  siteId: string
  siteUrl: string
  syncStatus: string
  timestamp: number
}

export interface RealtimeSyncFailedEvent {
  event: 'sync.failed'
  userId: number
  siteId: string
  siteUrl: string
  table: string
  date: string
  error: string
  timestamp: number
}

export interface RealtimeJobFailedEvent {
  event: 'job.failed'
  siteId: string
  siteUrl: string
  table: string
  date: string
  error: string
  timestamp: number
}

export interface RealtimeSiteAddedEvent {
  event: 'site.added'
  userId: number
  siteId: string
  siteUrl: string
}

export interface RealtimeSiteRemovedEvent {
  event: 'site.removed'
  userId: number
  siteId: string
  siteUrl: string
}

export interface RealtimeAuthFailedEvent {
  event: 'auth.failed'
  userId: number
  siteId: string
  siteUrl: string
  error: string
  timestamp: number
}

export interface RealtimeNeedsReauthEvent {
  event: 'auth.needs_reauth'
  userId: number
  failureCount: number
  timestamp: number
}

export interface RealtimeEnrichmentCompleteEvent {
  event: 'enrichment.complete'
  siteId: string
  userId: number
  timestamp: number
}

export type PartnerRealtimeEvent
  = | RealtimeSyncProgressEvent
    | RealtimeSyncCompleteEvent
    | RealtimeSyncJobCompleteEvent
    | RealtimeSyncSiteCompleteEvent
    | RealtimeSyncFailedEvent
    | RealtimeJobFailedEvent
    | RealtimeSiteAddedEvent
    | RealtimeSiteRemovedEvent
    | RealtimeAuthFailedEvent
    | RealtimeNeedsReauthEvent
    | RealtimeEnrichmentCompleteEvent

export interface RealtimeAuthRequiredMessage {
  event: 'auth.required'
  message: string
}

export interface RealtimeConnectedMessage {
  event: 'connected'
  partnerId?: string
  userId?: number
  message: string
}

export interface RealtimeSubscribedMessage {
  type: 'subscribed'
  siteIds?: string[]
  partnerIds?: string[]
}

export interface RealtimePongMessage {
  type: 'pong'
  timestamp: number
}

export interface RealtimeErrorMessage {
  type: 'error'
  message: string
}

export type PartnerRealtimeMessage
  = | PartnerRealtimeEvent
    | RealtimeAuthRequiredMessage
    | RealtimeConnectedMessage
    | RealtimeSubscribedMessage
    | RealtimePongMessage
    | RealtimeErrorMessage

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

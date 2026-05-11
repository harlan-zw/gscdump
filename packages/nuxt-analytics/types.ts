// Public API surface of @gscdump/nuxt-analytics.
// Anything not exported here is considered internal and may change without a major bump.
//
// This package is a frontend-only Nuxt layer. Server-side primitives (auth
// providers, query sources, GSC API helpers) live in their respective sibling
// packages: `@gscdump/analysis` (sources), `gscdump` (GSC API client), and
// host-specific Nitro server code in the consuming app.

export interface AnalyticsPublicRuntimeConfig {
  /** Base URL for DuckDB-WASM worker + bundle assets. Defaults to the origin's static host. */
  duckdbBundleBase?: string
  /**
   * Base URL the client uses to reach the analytics API (`/api/__gsc/*`).
   * Empty string = same-origin. Hosts running the layer as a portable client
   * against a remote origin (e.g. an embedded dashboard pointing at
   * https://gscdump.com) set this via `GSCDUMP_ANALYTICS_API_BASE`.
   */
  apiBase?: string
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
  /** Storage-encoded site id (filesystem + R2 key safe). */
  id: string
  /** GSC property identifier in canonical form (e.g. `sc-domain:nuxtseo.com`). */
  label: string
  /** Bare hostname, stripped of protocol / sc-domain prefix / trailing slash. */
  hostname: string
  propertyType: 'domain' | 'url-prefix'
  /** Storage backend serving analysis. Hosts set this on their `/api/__gsc/sites` override. */
  readBackend?: 'd1' | 'r2'
}

export interface SitemapHistoryResponse {
  path: string | null
  snapshots: import('@gscdump/engine/entities').SitemapRecord[]
}

export interface InspectionHistoryResponse {
  url: string | null
  records: import('@gscdump/engine/entities').InspectionRecord[]
}

export interface GscRowQueryMeta {
  sourceName: string
  sourceKind: 'row' | 'sql'
  queryMs: number
}

export interface GscRowQueryResponse<T = import('@gscdump/analysis').QueryRow> {
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

export interface AnalysisSourcesResponse {
  tables: Record<string, string[]>
  generatedAt: string
  manifestVersion: string
}

export interface SourceInfoResponse {
  name: string
  kind: 'row' | 'sql'
  capabilities: { attachedTables?: boolean, [k: string]: unknown }
  supportedAnalyzerIds: string[]
  browserAttachEligible: boolean
}

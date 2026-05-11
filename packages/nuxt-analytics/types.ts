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

export type {
  AnalysisSourcesResponse,
  CountriesResponse,
  CountryRow,
  GscApiRange,
  GscRowQueryMeta,
  GscRowQueryResponse,
  IndexingDiagnostics,
  IndexingIssue,
  IndexingIssueSeverity,
  IndexingUrlRow,
  IndexingUrlStatus,
  IndexingUrlsResponse,
  InspectionHistoryRecord,
  InspectionHistoryResponse,
  SearchAppearanceResponse,
  SearchAppearanceRow,
  SiteListItem,
  SitemapAddedRow,
  SitemapChangesResponse,
  SitemapHistoryRecord,
  SitemapHistoryResponse,
  SitemapRemovedRow,
  SourceInfoResponse,
} from '@gscdump/contracts'

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

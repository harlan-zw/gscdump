// Public API surface of @gscdump/nuxt-analytics.
// Anything not exported here is considered internal and may change without a major bump.

/**
 * Resolves the current viewer's tenant + site scope for every analytics request.
 *
 * Registered by the host app at Nitro boot:
 *
 *   // server/plugins/analytics-auth.ts
 *   import { registerAnalyticsAuthProvider } from '#analytics/auth'
 *   export default defineNitroPlugin(() => {
 *     registerAnalyticsAuthProvider({
 *       resolve: async (event) => { ... },
 *     })
 *   })
 *
 * Implementations:
 * - gscdump.com: reads the session cookie, maps session → userId + accessible siteIds.
 * - nuxtseo.com: resolves the pro user, fetches their gscdump API key, returns a
 *   consumer-scoped identity carrying the key for downstream origin calls.
 * - examples/nuxt-dashboard: env-based — reads GSCDUMP_USER_ID / GSCDUMP_SITE_ID from runtime config.
 */
export interface AnalyticsAuthProvider {
  /**
   * Resolve the viewer's identity from the current H3 event.
   * Return `null` to signal unauthenticated; the layer will 401 the request.
   */
  resolve: (event: import('h3').H3Event) => Promise<AnalyticsIdentity | null> | AnalyticsIdentity | null
}

export interface AnalyticsIdentity {
  userId: string
  /** Site IDs the viewer may read. Empty = all sites for this user. */
  siteIds?: string[]
  /** Consumer-mode only: API key forwarded to the origin. */
  originApiKey?: string
  /**
   * Opaque host-controlled tags. The layer never reads these; they're
   * carried so the source provider (and the host's own handlers) can make
   * tier/plan/entitlement decisions without widening the identity contract.
   *
   * Example hosts: `{ tier: 'free' | 'pro' }`, `{ plan: 'team' }`.
   */
  attrs?: Record<string, unknown>
}

/**
 * Resolves the AnalysisQuerySource a request will run analyzers against.
 *
 * Registered by the host app at Nitro boot, alongside the auth provider:
 *
 *   // server/plugins/analytics-source.ts
 *   import { registerAnalyticsSourceProvider } from '#analytics/source'
 *   import { createGscApiQuerySource, createEngineQuerySource } from '@gscdump/analysis'
 *   export default defineNitroPlugin(() => {
 *     registerAnalyticsSourceProvider({
 *       resolve: async (event, identity, siteId) => {
 *         if (identity.attrs?.tier === 'free')
 *           return createGscApiQuerySource({ client, siteUrl: siteId })
 *         return createEngineQuerySource({ engine, ctx: { userId: identity.userId, siteId } })
 *       },
 *     })
 *   })
 *
 * The layer owns no policy here — which source a request gets is host business
 * logic. Capability mismatches surface as `AnalyzerCapabilityError` from the
 * analyzer dispatcher; the analyze endpoint converts those into structured
 * 402 responses the client treats as "locked feature".
 */
export interface AnalyticsSourceResolution {
  source: import('@gscdump/analysis').AnalysisQuerySource
  /**
   * Host-declared deploy-shape hint: true when the same data is also available
   * to the browser via `/api/__gsc/sites/:siteId/analysis-sources` as parquet URLs,
   * so the client should boot DuckDB-WASM + attach them locally instead of
   * proxying analyze() calls to the server.
   *
   * This is NOT a source capability (the server source isn't the browser
   * runtime). It's a parallel signal about where reads are fastest.
   *
   * Defaults to `false`. When false, the client routes analyze() through
   * POST /api/__gsc/sites/:siteId/analyze.
   */
  browserAttachEligible?: boolean
}

export interface AnalyticsSourceProvider {
  resolve: (
    event: import('h3').H3Event,
    identity: AnalyticsIdentity,
    siteId: string,
  ) => Promise<AnalyticsSourceResolution | null> | AnalyticsSourceResolution | null
}

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

/**
 * Resolves a siteId (the layer's opaque identifier) into the canonical GSC
 * property URL + storage tenant suffix. Hosts know the schema; the layer
 * doesn't.
 *
 *   // server/plugins/analytics-site.ts
 *   registerAnalyticsSiteResolver({
 *     resolve: async (event, identity, siteId) => {
 *       const site = await getSiteByPublicId(useDb(event), siteId)
 *       if (!site || String(site.userId) !== identity.userId) return null
 *       return {
 *         siteUrl: site.gscSiteUrl.includes('://') ? site.gscSiteUrl : `sc-domain:${site.gscSiteUrl}`,
 *         hostname: ...,
 *         storageId: String(site.id),
 *       }
 *     },
 *   })
 */
export interface AnalyticsSiteInfo {
  /** Canonical GSC property URL (`sc-domain:example.com` or `https://example.com/`). */
  siteUrl: string
  /** Bare hostname, stripped of protocol / sc-domain prefix / trailing slash. */
  hostname: string
  /** Storage segment used to build R2 paths `u_<userId>/<storageId>/...`. */
  storageId: string
}

export interface AnalyticsSiteResolver {
  resolve: (
    event: import('h3').H3Event,
    identity: AnalyticsIdentity,
    siteId: string,
  ) => Promise<AnalyticsSiteInfo | null> | AnalyticsSiteInfo | null
}

/**
 * Provides the host's drizzle D1 instance to the layer's engine factory. The
 * layer doesn't import drizzle directly because pnpm dedupe quirks mean the
 * host's drizzle types aren't structurally identical to ours.
 *
 *   // server/plugins/analytics-db.ts
 *   registerAnalyticsDbProvider({ get: event => useDb(event) })
 */
export interface AnalyticsDbProvider {
  get: (event: import('h3').H3Event) => unknown
}

// ============================================================================
// GSC-API seam
//
// Free-tier endpoints in the layer (`/api/__gsc/sites/:siteId/{sitemaps,
// countries,rollup/:id}`) go live against the Google Search Console API. The
// layer owns no credentials — hosts register an access-token provider at
// Nitro boot and the endpoints call it per request.
// ============================================================================

/**
 * Resolves a Google OAuth access token for a GSC-API request. Registered by
 * the host once at Nitro boot:
 *
 *   // server/plugins/gsc-api.ts
 *   export default defineNitroPlugin(() => {
 *     registerGscApiAccessTokenProvider({
 *       getAccessToken: () => getGoogleAccessToken(),
 *     })
 *   })
 *
 * Called every time a free-tier endpoint synthesises from the GSC API. Return
 * `null` to signal "no token available" — the endpoint then 502s with a
 * stable error the UI treats as a token-expired condition.
 */
export interface GscApiAccessTokenProvider {
  getAccessToken: (
    event: import('h3').H3Event,
    identity: AnalyticsIdentity,
  ) => Promise<string | null> | string | null
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

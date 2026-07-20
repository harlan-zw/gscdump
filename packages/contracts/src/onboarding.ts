export const GSCDUMP_ONBOARDING_CONTRACT_VERSION = '2026-05-11' as const

export const GSCDUMP_REQUIRED_ANALYTICS_SCOPE = 'https://www.googleapis.com/auth/webmasters.readonly' as const
// The broader read+write Search Console scope is a strict superset of the
// readonly scope, so granting it satisfies the analytics requirement too.
export const GSCDUMP_WRITE_ANALYTICS_SCOPE = 'https://www.googleapis.com/auth/webmasters' as const
export const GSCDUMP_OPTIONAL_INDEXING_SCOPE = 'https://www.googleapis.com/auth/indexing' as const

type GoogleScopesInput = string | readonly string[] | null | undefined

export const accountStatuses = [
  'disconnected',
  'oauth_received',
  'scope_missing',
  'refresh_missing',
  'db_provisioning',
  'ready',
  'reauth_required',
] as const

export const accountNextActions = [
  'connect_google',
  'reconnect_google',
  'wait_for_provisioning',
  'none',
] as const

export const propertyStatuses = [
  'no_local_site',
  'no_gsc_property',
  'unverified_property',
  'verified_candidate',
  'registered',
  'linked',
] as const

export const propertyNextActions = [
  'create_site',
  'verify_gsc_property',
  'choose_property',
  'register_site',
  'none',
] as const

export const analyticsStatuses = [
  'not_registered',
  'queued',
  'preparing',
  'syncing',
  'queryable_live',
  'queryable_partial',
  'ready',
  'failed',
] as const

export const analyticsNextActions = [
  'wait_for_sync',
  'retry_sync',
  'none',
] as const

export const querySourceModes = [
  'none',
  'live',
  'd1',
  'r2',
  'mixed',
] as const

export const sitemapStatuses = [
  'unknown',
  'discovering',
  'none_found',
  'auto_submitted',
  'syncing',
  'ready',
  'failed',
] as const

export const sitemapNextActions = [
  'submit_sitemap',
  'wait_for_sitemaps',
  'retry_sitemaps',
  'none',
] as const

export const indexingStatuses = [
  'not_requested',
  'missing_scope',
  'insufficient_permission',
  'waiting_for_sitemaps',
  'discovering',
  'checking',
  'ready',
  'budget_exhausted',
  'no_urls',
  'failed',
] as const

export const indexingNextActions = [
  'reconnect_google',
  'fix_gsc_permission',
  'wait_for_sitemaps',
  'wait_for_indexing',
  'retry_indexing',
  'none',
] as const

export const lifecycleErrorCodes = [
  'missing_refresh_token',
  'missing_analytics_scope',
  'missing_indexing_scope',
  'token_refresh_failed',
  'permission_lost',
  'insufficient_gsc_permission',
  'gsc_property_not_found',
  'gsc_property_unverified',
  'user_database_not_provisioned',
  'sync_failed',
  'sitemap_sync_failed',
  'indexing_failed',
] as const

export type AccountStatus = typeof accountStatuses[number]
export type AccountNextAction = typeof accountNextActions[number]
export type PropertyStatus = typeof propertyStatuses[number]
export type PropertyNextAction = typeof propertyNextActions[number]
export type AnalyticsStatus = typeof analyticsStatuses[number]
export type AnalyticsNextAction = typeof analyticsNextActions[number]
export type QuerySourceMode = typeof querySourceModes[number]
export type SitemapStatus = typeof sitemapStatuses[number]
export type SitemapNextAction = typeof sitemapNextActions[number]
export type IndexingStatus = typeof indexingStatuses[number]
export type IndexingNextAction = typeof indexingNextActions[number]
export type LifecycleWebhookEvent
  = | 'user.lifecycle.changed'
    | 'site.lifecycle.changed'
    | 'site.analytics.ready'
    | 'site.indexing.ready'
    | 'site.auth.failed'
    | 'job.failed'
export type LifecycleErrorCode = typeof lifecycleErrorCodes[number]

export interface LifecycleProgress {
  completed: number
  failed: number
  total: number
  percent: number
}

export interface LifecycleError {
  code: LifecycleErrorCode
  message: string
  retryable: boolean
}

export interface PartnerLifecycleAccount {
  status: AccountStatus
  grantedScopes: string[]
  missingScopes: string[]
  nextAction: AccountNextAction
}

export interface PartnerLifecycleSite {
  siteId: string
  /** Integer alias (`user_sites.int_id`) — the int JOIN key partners denormalize into their own catalog namespaces. Nullable only for pre-0029 unbackfilled rows. */
  intId: number | null
  /** Team-scoped catalog identifier (`user_sites.catalog_site_id`). Defaults to `intId` for sites without a caller-supplied catalog ID. */
  catalogSiteId: number | null
  externalSiteId: string | null
  requestedUrl: string
  gscPropertyUrl: string | null
  permissionLevel: string | null
  property: {
    status: PropertyStatus
    nextAction: PropertyNextAction
  }
  analytics: {
    status: AnalyticsStatus
    progress: LifecycleProgress
    queryable: boolean
    sourceMode: QuerySourceMode
    syncedRange: { oldest: string | null, newest: string | null }
    nextAction: AnalyticsNextAction
  }
  sitemaps: {
    status: SitemapStatus
    discoveredCount: number
    nextAction: SitemapNextAction
  }
  indexing: {
    status: IndexingStatus
    eligible: boolean
    reason: string | null
    progress: LifecycleProgress
    nextAction: IndexingNextAction
  }
  latestError: LifecycleError | null
  lifecycleRevision: number
  updatedAt: string
}

export interface PartnerLifecycleResponse {
  contractVersion: typeof GSCDUMP_ONBOARDING_CONTRACT_VERSION
  userId: string
  partnerId: string | null
  currentTeamId: string | null
  account: PartnerLifecycleAccount
  sites: PartnerLifecycleSite[]
}

export interface LifecycleWebhookEnvelope<TData extends Record<string, unknown> = Record<string, unknown>> {
  contractVersion: typeof GSCDUMP_ONBOARDING_CONTRACT_VERSION
  deliveryId: string
  event: LifecycleWebhookEvent
  partnerId: string
  userId: string
  siteId?: string
  externalUserId?: string | null
  externalSiteId?: string | null
  lifecycleRevision: number
  occurredAt: string
  data: TData
}

export function parseGrantedScopes(scopes: GoogleScopesInput): string[] {
  if (!scopes)
    return []
  if (typeof scopes === 'string')
    return scopes.split(/\s+/).map(scope => scope.trim()).filter(Boolean)
  return scopes.map(scope => scope.trim()).filter(Boolean)
}

function hasGoogleScope(scopes: GoogleScopesInput, scope: string): boolean {
  const granted = parseGrantedScopes(scopes)
  const suffix = scope.replace('https://www.googleapis.com/auth/', '')
  return granted.includes(scope) || granted.includes(suffix)
}

export function hasRequiredAnalyticsScope(scopes: GoogleScopesInput): boolean {
  return hasGoogleScope(scopes, GSCDUMP_REQUIRED_ANALYTICS_SCOPE)
    || hasGoogleScope(scopes, GSCDUMP_WRITE_ANALYTICS_SCOPE)
}

export function hasOptionalIndexingScope(scopes: GoogleScopesInput): boolean {
  return hasGoogleScope(scopes, GSCDUMP_OPTIONAL_INDEXING_SCOPE)
}

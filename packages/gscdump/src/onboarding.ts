export const GSCDUMP_ONBOARDING_CONTRACT_VERSION = '2026-05-11' as const

export const GSCDUMP_REQUIRED_ANALYTICS_SCOPE = 'https://www.googleapis.com/auth/webmasters.readonly' as const
export const GSCDUMP_OPTIONAL_INDEXING_SCOPE = 'https://www.googleapis.com/auth/indexing' as const

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

export const lifecycleWebhookEvents = [
  'user.lifecycle.changed',
  'site.lifecycle.changed',
  'site.analytics.ready',
  'site.indexing.ready',
  'site.auth.failed',
  'job.failed',
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
export type LifecycleWebhookEvent = typeof lifecycleWebhookEvents[number]
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

export function parseGrantedScopes(scopes: string | null | undefined): string[] {
  return (scopes ?? '').split(/\s+/).map(s => s.trim()).filter(Boolean)
}

export function hasRequiredAnalyticsScope(scopes: string | string[] | null | undefined): boolean {
  const granted = Array.isArray(scopes) ? scopes : parseGrantedScopes(scopes)
  return granted.includes(GSCDUMP_REQUIRED_ANALYTICS_SCOPE)
}

export function hasOptionalIndexingScope(scopes: string | string[] | null | undefined): boolean {
  const granted = Array.isArray(scopes) ? scopes : parseGrantedScopes(scopes)
  return granted.includes(GSCDUMP_OPTIONAL_INDEXING_SCOPE)
}


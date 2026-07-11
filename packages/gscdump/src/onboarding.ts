/**
 * Compatibility re-export for the hosted onboarding contract.
 *
 * `@gscdump/contracts` owns these wire values and types (ADR-0011). Keeping
 * this file as a pure re-export preserves the historical `gscdump` root
 * surface without maintaining a second, drift-prone declaration set.
 */
export {
  accountNextActions,
  accountStatuses,
  analyticsNextActions,
  analyticsStatuses,
  GSCDUMP_ONBOARDING_CONTRACT_VERSION,
  GSCDUMP_OPTIONAL_INDEXING_SCOPE,
  GSCDUMP_REQUIRED_ANALYTICS_SCOPE,
  GSCDUMP_WRITE_ANALYTICS_SCOPE,
  hasOptionalIndexingScope,
  hasRequiredAnalyticsScope,
  indexingNextActions,
  indexingStatuses,
  lifecycleErrorCodes,
  lifecycleWebhookEvents,
  parseGrantedScopes,
  propertyNextActions,
  propertyStatuses,
  querySourceModes,
  sitemapNextActions,
  sitemapStatuses,
} from '@gscdump/contracts/partner'

export type {
  AccountNextAction,
  AccountStatus,
  AnalyticsNextAction,
  AnalyticsStatus,
  IndexingNextAction,
  IndexingStatus,
  LifecycleError,
  LifecycleErrorCode,
  LifecycleProgress,
  LifecycleWebhookEnvelope,
  LifecycleWebhookEvent,
  PartnerLifecycleAccount,
  PartnerLifecycleResponse,
  PartnerLifecycleSite,
  PropertyNextAction,
  PropertyStatus,
  QuerySourceMode,
  SitemapNextAction,
  SitemapStatus,
} from '@gscdump/contracts/partner'

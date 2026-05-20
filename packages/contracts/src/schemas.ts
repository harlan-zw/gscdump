import { z } from 'zod'
import {
  accountNextActions,
  accountStatuses,
  analyticsNextActions,
  analyticsStatuses,
  GSCDUMP_ONBOARDING_CONTRACT_VERSION,
  indexingNextActions,
  indexingStatuses,
  lifecycleErrorCodes,
  propertyNextActions,
  propertyStatuses,
  querySourceModes,
  sitemapNextActions,
  sitemapStatuses,
} from './onboarding'
import {
  CANONICAL_WEBHOOK_EVENTS,
  WEBHOOK_CONTRACT_VERSION,
} from './webhook-constants'

const unknownRecord = z.record(z.string(), z.unknown())

export const builderStateSchema = unknownRecord

/**
 * GSC search-type slice validator. Mirrors the `GscSearchType` union from
 * `gscdump/contracts` and the `SearchTypes` constants in `gscdump/query`. Used by consumers
 * routing requests across slices (web | discover | news | googleNews | image |
 * video) to validate untrusted input before threading it to the engine.
 */
export const searchTypeSchema = z.enum(['web', 'image', 'video', 'news', 'discover', 'googleNews'])

export const gscComparisonFilterSchema = z.enum(['new', 'lost', 'improving', 'declining'])

export const gscApiRangeSchema = z.object({
  start: z.string(),
  end: z.string(),
})

export const countryRowSchema = z.object({
  country: z.string(),
  clicks: z.number(),
  impressions: z.number(),
  sum_position: z.number(),
}).loose()

export const countriesResponseSchema = z.object({
  rows: z.array(countryRowSchema),
  range: gscApiRangeSchema,
  generatedAt: z.string(),
  source: z.enum(['gsc-api', 'engine']),
}).loose()

export const searchAppearanceRowSchema = z.object({
  searchAppearance: z.string(),
  clicks: z.number(),
  impressions: z.number(),
  sum_position: z.number(),
}).loose()

export const searchAppearanceResponseSchema = z.object({
  rows: z.array(searchAppearanceRowSchema),
  range: gscApiRangeSchema,
  generatedAt: z.string(),
  source: z.enum(['gsc-api', 'engine']),
}).loose()

export const siteListItemSchema = z.object({
  id: z.string(),
  label: z.string(),
  hostname: z.string(),
  propertyType: z.enum(['domain', 'url-prefix']),
  readBackend: z.enum(['d1', 'r2']).optional(),
}).loose()

export const sitemapHistoryRecordSchema = z.object({
  path: z.string(),
  capturedAt: z.string(),
}).loose()

export const sitemapHistoryResponseSchema = z.object({
  path: z.string().nullable(),
  snapshots: z.array(sitemapHistoryRecordSchema),
}).loose()

/** Adaptive recheck schedule shape — must match `ScheduleState` in types.ts. */
export const scheduleStateSchema = z.object({
  nextAt: z.number(),
  consecutiveUnchanged: z.number(),
  policyVersion: z.number(),
}).loose()

/**
 * `raw` extension on inspection records. JSON-encoded `string | null`
 * fields surface unchanged from D1; consumers parse on read. `.loose()`
 * preserves forward-compatibility for fields added without a contract bump.
 */
export const inspectionRecordRawSchema = z.object({
  schedule: scheduleStateSchema.optional(),
  nextCheckAfter: z.number().optional(),
  priority: z.enum(['high', 'medium', 'low']).optional(),
  sitemaps: z.string().nullable().optional(),
  referringUrls: z.string().nullable().optional(),
  crawlingUserAgent: z.string().nullable().optional(),
  mobileIssues: z.string().nullable().optional(),
  richResultsItems: z.string().nullable().optional(),
  inspectionResultLink: z.string().nullable().optional(),
}).loose()

export const inspectionHistoryRecordSchema = z.object({
  url: z.string(),
  inspectedAt: z.string(),
  indexStatus: z.string().optional(),
  lastCrawlTime: z.string().optional(),
  googleCanonical: z.string().optional(),
  userCanonical: z.string().optional(),
  coverageState: z.string().optional(),
  robotsTxtState: z.string().optional(),
  indexingState: z.string().optional(),
  pageFetchState: z.string().optional(),
  mobileUsabilityVerdict: z.string().optional(),
  richResultsVerdict: z.string().optional(),
  raw: inspectionRecordRawSchema.optional(),
}).loose()

export const inspectionHistoryResponseSchema = z.object({
  url: z.string().nullable(),
  records: z.array(inspectionHistoryRecordSchema),
}).loose()

export const sitemapIndexSchema = z.object({
  version: z.literal(1),
  records: z.record(z.string(), sitemapHistoryRecordSchema),
}).loose()

export const inspectionIndexSchema = z.object({
  version: z.literal(1),
  records: z.record(z.string(), inspectionHistoryRecordSchema),
}).loose()

export const rollupEnvelopeSchema = z.object({
  version: z.literal(1),
  id: z.string(),
  builtAt: z.number(),
  windowDays: z.number().nullable(),
  payload: z.unknown(),
}).loose()

export const gscRowQueryMetaSchema = z.object({
  sourceName: z.string(),
  sourceKind: z.enum(['row', 'sql']),
  queryMs: z.number(),
}).loose()

export const gscRowQueryResponseSchema = z.object({
  rows: z.array(unknownRecord),
  meta: gscRowQueryMetaSchema,
}).loose()

export const indexingUrlStatusSchema = z.enum(['indexed', 'not_indexed', 'pending'])

export const indexingUrlRowSchema = z.object({
  url: z.string(),
  verdict: z.string().nullable(),
  coverageState: z.string().nullable(),
  indexingState: z.string().nullable(),
  robotsTxtState: z.string().nullable(),
  pageFetchState: z.string().nullable(),
  lastCrawlTime: z.string().nullable(),
  crawlingUserAgent: z.string().nullable(),
  userCanonical: z.string().nullable(),
  googleCanonical: z.string().nullable(),
  sitemaps: z.array(z.string()).nullable(),
  referringUrls: z.array(z.string()).nullable(),
  mobileVerdict: z.string().nullable(),
  mobileIssues: z.array(z.unknown()).nullable(),
  richResultsVerdict: z.string().nullable(),
  richResultsItems: z.array(z.unknown()).nullable(),
  inspectionResultLink: z.string().nullable(),
  firstCheckedAt: z.string(),
  lastCheckedAt: z.string(),
  checkCount: z.number(),
}).loose()

export const indexingUrlsResponseSchema = z.object({
  urls: z.array(indexingUrlRowSchema),
  pagination: z.object({
    total: z.number(),
    limit: z.number(),
    offset: z.number(),
    hasMore: z.boolean(),
  }).loose(),
  meta: z.object({
    siteUrl: z.string(),
    status: z.string(),
    issue: z.string().nullable(),
  }).loose(),
}).loose()

export const indexingIssueSchema = z.object({
  type: z.string(),
  label: z.string(),
  severity: z.enum(['error', 'warning', 'info']),
  count: z.number(),
}).loose()

export const indexingDiagnosticsSchema = z.object({
  summary: z.object({
    totalUrls: z.number(),
    indexed: z.number(),
    indexedPercent: z.number(),
  }).loose(),
  issues: z.array(indexingIssueSchema),
  meta: z.object({ siteUrl: z.string() }).loose(),
}).loose()

export const indexingInspectRequestSchema = z.object({
  urls: z.array(z.string().url()).min(1).max(10),
})

export const indexingInspectResultSchema = z.object({
  url: z.string(),
  verdict: z.string().nullable(),
  coverageState: z.string().nullable(),
  indexingState: z.string().nullable(),
  robotsTxtState: z.string().nullable(),
  pageFetchState: z.string().nullable(),
  lastCrawlTime: z.string().nullable(),
  crawlingUserAgent: z.string().nullable(),
  userCanonical: z.string().nullable(),
  googleCanonical: z.string().nullable(),
  sitemaps: z.string().nullable(),
  referringUrls: z.string().nullable(),
  mobileVerdict: z.string().nullable(),
  mobileIssues: z.string().nullable(),
  richResultsVerdict: z.string().nullable(),
  richResultsItems: z.string().nullable(),
  inspectionResultLink: z.string().nullable(),
}).loose()

export const indexingInspectResponseSchema = z.object({
  siteId: z.string(),
  rateLimit: z.object({
    reserved: z.number(),
    remaining: z.number(),
    limit: z.number(),
  }).loose(),
  results: z.array(indexingInspectResultSchema),
  errors: z.array(z.object({ url: z.string(), error: z.string() }).loose()),
  skipped: z.array(z.object({ url: z.string(), reason: z.string() }).loose()),
}).loose()

export const indexingInspectRateLimitedSchema = z.object({
  error: z.literal('rate_limited'),
  message: z.string(),
  rateLimit: z.object({
    reserved: z.literal(0),
    remaining: z.literal(0),
    limit: z.number(),
  }).loose(),
  retryAfterSeconds: z.number(),
}).loose()

export const indexingInspectAnyResponseSchema = z.union([
  indexingInspectResponseSchema,
  indexingInspectRateLimitedSchema,
])

export const sitemapChangesResponseSchema = z.object({
  added: z.array(z.object({
    url: z.string(),
    sitemap: z.string(),
    firstSeenAt: z.number(),
  }).loose()),
  removed: z.array(z.object({
    url: z.string(),
    sitemap: z.string(),
    removedAt: z.number(),
  }).loose()),
  summary: z.object({
    totalAdded: z.number(),
    totalRemoved: z.number(),
    period: z.object({ days: z.number() }),
  }).loose(),
}).loose()

export const sourceInfoResponseSchema = z.object({
  name: z.string(),
  kind: z.enum(['row', 'sql']),
  capabilities: z.object({ attachedTables: z.boolean().optional() }).loose(),
  supportedAnalyzerIds: z.array(z.string()),
  browserAttachEligible: z.boolean(),
  identityAttrs: unknownRecord.nullable().optional(),
}).loose()

export const whoamiResponseSchema = z.object({
  userId: z.string().nullable().optional(),
  plan: z.string().nullable().optional(),
  attrs: unknownRecord.optional(),
}).loose()

export const backfillRangeSchema = z.object({
  startDate: z.string(),
  endDate: z.string(),
}).loose()

export const backfillResponseSchema = z.object({
  ok: z.boolean().optional(),
  queued: z.boolean().optional(),
}).loose()

export const gscdumpTotalsSchema = z.object({
  clicks: z.number(),
  impressions: z.number(),
  ctr: z.number(),
  position: z.number(),
})

export const gscdumpMetaSchema = z.object({
  siteUrl: z.string(),
  syncStatus: z.string(),
  newestDateSynced: z.string().nullable(),
  oldestDateSynced: z.string().nullable(),
  dataDelay: z.string(),
  dataEndDate: z.string().nullable().optional(),
  warnings: z.array(z.string()).optional(),
  enrichment: z.object({
    lastEnriched: z.number(),
    isDue: z.boolean(),
  }).optional(),
  backfill: z.object({
    percent: z.number(),
    daysRemaining: z.number().optional(),
  }).optional(),
}).loose()

export const gscdumpDataRowSchema = z.object({
  clicks: z.number(),
  impressions: z.number(),
  ctr: z.number(),
  position: z.number(),
}).loose()

export const gscdumpDataResponseSchema = z.object({
  rows: z.array(gscdumpDataRowSchema),
  totalCount: z.number(),
  totals: gscdumpTotalsSchema,
  meta: gscdumpMetaSchema,
})

export const gscdumpDataDetailResponseSchema = z.object({
  daily: z.array(z.object({
    date: z.string(),
    clicks: z.number(),
    impressions: z.number(),
    ctr: z.number(),
    position: z.number(),
  }).loose()),
  totals: gscdumpTotalsSchema,
  previousTotals: gscdumpTotalsSchema.optional(),
  meta: gscdumpMetaSchema,
})

export const registerPartnerUserSchema = z.object({
  userGoogleId: z.string().min(1),
  userEmail: z.email(),
  userName: z.string().optional(),
  accessToken: z.string().min(1),
  refreshToken: z.string().min(1),
  tokenExpiresAt: z.number().optional(),
})

export const updatePartnerUserTokensSchema = z.object({
  accessToken: z.string().min(1),
  refreshToken: z.string().min(1),
  tokenExpiresAt: z.number().optional(),
})

export const gscdumpUserRegistrationSchema = z.object({
  userId: z.string(),
  apiKey: z.string().optional(),
  isNew: z.boolean().optional(),
  status: z.enum(['provisioning', 'ready']).optional(),
}).loose()

export const gscdumpUserStatusSchema = z.object({
  userId: z.string(),
  status: z.enum(['provisioning', 'ready', 'reauth_required']),
  databaseReady: z.boolean().optional(),
  needsReauth: z.boolean().optional(),
  reauthRequired: z.boolean().optional(),
  reauthReason: z.string().nullable().optional(),
  authFailureCount: z.number().optional(),
  nextAction: z.enum(['reconnect_google', 'none']).optional(),
  grantedScopes: z.string().nullable().optional(),
}).loose()

export const lifecycleProgressSchema = z.object({
  completed: z.number(),
  failed: z.number(),
  total: z.number(),
  percent: z.number(),
})

export const lifecycleErrorSchema = z.object({
  code: z.enum(lifecycleErrorCodes),
  message: z.string(),
  retryable: z.boolean(),
})

export const partnerLifecycleAccountSchema = z.object({
  status: z.enum(accountStatuses),
  grantedScopes: z.array(z.string()),
  missingScopes: z.array(z.string()),
  nextAction: z.enum(accountNextActions),
}).loose()

export const partnerLifecycleSiteSchema = z.object({
  siteId: z.string(),
  externalSiteId: z.string().nullable(),
  requestedUrl: z.string(),
  gscPropertyUrl: z.string().nullable(),
  permissionLevel: z.string().nullable(),
  property: z.object({
    status: z.enum(propertyStatuses),
    nextAction: z.enum(propertyNextActions),
  }).loose(),
  analytics: z.object({
    status: z.enum(analyticsStatuses),
    progress: lifecycleProgressSchema,
    queryable: z.boolean(),
    sourceMode: z.enum(querySourceModes),
    syncedRange: z.object({
      oldest: z.string().nullable(),
      newest: z.string().nullable(),
    }).loose(),
    nextAction: z.enum(analyticsNextActions),
  }).loose(),
  sitemaps: z.object({
    status: z.enum(sitemapStatuses),
    discoveredCount: z.number(),
    nextAction: z.enum(sitemapNextActions),
  }).loose(),
  indexing: z.object({
    status: z.enum(indexingStatuses),
    eligible: z.boolean(),
    reason: z.string().nullable(),
    progress: lifecycleProgressSchema,
    nextAction: z.enum(indexingNextActions),
  }).loose(),
  latestError: lifecycleErrorSchema.nullable(),
  lifecycleRevision: z.number(),
  updatedAt: z.string(),
}).loose()

export const partnerLifecycleResponseSchema = z.object({
  contractVersion: z.literal(GSCDUMP_ONBOARDING_CONTRACT_VERSION),
  userId: z.string(),
  partnerId: z.string().nullable(),
  account: partnerLifecycleAccountSchema,
  sites: z.array(partnerLifecycleSiteSchema),
}).loose()

export const gscdumpAvailableSiteSchema = z.object({
  siteUrl: z.string(),
  permissionLevel: z.string(),
  registered: z.boolean(),
  siteId: z.string().optional(),
  syncStatus: z.enum(['pending', 'syncing', 'synced', 'error']).nullable().optional(),
  syncProgress: z.object({
    completed: z.number(),
    failed: z.number().optional(),
    total: z.number(),
    percent: z.number(),
  }).optional(),
  lastSyncAt: z.number().nullable().optional(),
  newestDateSynced: z.string().nullable().optional(),
  oldestDateSynced: z.string().nullable().optional(),
}).loose()

export const gscdumpUserSiteSchema = z.object({
  siteId: z.string(),
  siteUrl: z.string(),
  syncStatus: z.enum(['idle', 'pending', 'syncing', 'synced', 'error']),
  lastSyncAt: z.number().nullable(),
  newestDateSynced: z.string().nullable(),
  oldestDateSynced: z.string().nullable(),
}).loose()

export const gscdumpSiteRegistrationSchema = z.object({
  siteId: z.string(),
  status: z.enum(['idle', 'pending', 'syncing', 'synced', 'error']),
  message: z.string().optional(),
  existing: z.boolean().optional(),
  indexingEligible: z.boolean().optional(),
  indexingIneligibleReason: z.enum(['missing_indexing_scope', 'insufficient_gsc_permission']).optional(),
  indexingPermissionLevel: z.string().nullable().optional(),
  grantedScopes: z.array(z.string()).optional(),
}).loose()

export const registerPartnerSiteSchema = z.object({
  userId: z.string(),
  siteUrl: z.string().min(1),
  requestedUrl: z.string().optional(),
  gscPropertyUrl: z.string().optional(),
  externalSiteId: z.string().optional(),
  externalSiteUrl: z.string().optional(),
  webhookUrl: z.url().optional(),
  webhookEvents: z.array(z.enum(CANONICAL_WEBHOOK_EVENTS)).optional(),
  teamId: z.string().optional(),
  // GSC slices the partner wants to sync for this site. Server-side validation
  // (validateEnabledSearchTypes) always implies 'web'; missing field defaults
  // to ['web']. Invalid slices are rejected with 400.
  enabledSearchTypes: z.array(searchTypeSchema).optional(),
})

export const bulkRegisterPartnerSitesSchema = z.object({
  userId: z.string().optional(),
  siteUrls: z.array(z.string().min(1)).optional(),
  sites: z.array(z.object({
    siteUrl: z.string().optional(),
    requestedUrl: z.string().optional(),
    gscPropertyUrl: z.string().optional(),
    externalSiteId: z.string().optional(),
    externalSiteUrl: z.string().optional(),
    webhookUrl: z.url().optional(),
    webhookEvents: z.array(z.enum(CANONICAL_WEBHOOK_EVENTS)).optional(),
  }).loose()).optional(),
}).refine(value => (value.siteUrls?.length ?? 0) > 0 || (value.sites?.length ?? 0) > 0, {
  message: 'siteUrls or sites is required',
})

export const bulkRegisterPartnerSitesResponseSchema = z.object({
  results: z.array(z.object({
    siteUrl: z.string(),
    siteId: z.string().optional(),
    status: z.enum(['registered', 'already_exists', 'not_found', 'error']),
    error: z.string().optional(),
    site: unknownRecord.nullable().optional(),
    indexingEligible: z.boolean().optional(),
    indexingIneligibleReason: z.enum(['missing_indexing_scope', 'insufficient_gsc_permission']).optional(),
    indexingPermissionLevel: z.string().nullable().optional(),
    grantedScopes: z.array(z.string()).optional(),
  }).loose()),
  summary: z.object({
    registered: z.number(),
    alreadyExists: z.number(),
    notFound: z.number(),
    errors: z.number(),
  }),
}).loose()

export const dataQueryOptionsSchema = z.object({
  comparison: builderStateSchema.optional(),
  filter: gscComparisonFilterSchema.optional(),
}).optional()

export const dataDetailOptionsSchema = z.object({
  comparison: builderStateSchema.optional(),
}).optional()

export const gscdumpAnalysisPresetSchema = z.enum([
  'striking-distance',
  'opportunity',
  'decay',
  'zero-click',
  'non-brand',
  'brand-only',
  'movers-rising',
  'movers-declining',
])

export const gscdumpAnalysisParamsSchema = z.object({
  preset: gscdumpAnalysisPresetSchema,
  startDate: z.string(),
  endDate: z.string(),
  prevStartDate: z.string().optional(),
  prevEndDate: z.string().optional(),
  brandTerms: z.string().optional(),
  limit: z.number().optional(),
  offset: z.number().optional(),
  search: z.string().optional(),
  minImpressions: z.number().optional(),
  minPosition: z.number().optional(),
  maxPosition: z.number().optional(),
  maxCtr: z.number().optional(),
  /** GSC slice the analysis is scoped to. Undefined = cross-type (web-only default). */
  searchType: searchTypeSchema.optional(),
}).superRefine((value, ctx) => {
  if ((value.preset === 'brand-only' || value.preset === 'non-brand') && !value.brandTerms?.trim()) {
    ctx.addIssue({
      code: 'custom',
      path: ['brandTerms'],
      message: 'brandTerms is required for brand/non-brand presets',
    })
  }
})

export const gscdumpAnalysisResponseSchema = z.object({
  preset: gscdumpAnalysisPresetSchema,
  keywords: z.array(unknownRecord),
  totalCount: z.number(),
  summary: unknownRecord.optional(),
  meta: gscdumpMetaSchema,
}).loose()

export const gscdumpSitemapsResponseSchema = z.object({
  sitemaps: z.array(unknownRecord),
  history: z.array(unknownRecord),
  perSitemapHistory: z.record(z.string(), z.array(unknownRecord)),
  meta: z.object({
    siteUrl: z.string(),
    syncStatus: z.string().nullable(),
  }).loose(),
}).loose()

export const gscdumpSitemapChangesResponseSchema = z.object({
  added: z.array(unknownRecord),
  removed: z.array(unknownRecord),
  summary: z.object({
    totalAdded: z.number(),
    totalRemoved: z.number(),
    period: z.object({ days: z.number() }),
  }).optional(),
}).loose()

export const indexingUrlsParamsSchema = z.object({
  limit: z.number().optional(),
  offset: z.number().optional(),
  status: z.enum(['indexed', 'not_indexed', 'pending']).optional(),
  issue: z.string().optional(),
  search: z.string().optional(),
}).optional()

export const gscdumpIndexingResponseSchema = z.object({
  trend: z.array(z.object({
    date: z.string(),
    totalUrls: z.number(),
    indexedCount: z.number().nullable(),
    notIndexedCount: z.number().nullable(),
    errorCount: z.number().nullable(),
    indexedPercent: z.number(),
    issues: z.object({
      blockedByRobots: z.number().nullable(),
      noindexDetected: z.number().nullable(),
      soft404: z.number().nullable(),
      redirect: z.number().nullable(),
      notFound: z.number().nullable(),
      serverError: z.number().nullable(),
    }).loose(),
    coverage: z.object({
      submittedIndexed: z.number().nullable(),
      crawledNotIndexed: z.number().nullable(),
      discoveredNotCrawled: z.number().nullable(),
    }).loose(),
    signals: z.object({
      mobilePass: z.number(),
      mobileFail: z.number(),
      richResultsPass: z.number(),
      richResultsFail: z.number(),
    }).loose(),
  }).loose()),
  summary: z.object({
    totalUrls: z.number(),
    indexed: z.number(),
    notIndexed: z.number(),
    pending: z.number(),
    indexedPercent: z.number(),
    oldestCheck: z.string().nullable(),
    newestCheck: z.string().nullable(),
    change7d: z.number().nullable(),
    change28d: z.number().nullable(),
    signals: z.object({
      mobilePass: z.number(),
      mobileFail: z.number(),
      mobileUnspecified: z.number(),
      richResultsPass: z.number(),
      richResultsFail: z.number(),
      richResultTypes: z.array(z.object({ type: z.string(), count: z.number() }).loose()),
      crawlingMobile: z.number(),
      crawlingDesktop: z.number(),
    }).loose(),
  }).loose(),
  meta: z.object({
    siteUrl: z.string(),
    syncStatus: z.string().nullable(),
    indexingStatus: z.enum(['pending', 'partial', 'complete']),
    indexingProgress: z.number(),
    sitemapTotal: z.number(),
    inspectedCount: z.number(),
    noSitemapsSubmitted: z.boolean(),
    sitemapsPending: z.boolean(),
    rollupBuiltAt: z.number().optional(),
  }).loose(),
}).loose()

export const gscdumpIndexingUrlsResponseSchema = z.object({
  urls: z.array(unknownRecord),
  pagination: z.object({
    total: z.number(),
    limit: z.number(),
    offset: z.number(),
    hasMore: z.boolean(),
  }),
  meta: z.object({
    siteUrl: z.string(),
    status: z.string(),
    issue: z.string().nullable(),
  }).loose(),
}).loose()

export const gscdumpIndexingDiagnosticsResponseSchema = z.object({
  summary: z.object({
    totalUrls: z.number(),
    indexed: z.number(),
    indexedPercent: z.number(),
  }).loose(),
  issues: z.array(unknownRecord),
  meta: z.object({ siteUrl: z.string() }).loose(),
}).loose()

export const gscdumpUserSettingsSchema = z.object({
  browserAnalyzerEnabled: z.boolean(),
}).loose()

export const gscdumpPermissionRecoverySchema = z.object({
  success: z.boolean(),
  permissionLevel: z.string().nullable(),
  jobsQueued: z.number(),
  message: z.string(),
}).loose()

export const gscdumpUserMeResponseSchema = z.object({
  id: z.string(),
  name: z.string().optional(),
  email: z.string(),
  picture: z.string().optional(),
  setupComplete: z.boolean(),
  databaseReady: z.boolean(),
  plan: z.string(),
  accountStatus: z.enum(accountStatuses),
  accountNextAction: z.enum(accountNextActions),
  missingScopes: z.array(z.string()),
  browserAnalyzerEnabled: z.boolean(),
  stats: z.object({
    activeSessions: z.number(),
    totalApiCalls: z.number(),
    lastUsed: z.number().nullable(),
  }).nullable(),
}).loose()

export const gscdumpHealthResponseSchema = z.object({
  timestamp: z.number(),
  jobs: z.object({
    byStatus: z.record(z.string(), z.number()),
    byQueue: z.record(z.string(), z.number()),
    stuck: z.number(),
    oldCompleted: z.number(),
  }).loose(),
  failures: z.object({ lastHour: z.number() }).loose(),
  users: z.object({ needsReauth: z.number() }).loose(),
  throughput: z.object({ completedLastHour: z.number() }).loose(),
  totals: z.object({
    users: z.number(),
    sites: z.number(),
    byPlan: z.record(z.string(), z.number()),
  }).loose(),
}).loose()

const syncProgressPhaseCountsSchema = z.object({
  total: z.number(),
  done: z.number(),
  pending: z.number(),
  stuck: z.number(),
  failed: z.number(),
  percent: z.number(),
  rows: z.number(),
}).loose()

export const gscdumpSyncProgressResponseSchema = z.object({
  summary: z.object({
    total: z.number(),
    inInitial: z.number(),
    inBackfill: z.number(),
    complete: z.number(),
    stalled: z.number(),
    authBlocked: z.number(),
    totalRows: z.number(),
    avgInitialPercent: z.number(),
    avgBackfillPercent: z.number(),
  }).loose(),
  sites: z.array(z.object({
    id: z.string(),
    userId: z.number(),
    partnerId: z.number().nullable(),
    siteUrl: z.string(),
    syncStatus: z.string().nullable(),
    lastError: z.string().nullable(),
    createdAt: z.number(),
    oldestDateSynced: z.string().nullable(),
    newestDateSynced: z.string().nullable(),
    oldestDateAvailable: z.string().nullable(),
    userEmail: z.string().nullable(),
    partnerName: z.string().nullable(),
    needsReauth: z.boolean(),
    authFailureCount: z.number(),
    currentPhase: z.enum(['initial', 'backfill', 'complete']),
    isStalled: z.boolean(),
    stallDays: z.number(),
    needsContinuation: z.boolean(),
    missingDays: z.number(),
    initial: syncProgressPhaseCountsSchema,
    backfill: syncProgressPhaseCountsSchema.extend({
      processing: z.number(),
      daysTarget: z.number(),
      daysQueued: z.number(),
    }).loose(),
    tables: z.record(z.string(), z.object({ percent: z.number(), rows: z.number() }).loose()),
    overallPercent: z.number(),
    totalRows: z.number(),
    dateStatuses: z.array(z.object({
      date: z.string(),
      status: z.enum(['completed', 'queued', 'processing', 'failed']),
    }).loose()),
  }).loose()),
  pagination: z.object({ total: z.number(), limit: z.number(), offset: z.number(), hasMore: z.boolean() }).loose(),
  hasD1Stats: z.boolean(),
}).loose()

const syncJobsQueueCountsSchema = z.object({
  queued: z.number(),
  processing: z.number(),
}).loose()

export const gscdumpSyncJobsResponseSchema = z.object({
  jobs: z.array(z.object({
    id: z.number(),
    userSiteId: z.string().nullable(),
    tableName: z.string().optional(),
    tableTier: z.string().optional(),
    date: z.string().optional(),
    priority: z.string().optional(),
    status: z.enum(['queued', 'processing', 'completed', 'failed', 'scheduled']),
    siteUrl: z.string().nullable(),
    userEmail: z.string().nullable().optional(),
    rowsFetched: z.number().nullable(),
    rowsInserted: z.number().nullable(),
    error: z.string().nullable(),
    retryCount: z.number(),
    queuedAt: z.number(),
    startedAt: z.number().nullable(),
    completedAt: z.number().nullable(),
  }).loose()),
  summary: z.object({
    queued: z.number(),
    processing: z.number(),
    completed: z.number(),
    failed: z.number(),
  }).loose(),
  queues: z.record(z.string(), syncJobsQueueCountsSchema),
  tiers: z.object({
    critical: syncJobsQueueCountsSchema.optional(),
    standard: syncJobsQueueCountsSchema.optional(),
    extended: syncJobsQueueCountsSchema.optional(),
  }).loose().optional(),
}).loose()

export const gscdumpSiteReportResponseSchema = z.object({
  status: z.enum(['done', 'error']),
  cached: z.boolean(),
  result: z.unknown().optional(),
  error: z.string().optional(),
}).loose()

export const gscdumpTopAssociationParamsSchema = z.object({
  type: z.enum(['topPage', 'topKeyword']),
  identifier: z.string().min(1),
  startDate: z.string(),
  endDate: z.string(),
})

export const gscdumpTopAssociationResponseSchema = z.object({
  value: z.string().nullable(),
}).loose()

export const gscdumpAnalysisSourcesResponseSchema = z.object({
  tables: z.record(z.string(), z.array(z.string())),
  generatedAt: z.string(),
  manifestVersion: z.string(),
}).loose()

export const gscdumpKeywordSparklinesParamsSchema = z.object({
  keywords: z.array(z.string()).min(1).max(20),
  startDate: z.string(),
  endDate: z.string(),
})

export const gscdumpKeywordSparklinesResponseSchema = z.object({
  sparklines: z.record(z.string(), z.array(z.number())),
}).loose()

export const gscdumpQueryTrendParamsSchema = z.object({
  startDate: z.string(),
  endDate: z.string(),
  prevStartDate: z.string().optional(),
  prevEndDate: z.string().optional(),
})

export const gscdumpQueryTrendResponseSchema = z.object({
  daily: z.array(z.object({ date: z.string(), queryCount: z.number() }).loose()),
  total: z.number(),
  previousTotal: z.number().optional(),
  meta: z.object({ siteUrl: z.string(), syncStatus: z.string().nullable() }).loose(),
}).loose()

export const gscdumpDateRangeParamsSchema = z.object({
  startDate: z.string(),
  endDate: z.string(),
})

export const gscdumpIndexPercentParamsSchema = z.object({
  invisibleLimit: z.number().optional(),
  invisibleOffset: z.number().optional(),
  orphanLimit: z.number().optional(),
}).optional()

export const gscdumpCanonicalMismatchesResponseSchema = z.object({
  mismatches: z.array(z.object({
    url: z.string(),
    userCanonical: z.string(),
    googleCanonical: z.string(),
    verdict: z.string().nullable(),
    coverageState: z.string().nullable(),
    lastCrawlTime: z.string().nullable(),
    lastCheckedAt: z.string().nullable(),
  }).loose()),
  totalCount: z.number(),
  consolidationTargets: z.array(z.object({
    google_canonical: z.string(),
    count: z.number(),
  }).loose()),
  trend: z.array(z.object({
    date: z.string(),
    count: z.number(),
  }).loose()),
  meta: z.object({
    siteUrl: z.string(),
    syncStatus: z.string().nullable(),
  }).loose(),
}).loose()

export const gscdumpIndexPercentResponseSchema = z.object({
  trend: z.array(z.object({
    date: z.string(),
    percent: z.number(),
    total: z.number(),
    visible: z.number(),
    added: z.number().nullable(),
    removed: z.number().nullable(),
  }).loose()),
  invisibleUrls: z.array(z.object({
    url: z.string(),
    firstSeen: z.string().optional(),
    lastmod: z.string().nullable(),
  }).loose()),
  invisibleCount: z.number(),
  orphanPages: z.array(z.object({
    url: z.string(),
    impressions: z.number().nullable(),
    clicks: z.number().nullable(),
  }).loose()),
  orphanCount: z.number(),
  sitemaps: z.array(z.object({
    path: z.string(),
    urlCount: z.number(),
    isIndex: z.boolean(),
  }).loose()),
  summary: z.object({
    currentPercent: z.number(),
    totalSitemapUrls: z.number(),
    visibleUrls: z.number(),
    change7d: z.number().nullable(),
    change28d: z.number().nullable(),
    dataDate: z.string(),
  }).loose(),
  meta: z.object({
    siteUrl: z.string(),
    syncStatus: z.string().nullable(),
    newestDateSynced: z.string().nullable(),
  }).loose(),
}).loose()

export const gscdumpDeletePartnerUserResponseSchema = z.object({
  ok: z.literal(true),
  queued: z.literal(true),
  userId: z.number(),
  publicId: z.string(),
}).loose()

export const gscdumpTeamRoleSchema = z.enum(['admin', 'editor', 'viewer'])

export const gscdumpTeamRowSchema = z.object({
  id: z.string(),
  ownerId: z.number(),
  name: z.string(),
  personalTeam: z.boolean(),
  createdAt: z.number(),
  updatedAt: z.number(),
}).loose()

export const gscdumpTeamMemberRowSchema = z.object({
  userId: z.number(),
  publicId: z.string(),
  name: z.string().nullable(),
  email: z.email(),
  picture: z.string().nullable(),
  role: gscdumpTeamRoleSchema,
  joinedAt: z.number(),
}).loose()

export const createPartnerTeamSchema = z.object({
  ownerUserId: z.string(),
  name: z.string().min(2).max(60),
  personalTeam: z.boolean().optional(),
})

export const addPartnerTeamMemberSchema = z.object({
  userId: z.string(),
  role: gscdumpTeamRoleSchema,
})

export const bindPartnerSiteTeamSchema = z.object({
  teamId: z.string().nullable(),
})

export const partnerRealtimeEventSchema = z.discriminatedUnion('event', [
  z.object({ event: z.literal('sync.progress'), siteId: z.string(), siteUrl: z.string(), table: z.string(), date: z.string(), progress: z.number() }).loose(),
  z.object({ event: z.literal('sync.complete'), userId: z.number(), siteId: z.string(), siteUrl: z.string(), table: z.string(), date: z.string(), rowsFetched: z.number(), rowsInserted: z.number(), timestamp: z.number() }).loose(),
  z.object({ event: z.literal('sync.job_complete'), userId: z.number(), siteId: z.string(), siteUrl: z.string(), table: z.string(), date: z.string(), rowsFetched: z.number(), rowsInserted: z.number(), syncStatus: z.string(), timestamp: z.number() }).loose(),
  z.object({ event: z.literal('sync.site_complete'), userId: z.number(), siteId: z.string(), siteUrl: z.string(), syncStatus: z.string(), timestamp: z.number() }).loose(),
  z.object({ event: z.literal('sync.failed'), userId: z.number(), siteId: z.string(), siteUrl: z.string(), table: z.string(), date: z.string(), error: z.string(), timestamp: z.number() }).loose(),
  z.object({ event: z.literal('job.failed'), siteId: z.string(), siteUrl: z.string(), table: z.string(), date: z.string(), error: z.string(), timestamp: z.number() }).loose(),
  z.object({ event: z.literal('site.added'), userId: z.number(), siteId: z.string(), siteUrl: z.string() }).loose(),
  z.object({ event: z.literal('site.removed'), userId: z.number(), siteId: z.string(), siteUrl: z.string() }).loose(),
  z.object({ event: z.literal('auth.failed'), userId: z.number(), siteId: z.string(), siteUrl: z.string(), error: z.string(), timestamp: z.number() }).loose(),
  z.object({ event: z.literal('auth.needs_reauth'), userId: z.number(), failureCount: z.number(), timestamp: z.number() }).loose(),
  z.object({ event: z.literal('enrichment.complete'), siteId: z.string(), userId: z.number(), timestamp: z.number() }).loose(),
])

export const canonicalWebhookEventTypeSchema = z.enum(CANONICAL_WEBHOOK_EVENTS)
export const webhookEventTypeSchema = canonicalWebhookEventTypeSchema

export const jobFailedWebhookPayloadSchema = z.object({
  event: z.literal('job.failed'),
  siteId: z.string(),
  siteUrl: z.string(),
  table: z.string(),
  date: z.string(),
  error: z.string(),
  timestamp: z.number(),
}).loose()

export const partnerWebhookDataSchema = unknownRecord

export const partnerWebhookEnvelopeSchema = z.object({
  contractVersion: z.literal(WEBHOOK_CONTRACT_VERSION),
  deliveryId: z.string().min(1),
  event: canonicalWebhookEventTypeSchema,
  partnerId: z.string().min(1),
  userId: z.string().nullable(),
  siteId: z.string().optional(),
  externalUserId: z.string().nullable().optional(),
  externalSiteId: z.string().nullable().optional(),
  lifecycleRevision: z.number().int(),
  occurredAt: z.iso.datetime(),
  data: partnerWebhookDataSchema,
}).loose()

export const partnerEndpointSchemas = {
  appUser: { response: gscdumpUserMeResponseSchema },
  appHealth: { response: gscdumpHealthResponseSchema },
  appSyncProgress: { response: gscdumpSyncProgressResponseSchema },
  appSyncJobs: { response: gscdumpSyncJobsResponseSchema },
  analyticsWhoami: { response: whoamiResponseSchema },
  analyticsSites: { response: z.array(siteListItemSchema) },
  analyticsCountries: { response: countriesResponseSchema },
  analyticsSearchAppearance: { response: searchAppearanceResponseSchema },
  analyticsSitemapHistory: { response: sitemapHistoryResponseSchema },
  analyticsSitemaps: { response: sitemapIndexSchema },
  analyticsInspectionHistory: { response: inspectionHistoryResponseSchema },
  analyticsInspections: { response: inspectionIndexSchema },
  analyticsRows: { response: gscRowQueryResponseSchema },
  analyticsRollup: { response: rollupEnvelopeSchema },
  analyticsBackfill: { body: backfillRangeSchema, response: backfillResponseSchema },
  analyticsIndexingUrls: { response: indexingUrlsResponseSchema },
  analyticsIndexingDiagnostics: { response: indexingDiagnosticsSchema },
  analyticsIndexingInspect: { body: indexingInspectRequestSchema, response: indexingInspectAnyResponseSchema },
  analyticsSitemapChanges: { response: sitemapChangesResponseSchema },
  analyticsAnalysisSources: { response: gscdumpAnalysisSourcesResponseSchema },
  analyticsSourceInfo: { response: sourceInfoResponseSchema },
  registerUser: { body: registerPartnerUserSchema, response: gscdumpUserRegistrationSchema },
  updateUserTokens: { body: updatePartnerUserTokensSchema, response: z.object({ userId: z.string(), updated: z.boolean(), sites: z.array(gscdumpAvailableSiteSchema) }).loose() },
  getUserStatus: { response: gscdumpUserStatusSchema },
  getUserLifecycle: { response: partnerLifecycleResponseSchema },
  getUserSites: { response: z.object({ sites: z.array(gscdumpUserSiteSchema) }).loose() },
  getAvailableSites: { response: z.object({ sites: z.array(gscdumpAvailableSiteSchema) }).loose() },
  registerSite: { body: registerPartnerSiteSchema, response: gscdumpSiteRegistrationSchema },
  bulkRegisterSites: { body: bulkRegisterPartnerSitesSchema, response: bulkRegisterPartnerSitesResponseSchema },
  deleteUser: { response: gscdumpDeletePartnerUserResponseSchema },
  getAnalysisSources: { response: gscdumpAnalysisSourcesResponseSchema },
  getData: { state: builderStateSchema, options: dataQueryOptionsSchema, response: gscdumpDataResponseSchema },
  getDataDetail: { state: builderStateSchema, options: dataDetailOptionsSchema, response: gscdumpDataDetailResponseSchema },
  getAnalysis: { query: gscdumpAnalysisParamsSchema, response: gscdumpAnalysisResponseSchema },
  getSitemaps: { response: gscdumpSitemapsResponseSchema },
  getSitemapChanges: { response: gscdumpSitemapChangesResponseSchema },
  getIndexing: { response: gscdumpIndexingResponseSchema },
  getIndexingUrls: { query: indexingUrlsParamsSchema, response: gscdumpIndexingUrlsResponseSchema },
  getIndexingDiagnostics: { response: gscdumpIndexingDiagnosticsResponseSchema },
  getIndexingInspect: { body: indexingInspectRequestSchema, response: indexingInspectAnyResponseSchema },
  getUserSettings: { response: gscdumpUserSettingsSchema },
  patchUserSettings: { body: gscdumpUserSettingsSchema.partial(), response: gscdumpUserSettingsSchema },
  recoverPermission: { response: gscdumpPermissionRecoverySchema },
  getTopAssociation: { query: gscdumpTopAssociationParamsSchema, response: gscdumpTopAssociationResponseSchema },
  getKeywordSparklines: { body: gscdumpKeywordSparklinesParamsSchema, response: gscdumpKeywordSparklinesResponseSchema },
  getQueryTrend: { query: gscdumpQueryTrendParamsSchema, response: gscdumpQueryTrendResponseSchema },
  getDateRangeInsight: { query: gscdumpDateRangeParamsSchema, response: unknownRecord },
  getCanonicalMismatches: { response: gscdumpCanonicalMismatchesResponseSchema },
  getIndexPercent: { query: gscdumpIndexPercentParamsSchema, response: gscdumpIndexPercentResponseSchema },
  getSiteReport: { response: gscdumpSiteReportResponseSchema },
  createTeam: { body: createPartnerTeamSchema, response: z.object({ team: gscdumpTeamRowSchema }).loose() },
  listTeamMembers: { response: z.object({ members: z.array(gscdumpTeamMemberRowSchema) }).loose() },
  addTeamMember: { body: addPartnerTeamMemberSchema, response: unknownRecord },
  bindSiteToTeam: { body: bindPartnerSiteTeamSchema, response: z.object({ ok: z.literal(true), teamId: z.string().nullable() }).loose() },
  realtimeEvent: { message: partnerRealtimeEventSchema },
  webhook: { message: partnerWebhookEnvelopeSchema },
} as const

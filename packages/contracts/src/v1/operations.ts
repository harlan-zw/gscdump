import type { HttpV1ErrorCode, HttpV1ProtocolOperation } from './http-core'
import type { RealtimeV1Schemas } from './realtime'
import { z } from 'zod'
import {
  addPartnerTeamMemberSchema,
  bindPartnerSiteTeamSchema,
  bindPartnerTeamCatalogResponseSchema,
  bindPartnerTeamCatalogSchema,
  builderStateSchema,
  createPartnerTeamSchema,
  gscComparisonFilterSchema,
  gscdumpAnalysisBundleResponseSchema,
  gscdumpAnalysisPresetSchema,
  gscdumpAnalysisResponseSchema,
  gscdumpAvailableSiteSchema,
  gscdumpCanonicalMismatchesResponseSchema,
  gscdumpDataDetailResponseSchema,
  gscdumpDataResponseSchema,
  gscdumpDeletePartnerUserResponseSchema,
  gscdumpIndexingDiagnosticsResponseSchema,
  gscdumpIndexingResponseSchema,
  gscdumpIndexingTransitionFieldSchema,
  gscdumpIndexPercentResponseSchema,
  gscdumpKeywordSparklinesResponseSchema,
  gscdumpPageTrendResponseSchema,
  gscdumpQueryTrendResponseSchema,
  gscdumpSitemapChangesResponseSchema,
  gscdumpSitemapExportQuerySchema,
  gscdumpSitemapExportResponseSchema,
  gscdumpSitemapMembershipParamsSchema,
  gscdumpSitemapMembershipResponseSchema,
  gscdumpSitemapsResponseSchema,
  gscdumpSitemapUrlsQuerySchema,
  gscdumpSitemapUrlsResponseSchema,
  gscdumpSiteRegistrationSchema,
  gscdumpTeamRoleSchema,
  gscdumpTopAssociationResponseSchema,
  gscdumpUserRegistrationSchema,
  indexingUrlsResponseSchema,
  partnerSitemapActionResponseSchema,
  partnerSitemapActionSchema,
  partnerSiteTeamBindingResponseSchema,
  partnerTeamCreatedResponseSchema,
  partnerTeamDeletedResponseSchema,
  partnerTeamMemberAddedResponseSchema,
  partnerTeamMemberRemovedResponseSchema,
  partnerTeamMemberRoleResponseSchema,
  partnerTeamMembersResponseSchema,
  partnerTeamRenamedResponseSchema,
  registerPartnerSiteSchema,
  registerPartnerUserSchema,
  renamePartnerTeamSchema,
  searchTypeSchema,
  siteIntIdCrosswalkResponseSchema,
  sitemapChangesTruncationReasonSchema,
  teamCatalogRefSchema,
  updatePartnerUserTokensSchema,
} from '../schemas'
import {
  createGscdumpV1BrowserSchemas,
  GSCDUMP_V1_ANALYTICS_DIMENSIONS,
} from './browser'
import {
  defineHttpOperation,
  defineHttpSurface,
  defineResponseObject,
  defineSuccessResponse,
  HTTP_V1_ERROR_CODES,
} from './http-core'
import {
  createRealtimeV1Schemas,
  GSCDUMP_REALTIME_ACK_POLICY,
  GSCDUMP_REALTIME_CLOSE_CODES,
  GSCDUMP_REALTIME_CONNECTION_POLICY,
  GSCDUMP_REALTIME_LIMITS,
  GSCDUMP_REALTIME_MAX_CONNECTION_SECONDS,
  GSCDUMP_REALTIME_PING,
  GSCDUMP_REALTIME_PONG,
  GSCDUMP_REALTIME_PROTOCOL_VERSION,
  GSCDUMP_REALTIME_REPLAY_POLICY,
  GSCDUMP_REALTIME_SUBPROTOCOL,
  GSCDUMP_REALTIME_TICKET_AUDIENCE,
  GSCDUMP_REALTIME_TICKET_ISSUER,
  GSCDUMP_REALTIME_TICKET_POLICY,
  GSCDUMP_REALTIME_TICKET_PREFIX,
  GSCDUMP_REALTIME_TICKET_TTL_SECONDS,
  REALTIME_V1_EVENT_SEMANTICS,
} from './realtime'
import { GSCDUMP_HTTP_V1_VERSION } from './version'

// The inferred enum tuple keeps each operation's error DTO closed to its own codes.
// eslint-disable-next-line ts/explicit-function-return-type
function errorEnvelopeSchemas<const TCodes extends readonly [HttpV1ErrorCode, ...HttpV1ErrorCode[]]>(
  codes: TCodes,
  publicRequestId: RealtimeV1Schemas['publicRequestId'],
) {
  const errorDetails = z.record(z.string(), z.json())
  const producer = z.strictObject({
    code: z.enum(codes),
    message: z.string().min(1),
    requestId: publicRequestId,
    retryable: z.boolean(),
    details: errorDetails,
  })
  const client = z.looseObject({
    code: z.enum(codes),
    message: z.string().min(1),
    requestId: publicRequestId,
    retryable: z.boolean(),
    details: errorDetails,
  })
  return defineResponseObject({ error: producer }, { error: client })
}

// The exact inferred return is the source for all exported schema-derived DTO types.
// eslint-disable-next-line ts/explicit-function-return-type
export function createGscdumpV1Protocol() {
  const realtimeSchemas = createRealtimeV1Schemas()
  const browserSchemas = createGscdumpV1BrowserSchemas(realtimeSchemas)
  const surfaceSchema = z.enum(['partner', 'analytics', 'realtime'])
  const responseMeta = defineResponseObject({
    requestId: realtimeSchemas.publicRequestId,
    surface: surfaceSchema,
    version: z.literal(GSCDUMP_HTTP_V1_VERSION),
  })
  const partnerResponseMeta = defineResponseObject({
    requestId: realtimeSchemas.publicRequestId,
    surface: z.literal('partner'),
    version: z.literal(GSCDUMP_HTTP_V1_VERSION),
  })
  const realtimeResponseMeta = defineResponseObject({
    requestId: realtimeSchemas.publicRequestId,
    surface: z.literal('realtime'),
    version: z.literal(GSCDUMP_HTTP_V1_VERSION),
  })
  const requestMetadata = z.strictObject({
    requestId: realtimeSchemas.publicRequestId,
    surface: surfaceSchema,
    version: z.literal(GSCDUMP_HTTP_V1_VERSION),
  })
  const requestHeaders = z.strictObject({
    'x-request-id': realtimeSchemas.publicRequestId.optional(),
  })

  const errorEnvelope = errorEnvelopeSchemas(HTTP_V1_ERROR_CODES, realtimeSchemas.publicRequestId)

  const {
    analyticsRowsRequest,
    analyticsRowsResponse,
    keywordEnrichmentRequest,
    keywordEnrichmentResponse,
    lifecycleResponse,
  } = browserSchemas
  const dimensions = GSCDUMP_V1_ANALYTICS_DIMENSIONS
  const analyticsMeta = defineResponseObject({
    requestId: realtimeSchemas.publicRequestId,
    surface: z.literal('analytics'),
    version: z.literal(GSCDUMP_HTTP_V1_VERSION),
    sourceName: z.string().min(1),
    sourceKind: z.enum(['row', 'sql']),
    queryMs: z.number().nonnegative(),
  })

  // Reports preserve the richer hosted read model (totals, comparisons and
  // sync metadata) that cannot be reconstructed from the raw rows operation.
  // The request envelope is closed while BuilderState remains intentionally
  // extensible, matching the query package's versioned grammar.
  const analyticsReportState = builderStateSchema.extend({
    dimensions: z.array(z.enum(dimensions)).min(1),
  })
  const analyticsListReportState = analyticsReportState.refine(
    state => !state.dimensions.includes('date'),
    { message: 'List reports do not accept the date dimension.', path: ['dimensions'] },
  )
  const analyticsDetailReportState = analyticsReportState.refine(
    state => state.dimensions.includes('date'),
    { message: 'Detail reports require the date dimension.', path: ['dimensions'] },
  )
  const analyticsReportRequest = z.strictObject({
    state: analyticsListReportState,
    comparison: analyticsListReportState.optional(),
    filter: gscComparisonFilterSchema.optional(),
  })
  const analyticsReportDetailRequest = z.strictObject({
    state: analyticsDetailReportState,
    comparison: analyticsDetailReportState.optional(),
  })
  const analyticsReportData = defineResponseObject(gscdumpDataResponseSchema.shape)
  const analyticsReportDetailData = defineResponseObject(gscdumpDataDetailResponseSchema.shape)
  const analyticsReportResponse = defineSuccessResponse(analyticsReportData, analyticsMeta)
  const analyticsReportDetailResponse = defineSuccessResponse(analyticsReportDetailData, analyticsMeta)

  const integerQuery = (number: z.ZodNumber, wirePattern: RegExp): z.ZodType<number | string> => z.union([
    number,
    z.string().regex(wirePattern),
  ])
  const numericQuery = z.union([
    z.number(),
    z.string().regex(/^-?(?:\d+(?:\.\d+)?|\.\d+)$/),
  ])
  const calendarDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'expected YYYY-MM-DD')
  const indexingSummaryQuery = z.strictObject({
    days: integerQuery(z.number().int().min(1).max(90), /^(?:[1-9]|[1-8]\d|90)$/).optional(),
  })
  const indexingUrlsQuery = z.strictObject({
    limit: integerQuery(z.number().int().min(1).max(500), /^(?:[1-9]|[1-9]\d|[1-4]\d{2}|500)$/).optional(),
    offset: integerQuery(z.number().int().min(0), /^(?:0|[1-9]\d*)$/).optional(),
    status: z.enum(['indexed', 'not_indexed', 'pending']).optional(),
    issue: z.string().optional(),
    search: z.string().optional(),
    count: z.union([
      z.literal(0),
      z.literal(false),
      z.literal('0'),
      z.literal('false'),
    ]).optional(),
  })
  const indexingTransitionsQuery = z.strictObject({
    startDate: calendarDate.optional(),
    endDate: calendarDate.optional(),
    field: gscdumpIndexingTransitionFieldSchema.optional(),
    fromValue: z.string().min(1).max(2048).optional(),
    toValue: z.string().min(1).max(2048).optional(),
    limit: integerQuery(z.number().int().min(1).max(500), /^(?:[1-9]|[1-9]\d|[1-4]\d{2}|500)$/).optional(),
    offset: integerQuery(z.number().int().min(0), /^(?:0|[1-9]\d*)$/).optional(),
  }).superRefine((value, ctx) => {
    if ((value.startDate === undefined) !== (value.endDate === undefined)) {
      ctx.addIssue({
        code: 'custom',
        path: [value.startDate === undefined ? 'startDate' : 'endDate'],
        message: 'startDate and endDate must be supplied together',
      })
    }
    if (value.startDate && value.endDate && value.startDate > value.endDate)
      ctx.addIssue({ code: 'custom', path: ['endDate'], message: 'endDate must not precede startDate' })
  })
  const indexingDiagnosticsQuery = z.strictObject({
    sampleIssues: z.union([z.string(), z.array(z.string())]).optional(),
    sampleLimit: integerQuery(z.number().int().min(1).max(25), /^(?:[1-9]|1\d|2[0-5])$/).optional(),
  })
  const sitemapChangesQuery = z.strictObject({
    days: integerQuery(z.number().int().min(1).max(90), /^(?:[1-9]|[1-8]\d|90)$/).optional(),
  })
  const analysisBaseQueryShape = {
    startDate: z.string().min(1),
    endDate: z.string().min(1),
    prevStartDate: z.string().min(1).optional(),
    prevEndDate: z.string().min(1).optional(),
    brandTerms: z.string().optional(),
    limit: integerQuery(z.number().int().min(1).max(1000), /^(?:[1-9]|[1-9]\d|[1-9]\d{2}|1000)$/).optional(),
    offset: integerQuery(z.number().int().min(0), /^(?:0|[1-9]\d*)$/).optional(),
    search: z.string().optional(),
    minImpressions: numericQuery.optional(),
    minPosition: numericQuery.optional(),
    maxPosition: numericQuery.optional(),
    maxCtr: numericQuery.optional(),
    searchType: searchTypeSchema.optional(),
  }
  const analysisQuery = z.strictObject({
    ...analysisBaseQueryShape,
    preset: gscdumpAnalysisPresetSchema,
  }).superRefine((value, ctx) => {
    if ((value.preset === 'brand-only' || value.preset === 'non-brand') && !value.brandTerms?.trim()) {
      ctx.addIssue({ code: 'custom', path: ['brandTerms'], message: 'brandTerms is required for brand/non-brand presets' })
    }
  })
  const analysisBundleQuery = z.strictObject({
    ...analysisBaseQueryShape,
    presets: z.union([
      z.array(gscdumpAnalysisPresetSchema).min(1).max(8),
      z.string().min(1),
    ]),
  }).superRefine((value, ctx) => {
    const presets = typeof value.presets === 'string'
      ? value.presets.split(',').map(preset => preset.trim()).filter(Boolean)
      : value.presets
    if (presets.length < 1 || presets.length > 8 || presets.some(preset => !gscdumpAnalysisPresetSchema.safeParse(preset).success)) {
      ctx.addIssue({ code: 'custom', path: ['presets'], message: 'presets must contain 1 to 8 supported presets' })
    }
    if (presets.some(preset => preset === 'brand-only' || preset === 'non-brand') && !value.brandTerms?.trim()) {
      ctx.addIssue({ code: 'custom', path: ['brandTerms'], message: 'brandTerms is required for brand/non-brand presets' })
    }
    if (presets.some(preset => preset === 'movers-rising' || preset === 'movers-declining' || preset === 'decay')
      && (!value.prevStartDate || !value.prevEndDate)) {
      ctx.addIssue({ code: 'custom', path: ['prevStartDate'], message: 'Comparison presets require both previous-period dates' })
    }
  })
  const availableSitesQuery = z.strictObject({
    refresh: z.union([
      z.literal(true),
      z.literal(1),
      z.literal('true'),
      z.literal('1'),
    ]).optional(),
  })
  const registerSiteRequest = registerPartnerSiteSchema.omit({ userId: true, teamId: true }).strict()
  const indexingSummaryResponse = defineSuccessResponse(defineResponseObject(gscdumpIndexingResponseSchema.shape), partnerResponseMeta)
  const indexingUrlsResponse = defineSuccessResponse(defineResponseObject(indexingUrlsResponseSchema.shape), partnerResponseMeta)
  const indexingTransition = defineResponseObject({
    url: z.string(),
    field: gscdumpIndexingTransitionFieldSchema,
    fromValue: z.string().nullable(),
    toValue: z.string().nullable(),
    changedAfter: z.string(),
    changedBefore: z.string(),
    detectedAt: z.string(),
    observationGapDays: z.number().nonnegative(),
  })
  const emptyObservationWindow = defineResponseObject({
    _tag: z.literal('empty'),
    gapDaysMedian: z.null(),
    gapDaysP90: z.null(),
    sampleSize: z.literal(0),
  })
  const sampledObservationWindow = defineResponseObject({
    _tag: z.literal('sampled'),
    gapDaysMedian: z.number().nonnegative(),
    gapDaysP90: z.number().nonnegative(),
    sampleSize: z.number().int().positive(),
  })
  const indexingTransitionsPagination = defineResponseObject({
    total: z.number().int().nonnegative(),
    limit: z.number().int().positive(),
    offset: z.number().int().nonnegative(),
    hasMore: z.boolean(),
  })
  const indexingTransitionsMeta = defineResponseObject({
    siteUrl: z.string(),
    startDate: calendarDate,
    endDate: calendarDate,
  })
  const indexingTransitionsResponse = defineSuccessResponse(defineResponseObject({
    transitions: z.array(indexingTransition.producer),
    observationWindow: z.discriminatedUnion('_tag', [
      emptyObservationWindow.producer,
      sampledObservationWindow.producer,
    ]),
    pagination: indexingTransitionsPagination.producer,
    meta: indexingTransitionsMeta.producer,
  }, {
    transitions: z.array(indexingTransition.client),
    observationWindow: z.discriminatedUnion('_tag', [
      emptyObservationWindow.client,
      sampledObservationWindow.client,
    ]),
    pagination: indexingTransitionsPagination.client,
    meta: indexingTransitionsMeta.client,
  }), partnerResponseMeta)
  const indexingDiagnosticsResponse = defineSuccessResponse(defineResponseObject(gscdumpIndexingDiagnosticsResponseSchema.shape), partnerResponseMeta)
  const sitemapsResponse = defineSuccessResponse(defineResponseObject(gscdumpSitemapsResponseSchema.shape), partnerResponseMeta)
  const completeSitemapChangesShape = {
    _tag: z.literal('complete'),
    scannedUrls: z.number().int().nonnegative(),
  }
  const truncatedSitemapChangesShape = {
    _tag: z.literal('truncated'),
    scannedUrls: z.number().int().nonnegative(),
    reasons: z.array(sitemapChangesTruncationReasonSchema).min(1),
    historyAvailableFrom: z.number().int().nonnegative().optional(),
    limits: z.strictObject({
      scannedUrls: z.number().int().positive(),
      added: z.number().int().positive(),
      removed: z.number().int().positive(),
      updated: z.number().int().positive(),
    }),
  }
  const sitemapChangesResponse = defineSuccessResponse(defineResponseObject({
    ...gscdumpSitemapChangesResponseSchema.shape,
    summary: gscdumpSitemapChangesResponseSchema.shape.summary.unwrap(),
    completeness: z.discriminatedUnion('_tag', [
      z.strictObject(completeSitemapChangesShape),
      z.strictObject(truncatedSitemapChangesShape),
    ]),
  }, {
    ...gscdumpSitemapChangesResponseSchema.shape,
    summary: gscdumpSitemapChangesResponseSchema.shape.summary.unwrap(),
    completeness: z.discriminatedUnion('_tag', [
      z.looseObject(completeSitemapChangesShape),
      z.looseObject({
        ...truncatedSitemapChangesShape,
        limits: z.looseObject(truncatedSitemapChangesShape.limits.shape),
      }),
    ]),
  }), partnerResponseMeta)
  const analysisResponse = defineSuccessResponse(defineResponseObject(gscdumpAnalysisResponseSchema.shape), partnerResponseMeta)
  const analysisBundleResponse = defineSuccessResponse(defineResponseObject(gscdumpAnalysisBundleResponseSchema.shape), partnerResponseMeta)
  const availableSitesResponse = defineSuccessResponse(defineResponseObject({ sites: z.array(gscdumpAvailableSiteSchema) }), partnerResponseMeta)
  const siteRegistrationResponse = defineSuccessResponse(defineResponseObject(gscdumpSiteRegistrationSchema.shape), partnerResponseMeta)
  const siteDeletionResponse = defineSuccessResponse(defineResponseObject({
    deleted: z.literal(true),
    siteId: realtimeSchemas.publicSiteId,
    siteUrl: z.string().min(1),
  }), partnerResponseMeta)
  const userRegistrationResponse = defineSuccessResponse(defineResponseObject(gscdumpUserRegistrationSchema.shape), partnerResponseMeta)
  const userTokenUpdateResponse = defineSuccessResponse(defineResponseObject({
    userId: realtimeSchemas.publicUserId,
    updated: z.boolean(),
    sites: z.array(gscdumpAvailableSiteSchema),
  }), partnerResponseMeta)

  // ── 1.1.0 promotions (2026-07-22 full train, tranche A) ────────────────────
  // Response shapes wrap the SAME shared schemas the private handlers already
  // self-validate against, so promotion cannot drift from the serializers.
  const trendQuery = z.strictObject({
    startDate: calendarDate,
    endDate: calendarDate,
    searchType: searchTypeSchema.optional(),
    prevStartDate: calendarDate.optional(),
    prevEndDate: calendarDate.optional(),
  })
  const keywordSparklinesRequest = z.strictObject({
    keywords: z.array(z.string().trim().min(1)).min(1).max(20),
    startDate: calendarDate,
    endDate: calendarDate,
    searchType: searchTypeSchema.optional(),
  })
  const indexingInspectRequest = z.strictObject({
    urls: z.array(z.string().url()).min(1).max(10),
  })
  const canonicalMismatchesResponse = defineSuccessResponse(defineResponseObject(gscdumpCanonicalMismatchesResponseSchema.shape), partnerResponseMeta)
  const keywordSparklinesResponse = defineSuccessResponse(defineResponseObject(gscdumpKeywordSparklinesResponseSchema.shape), partnerResponseMeta)
  const queryTrendResponse = defineSuccessResponse(defineResponseObject(gscdumpQueryTrendResponseSchema.shape), partnerResponseMeta)
  const pageTrendResponse = defineSuccessResponse(defineResponseObject(gscdumpPageTrendResponseSchema.shape), partnerResponseMeta)
  const permissionRecoveryResponse = defineSuccessResponse(defineResponseObject({
    success: z.boolean(),
    permissionLevel: z.string().nullable(),
    jobsQueued: z.number().int().nonnegative(),
    message: z.string().min(1),
  }), partnerResponseMeta)
  // `ParsedIndexingResult` (gscdump/api/inspection.ts): url + nullable-string facts.
  const inspectionFact = z.string().nullable()
  const inspectionResult = z.object({
    url: z.string(),
    verdict: inspectionFact,
    coverageState: inspectionFact,
    indexingState: inspectionFact,
    robotsTxtState: inspectionFact,
    pageFetchState: inspectionFact,
    lastCrawlTime: inspectionFact,
    crawlingUserAgent: inspectionFact,
    userCanonical: inspectionFact,
    googleCanonical: inspectionFact,
    sitemaps: inspectionFact,
    referringUrls: inspectionFact,
    mobileVerdict: inspectionFact,
    mobileIssues: inspectionFact,
    richResultsVerdict: inspectionFact,
    richResultsItems: inspectionFact,
    ampVerdict: inspectionFact,
    ampUrl: inspectionFact,
    ampIndexingState: inspectionFact,
    ampIndexStatusVerdict: inspectionFact,
    ampRobotsTxtState: inspectionFact,
    ampPageFetchState: inspectionFact,
    ampLastCrawlTime: inspectionFact,
    ampIssues: inspectionFact,
    inspectionResultLink: inspectionFact,
  })
  const indexingInspectionResponse = defineSuccessResponse(defineResponseObject({
    siteId: realtimeSchemas.publicSiteId,
    rateLimit: z.strictObject({
      reserved: z.number().int().nonnegative(),
      remaining: z.number().int().nonnegative(),
      limit: z.number().int().positive(),
    }),
    results: z.array(inspectionResult),
    errors: z.array(z.strictObject({ url: z.string(), error: z.string() })),
    skipped: z.array(z.strictObject({ url: z.string(), reason: z.enum(['domain_mismatch', 'rate_limited']) })),
  }), partnerResponseMeta)

  // ── 1.2.0 promotions (2026-07-22 full train, tranche B: analysis endpoints) ──
  // Shapes authored from the private handlers' return statements (the routes'
  // own zod schemas where they exist: top-association, index-percent).
  const dateRangeQuery = z.strictObject({
    startDate: calendarDate,
    endDate: calendarDate,
  })
  const siteDataMeta = z.object({
    siteUrl: z.string().nullable(),
    syncStatus: z.string().nullable(),
  })
  const contentVelocityResponse = defineSuccessResponse(defineResponseObject({
    weekly: z.array(z.strictObject({
      week: z.string(),
      newKeywords: z.number().int().nonnegative(),
      totalKeywords: z.number().int().nonnegative(),
    })),
    summary: z.strictObject({
      totalNewKeywords: z.number().int().nonnegative(),
      avgPerWeek: z.number().nonnegative(),
      trend: z.enum(['stable', 'accelerating', 'decelerating']),
    }),
    meta: siteDataMeta,
  }), partnerResponseMeta)
  const ctrOutlier = z.strictObject({
    query: z.string(),
    clicks: z.number(),
    impressions: z.number(),
    ctr: z.number(),
    position: z.number(),
    expectedCtr: z.number(),
    ctrDiff: z.number(),
  })
  const ctrCurveResponse = defineSuccessResponse(defineResponseObject({
    curve: z.array(z.strictObject({
      bucket: z.string(),
      avgCtr: z.number(),
      medianPosition: z.number(),
      keywordCount: z.number(),
      totalClicks: z.number(),
      totalImpressions: z.number(),
    })),
    overperforming: z.array(ctrOutlier),
    underperforming: z.array(ctrOutlier),
    meta: siteDataMeta,
  }), partnerResponseMeta)
  const darkTrafficResponse = defineSuccessResponse(defineResponseObject({
    summary: z.strictObject({
      totalClicks: z.number(),
      attributedClicks: z.number(),
      darkClicks: z.number(),
      darkPercent: z.number(),
      totalImpressions: z.number(),
      attributedImpressions: z.number(),
    }),
    pages: z.array(z.strictObject({
      url: z.string(),
      totalClicks: z.number(),
      attributedClicks: z.number(),
      darkClicks: z.number(),
      darkPercent: z.number(),
      keywordCount: z.number(),
    })),
    meta: siteDataMeta,
  }), partnerResponseMeta)
  const deviceGapMetrics = z.strictObject({
    clicks: z.number(),
    impressions: z.number(),
    ctr: z.number(),
    position: z.number(),
  })
  const deviceGapResponse = defineSuccessResponse(defineResponseObject({
    daily: z.array(z.strictObject({
      date: z.string(),
      desktop: deviceGapMetrics,
      mobile: deviceGapMetrics,
      gaps: z.strictObject({ ctrGap: z.number(), positionGap: z.number() }),
    })),
    summary: z.strictObject({
      avgCtrGap: z.number(),
      avgPositionGap: z.number(),
      ctrGapTrend: z.enum(['stable', 'improving', 'worsening']),
      positionGapTrend: z.enum(['stable', 'improving', 'worsening']),
    }).nullable(),
    meta: siteDataMeta,
  }), partnerResponseMeta)
  const keywordBreadthPage = z.strictObject({
    url: z.string(),
    keywordCount: z.number(),
    clicks: z.number(),
    impressions: z.number(),
  })
  const keywordBreadthResponse = defineSuccessResponse(defineResponseObject({
    distribution: z.array(z.strictObject({ bucket: z.string(), pageCount: z.number() })),
    fragilePages: z.array(keywordBreadthPage),
    authorityPages: z.array(keywordBreadthPage),
    summary: z.strictObject({
      totalPages: z.number(),
      avgKeywordsPerPage: z.number(),
      fragileCount: z.number(),
      authorityCount: z.number(),
    }),
    meta: siteDataMeta,
  }), partnerResponseMeta)
  const positionDistributionResponse = defineSuccessResponse(defineResponseObject({
    distribution: z.array(z.strictObject({
      date: z.string(),
      pos_1_3: z.number(),
      pos_4_10: z.number(),
      pos_11_20: z.number(),
      pos_20_plus: z.number(),
      total: z.number(),
    })),
    meta: siteDataMeta,
  }), partnerResponseMeta)
  const topAssociationQuery = z.strictObject({
    type: z.enum(['topPage', 'topKeyword']),
    identifier: z.string().min(1),
    startDate: calendarDate,
    endDate: calendarDate,
  })
  const topAssociationResponse = defineSuccessResponse(defineResponseObject(gscdumpTopAssociationResponseSchema.shape), partnerResponseMeta)
  const indexPercentQuery = z.strictObject({
    invisibleLimit: z.coerce.number().int().min(1).max(500).optional(),
    invisibleOffset: z.coerce.number().int().min(0).max(1_000_000).optional(),
    orphanLimit: z.coerce.number().int().min(1).max(500).optional(),
  })
  const indexPercentResponse = defineSuccessResponse(defineResponseObject(gscdumpIndexPercentResponseSchema.shape), partnerResponseMeta)
  const contentVelocityQuery = z.strictObject({
    days: z.coerce.number().int().min(1).max(365).optional(),
  })

  // ── 1.3.0 promotions (2026-07-22 full train, tranches C+D) ──────────────────
  // Tranche C (sitemap actions + membership) reuses the wire schemas the
  // private handlers already self-validate against. Tranche D (partner team +
  // user plumbing) does the same wherever a named schema exists; the
  // verification-token/add-and-verify/cross-source/keyword-enrich shapes have
  // no schemas.ts counterpart so they're authored fresh here, matching the
  // decided FINAL spec exactly.
  const sitemapActionRequest = partnerSitemapActionSchema
  const sitemapActionResponse = defineSuccessResponse(
    { producer: partnerSitemapActionResponseSchema, client: partnerSitemapActionResponseSchema },
    partnerResponseMeta,
  )
  const sitemapMembershipRequest = gscdumpSitemapMembershipParamsSchema.strict()
  const sitemapMembershipResponse = defineSuccessResponse(defineResponseObject(gscdumpSitemapMembershipResponseSchema.shape), partnerResponseMeta)
  const sitemapUrlsQuery = gscdumpSitemapUrlsQuerySchema
  const sitemapUrlsResponse = defineSuccessResponse(
    { producer: gscdumpSitemapUrlsResponseSchema, client: gscdumpSitemapUrlsResponseSchema },
    partnerResponseMeta,
  )
  const sitemapExportQuery = gscdumpSitemapExportQuerySchema
  const sitemapExportResponse = defineSuccessResponse(
    { producer: gscdumpSitemapExportResponseSchema, client: gscdumpSitemapExportResponseSchema },
    partnerResponseMeta,
  )

  const createTeamRequest = createPartnerTeamSchema.strict()
  const teamCreatedResponse = defineSuccessResponse(defineResponseObject(partnerTeamCreatedResponseSchema.shape), partnerResponseMeta)
  const renameTeamRequest = renamePartnerTeamSchema.strict()
  const teamRenamedResponse = defineSuccessResponse(defineResponseObject(partnerTeamRenamedResponseSchema.shape), partnerResponseMeta)
  const teamDeletedResponse = defineSuccessResponse(defineResponseObject(partnerTeamDeletedResponseSchema.shape), partnerResponseMeta)
  const teamMembersResponse = defineSuccessResponse(defineResponseObject(partnerTeamMembersResponseSchema.shape), partnerResponseMeta)
  const addTeamMemberRequest = addPartnerTeamMemberSchema.strict()
  const teamMemberAddedResponse = defineSuccessResponse(defineResponseObject(partnerTeamMemberAddedResponseSchema.shape), partnerResponseMeta)
  const updateTeamMemberRoleRequest = z.strictObject({ role: gscdumpTeamRoleSchema })
  const teamMemberRoleResponse = defineSuccessResponse(defineResponseObject(partnerTeamMemberRoleResponseSchema.shape), partnerResponseMeta)
  const teamMemberRemovedResponse = defineSuccessResponse(defineResponseObject(partnerTeamMemberRemovedResponseSchema.shape), partnerResponseMeta)
  const bindSiteTeamRequest = bindPartnerSiteTeamSchema.strict()
  const siteTeamBindingResponse = defineSuccessResponse(defineResponseObject(partnerSiteTeamBindingResponseSchema.shape), partnerResponseMeta)
  const teamCatalogResponse = defineSuccessResponse(defineResponseObject(teamCatalogRefSchema.shape), partnerResponseMeta)
  const bindTeamCatalogRequest = bindPartnerTeamCatalogSchema.strict()
  const teamCatalogBindResponse = defineSuccessResponse(defineResponseObject(bindPartnerTeamCatalogResponseSchema.shape), partnerResponseMeta)
  const siteIntIdCrosswalkResponse = defineSuccessResponse(defineResponseObject(siteIntIdCrosswalkResponseSchema.shape), partnerResponseMeta)
  const deletePartnerUserResponse = defineSuccessResponse(defineResponseObject(gscdumpDeletePartnerUserResponseSchema.shape), partnerResponseMeta)

  // No schemas.ts equivalent yet — token minting/verification and the
  // cross-source/keyword-enrich shapes are authored fresh from the FINAL spec.
  const verificationMethodSchema = z.enum(['META', 'FILE', 'DNS_TXT', 'DNS_CNAME', 'ANALYTICS', 'TAG_MANAGER'])
  const verificationTokenRequest = z.strictObject({
    siteUrl: z.string().min(1),
    method: verificationMethodSchema.optional(),
  })
  const verificationSiteShape = z.object({ type: z.string(), identifier: z.string() }).loose()
  const verificationTokenResponse = defineSuccessResponse(defineResponseObject({
    siteUrl: z.string(),
    site: verificationSiteShape,
    method: z.string(),
    token: z.string(),
    metaContent: z.string().nullable(),
    dnsRecord: z.object({
      type: z.enum(['TXT', 'CNAME']),
      host: z.string(),
      value: z.string(),
    }).nullable(),
  }), partnerResponseMeta)
  const addAndVerifySiteRequest = verificationTokenRequest
  const addAndVerifySiteResponse = defineSuccessResponse(defineResponseObject({
    siteUrl: z.string(),
    site: verificationSiteShape,
    method: z.string(),
    verified: z.literal(true),
    owners: z.array(z.string()).optional(),
  }), partnerResponseMeta)

  const crossSourceQueryKeys = [
    'crawl-error-losing-impressions',
    'declining-clicks-poor-lcp',
    'striking-distance-slow-pages',
    'top-impressions-low-performance',
  ] as const
  const crossSourceRequest = z.strictObject({
    queryKey: z.enum(crossSourceQueryKeys),
    rangeDays: z.number().int().positive().max(180).optional(),
    limit: z.number().int().positive().max(500).optional(),
  })
  const crossSourceResponse = defineSuccessResponse(defineResponseObject({
    reason: z.string().optional(),
    sources: z.array(z.string()),
    rows: z.array(z.record(z.string(), z.json())),
  }), partnerResponseMeta)

  const responseStreamHead = defineResponseObject({
    streamId: realtimeSchemas.streamId,
    sequence: realtimeSchemas.sequence,
  })
  const headData = defineResponseObject(
    { head: responseStreamHead.producer },
    { head: responseStreamHead.client },
  )
  const headResponse = defineSuccessResponse(headData, realtimeResponseMeta)
  const ticketDataProducerShape = {
    socketUrl: z.url().refine(value => value.startsWith('wss://'), 'socketUrl must use wss.'),
    protocol: z.literal(GSCDUMP_REALTIME_SUBPROTOCOL),
    protocolVersion: z.literal(GSCDUMP_REALTIME_PROTOCOL_VERSION),
    ticket: z.string().max(GSCDUMP_REALTIME_TICKET_POLICY.maxBytes).regex(/^gscdump\.ticket\.v1\.[\w-]+\.[\w-]+$/),
    expiresAt: z.iso.datetime(),
    head: responseStreamHead.producer,
    maxConnectionSeconds: z.literal(GSCDUMP_REALTIME_MAX_CONNECTION_SECONDS),
  }
  const ticketResponse = {
    producer: z.strictObject({
      data: z.strictObject(ticketDataProducerShape),
      meta: realtimeResponseMeta.producer,
    }),
    client: realtimeSchemas.ticketResponseClient,
  }

  const partnerUserLifecycleErrors = [
    'invalid_request',
    'unauthorized',
    'forbidden',
    'user_not_found',
    'rate_limited',
    'internal_error',
    'contract_violation',
  ] as const
  const partnerSiteErrors = [
    'invalid_request',
    'unauthorized',
    'forbidden',
    'site_not_found',
    'rate_limited',
    'internal_error',
    'contract_violation',
  ] as const
  const partnerUserErrors = [
    'invalid_request',
    'unauthorized',
    'forbidden',
    'user_not_found',
    'rate_limited',
    'internal_error',
    'contract_violation',
  ] as const
  const analyticsRowsErrors = [
    'invalid_request',
    'unauthorized',
    'forbidden',
    'site_not_found',
    'rate_limited',
    'internal_error',
    'contract_violation',
  ] as const
  const realtimeErrors = [
    'invalid_request',
    'unauthorized',
    'forbidden',
    'rate_limited',
    'realtime_unavailable',
    'internal_error',
    'contract_violation',
  ] as const

  const partner = defineHttpSurface({
    name: 'partner',
    prefix: '/api/partner/v1',
    version: GSCDUMP_HTTP_V1_VERSION,
    operations: {
      getUserLifecycle: defineHttpOperation({
        id: 'partner.users.lifecycle.get',
        method: 'GET',
        path: '/users/{userId}/lifecycle',
        visibility: 'public',
        semantics: {
          kind: 'query',
          sideEffects: 'none',
          idempotent: true,
          retry: 'idempotent',
          readConsistency: 'primary',
        },
        auth: {
          credentials: ['user_key', 'partner_key'],
          scopes: ['users:read'],
          ownership: [
            { credential: 'user_key', rule: 'self' },
            { credential: 'partner_key', rule: 'linked_user' },
          ],
        },
        request: {
          params: z.strictObject({ userId: realtimeSchemas.publicUserId }),
          query: null,
          headers: requestHeaders,
          body: null,
        },
        responses: { 200: lifecycleResponse },
        errors: partnerUserLifecycleErrors,
        errorResponse: errorEnvelopeSchemas(
          partnerUserLifecycleErrors,
          realtimeSchemas.publicRequestId,
        ),
        resources: {
          reads: [
            { type: 'partner.user', idFrom: 'params.userId' },
            { type: 'user.sites', idFrom: 'params.userId' },
          ],
          changes: [],
        },
        lifecycle: { introduced: '1.0.0' },
        docs: {
          summary: 'Get user lifecycle',
          description: 'Returns the authoritative lifecycle state for one visible user and their sites.',
          tags: ['Users'],
          examples: {
            request: { params: { userId: 'u_01' } },
            response: {
              data: {
                userId: 'u_01',
                partnerId: 'p_01',
                currentTeamId: null,
                account: {
                  status: 'ready',
                  grantedScopes: ['https://www.googleapis.com/auth/webmasters.readonly'],
                  missingScopes: [],
                  nextAction: 'none',
                },
                sites: [],
              },
              meta: { requestId: 'req_01', surface: 'partner', version: '1.0' },
            },
          },
        },
      }),
      listAvailableSites: defineHttpOperation({
        id: 'partner.users.sites.available.list',
        method: 'GET',
        path: '/users/{userId}/available-sites',
        visibility: 'public',
        semantics: { kind: 'query', sideEffects: 'none', idempotent: true, retry: 'idempotent', readConsistency: 'primary' },
        auth: {
          credentials: ['user_key', 'partner_key'],
          scopes: ['sites:read'],
          ownership: [
            { credential: 'user_key', rule: 'self' },
            { credential: 'partner_key', rule: 'linked_user' },
          ],
        },
        request: {
          params: z.strictObject({ userId: realtimeSchemas.publicUserId }),
          query: availableSitesQuery,
          headers: requestHeaders,
          body: null,
        },
        responses: { 200: availableSitesResponse },
        errors: partnerUserErrors,
        errorResponse: errorEnvelopeSchemas(partnerUserErrors, realtimeSchemas.publicRequestId),
        resources: {
          reads: [
            { type: 'partner.user', idFrom: 'params.userId' },
            { type: 'user.sites', idFrom: 'params.userId' },
          ],
          changes: [],
        },
        lifecycle: { introduced: '1.0.0' },
        docs: {
          summary: 'List available Search Console properties',
          description: 'Lists the visible Google Search Console properties and their registration state.',
          tags: ['Sites'],
          examples: {
            request: { params: { userId: 'u_01' }, query: {} },
            response: { data: { sites: [] }, meta: { requestId: 'req_01', surface: 'partner', version: '1.0' } },
          },
        },
      }),
      createSite: defineHttpOperation({
        id: 'partner.users.sites.create',
        method: 'POST',
        path: '/users/{userId}/sites',
        visibility: 'public',
        semantics: { kind: 'mutation', sideEffects: 'state', idempotent: true, retry: 'idempotent', readConsistency: null },
        auth: {
          credentials: ['user_key', 'partner_key'],
          scopes: ['sites:write'],
          ownership: [
            { credential: 'user_key', rule: 'self' },
            { credential: 'partner_key', rule: 'linked_user' },
          ],
        },
        request: {
          params: z.strictObject({ userId: realtimeSchemas.publicUserId }),
          query: null,
          headers: requestHeaders,
          body: registerSiteRequest,
        },
        responses: { 200: siteRegistrationResponse },
        errors: partnerUserErrors,
        errorResponse: errorEnvelopeSchemas(partnerUserErrors, realtimeSchemas.publicRequestId),
        resources: {
          reads: [{ type: 'partner.user', idFrom: 'params.userId' }],
          changes: [{ type: 'site.registration', idFrom: 'params.userId' }],
        },
        lifecycle: { introduced: '1.0.0' },
        docs: {
          summary: 'Register a site',
          description: 'Registers one Search Console property for an authorized user.',
          tags: ['Sites'],
          examples: {
            request: { params: { userId: 'u_01' }, body: { siteUrl: 'sc-domain:example.com' } },
            response: { data: { siteId: 's_01', status: 'pending' }, meta: { requestId: 'req_01', surface: 'partner', version: '1.0' } },
          },
        },
      }),
      createUser: defineHttpOperation({
        id: 'partner.users.create',
        method: 'POST',
        path: '/users',
        visibility: 'public',
        semantics: { kind: 'mutation', sideEffects: 'state', idempotent: true, retry: 'idempotent', readConsistency: null },
        auth: {
          credentials: ['partner_key'],
          scopes: ['users:write'],
          ownership: [{ credential: 'partner_key', rule: 'partner_tenant' }],
        },
        request: { params: null, query: null, headers: requestHeaders, body: registerPartnerUserSchema.strict() },
        responses: { 200: userRegistrationResponse },
        errors: partnerUserErrors,
        errorResponse: errorEnvelopeSchemas(partnerUserErrors, realtimeSchemas.publicRequestId),
        resources: { reads: [], changes: [{ type: 'partner.user', idFrom: 'principal.id' }] },
        lifecycle: { introduced: '1.0.0' },
        docs: {
          summary: 'Register a partner user',
          description: 'Creates or updates a user owned by the authenticated partner tenant.',
          tags: ['Users'],
          examples: {
            request: { body: { userGoogleId: 'google_01', userEmail: 'owner@example.com', accessToken: 'token', refreshToken: 'refresh' } },
            response: { data: { userId: 'u_01', status: 'provisioning' }, meta: { requestId: 'req_01', surface: 'partner', version: '1.0' } },
          },
        },
      }),
      updateUserTokens: defineHttpOperation({
        id: 'partner.users.tokens.update',
        method: 'PATCH',
        path: '/users/{userId}/tokens',
        visibility: 'public',
        semantics: { kind: 'mutation', sideEffects: 'state', idempotent: true, retry: 'idempotent', readConsistency: null },
        auth: {
          credentials: ['partner_key'],
          scopes: ['users:write'],
          ownership: [{ credential: 'partner_key', rule: 'linked_user' }],
        },
        request: {
          params: z.strictObject({ userId: realtimeSchemas.publicUserId }),
          query: null,
          headers: requestHeaders,
          body: updatePartnerUserTokensSchema.strict(),
        },
        responses: { 200: userTokenUpdateResponse },
        errors: partnerUserErrors,
        errorResponse: errorEnvelopeSchemas(partnerUserErrors, realtimeSchemas.publicRequestId),
        resources: {
          reads: [{ type: 'partner.user', idFrom: 'params.userId' }],
          changes: [{ type: 'partner.user', idFrom: 'params.userId' }],
        },
        lifecycle: { introduced: '1.0.0' },
        docs: {
          summary: 'Update user OAuth tokens',
          description: 'Replaces the Google OAuth grant for a partner-linked user.',
          tags: ['Users'],
          examples: {
            request: { params: { userId: 'u_01' }, body: { accessToken: 'token', refreshToken: 'refresh' } },
            response: { data: { userId: 'u_01', updated: true, sites: [] }, meta: { requestId: 'req_01', surface: 'partner', version: '1.0' } },
          },
        },
      }),
      getSiteIndexing: defineHttpOperation({
        id: 'partner.sites.indexing.get',
        method: 'GET',
        path: '/sites/{siteId}/indexing',
        visibility: 'public',
        semantics: { kind: 'query', sideEffects: 'none', idempotent: true, retry: 'idempotent', readConsistency: 'primary' },
        auth: {
          credentials: ['user_key', 'partner_key'],
          scopes: ['indexing:read'],
          ownership: [
            { credential: 'user_key', rule: 'authorized_site' },
            { credential: 'partner_key', rule: 'authorized_site' },
          ],
        },
        request: {
          params: z.strictObject({ siteId: realtimeSchemas.publicSiteId }),
          query: indexingSummaryQuery,
          headers: requestHeaders,
          body: null,
        },
        responses: { 200: indexingSummaryResponse },
        errors: partnerSiteErrors,
        errorResponse: errorEnvelopeSchemas(partnerSiteErrors, realtimeSchemas.publicRequestId),
        resources: { reads: [{ type: 'site.indexing', idFrom: 'params.siteId' }], changes: [] },
        lifecycle: { introduced: '1.0.0' },
        docs: {
          summary: 'Get site indexing summary',
          description: 'Returns indexing coverage, trend, and inspection signal totals.',
          tags: ['Indexing'],
          examples: {
            request: { params: { siteId: 's_01' }, query: { days: 28 } },
            response: {
              data: {
                trend: [],
                summary: {
                  totalUrls: 0,
                  indexed: 0,
                  notIndexed: 0,
                  pending: 0,
                  indexedPercent: 0,
                  oldestCheck: null,
                  newestCheck: null,
                  change7d: null,
                  change28d: null,
                  signals: {
                    mobilePass: 0,
                    mobileFail: 0,
                    mobileUnspecified: 0,
                    richResultsPass: 0,
                    richResultsFail: 0,
                    richResultTypes: [],
                    crawlingMobile: 0,
                    crawlingDesktop: 0,
                  },
                },
                meta: {
                  siteUrl: 'sc-domain:example.com',
                  syncStatus: 'synced',
                  indexingStatus: 'complete',
                  indexingProgress: 100,
                  sitemapTotal: 0,
                  inspectedCount: 0,
                  noSitemapsSubmitted: false,
                  sitemapsPending: false,
                },
              },
              meta: { requestId: 'req_01', surface: 'partner', version: '1.0' },
            },
          },
        },
      }),
      listSiteIndexingUrls: defineHttpOperation({
        id: 'partner.sites.indexing.urls.list',
        method: 'GET',
        path: '/sites/{siteId}/indexing/urls',
        visibility: 'public',
        semantics: { kind: 'query', sideEffects: 'none', idempotent: true, retry: 'idempotent', readConsistency: 'primary' },
        auth: {
          credentials: ['user_key', 'partner_key'],
          scopes: ['indexing:read'],
          ownership: [
            { credential: 'user_key', rule: 'authorized_site' },
            { credential: 'partner_key', rule: 'authorized_site' },
          ],
        },
        request: {
          params: z.strictObject({ siteId: realtimeSchemas.publicSiteId }),
          query: indexingUrlsQuery,
          headers: requestHeaders,
          body: null,
        },
        responses: { 200: indexingUrlsResponse },
        errors: partnerSiteErrors,
        errorResponse: errorEnvelopeSchemas(partnerSiteErrors, realtimeSchemas.publicRequestId),
        resources: { reads: [{ type: 'site.indexing', idFrom: 'params.siteId' }], changes: [] },
        lifecycle: { introduced: '1.0.0' },
        docs: {
          summary: 'List indexed URLs',
          description: 'Returns the filtered URL-inspection index with pagination metadata.',
          tags: ['Indexing'],
          examples: {
            request: { params: { siteId: 's_01' }, query: { limit: 100, offset: 0 } },
            response: {
              data: {
                urls: [],
                pagination: { total: 0, limit: 100, offset: 0, hasMore: false },
                meta: { siteUrl: 'sc-domain:example.com', status: 'all', issue: null },
              },
              meta: { requestId: 'req_01', surface: 'partner', version: '1.0' },
            },
          },
        },
      }),
      listSiteIndexingTransitions: defineHttpOperation({
        id: 'partner.sites.indexing.transitions.list',
        method: 'GET',
        path: '/sites/{siteId}/indexing/transitions',
        visibility: 'public',
        semantics: { kind: 'query', sideEffects: 'none', idempotent: true, retry: 'idempotent', readConsistency: 'primary' },
        auth: {
          credentials: ['user_key', 'partner_key'],
          scopes: ['indexing:read'],
          ownership: [
            { credential: 'user_key', rule: 'authorized_site' },
            { credential: 'partner_key', rule: 'authorized_site' },
          ],
        },
        request: {
          params: z.strictObject({ siteId: realtimeSchemas.publicSiteId }),
          query: indexingTransitionsQuery,
          headers: requestHeaders,
          body: null,
        },
        responses: { 200: indexingTransitionsResponse },
        errors: partnerSiteErrors,
        errorResponse: errorEnvelopeSchemas(partnerSiteErrors, realtimeSchemas.publicRequestId),
        resources: { reads: [{ type: 'site.indexing', idFrom: 'params.siteId' }], changes: [] },
        lifecycle: { introduced: '1.4.8' },
        docs: {
          summary: 'List observed indexing transitions',
          description: 'Returns URL inspection state changes as bounded observation intervals. detectedAt is the first observation showing the new state, not the exact change time.',
          tags: ['Indexing'],
          examples: {
            request: {
              params: { siteId: 's_01' },
              query: { startDate: '2026-06-01', endDate: '2026-07-26', field: 'coverageState' },
            },
            response: {
              data: {
                transitions: [],
                observationWindow: {
                  _tag: 'empty',
                  gapDaysMedian: null,
                  gapDaysP90: null,
                  sampleSize: 0,
                },
                pagination: { total: 0, limit: 100, offset: 0, hasMore: false },
                meta: {
                  siteUrl: 'sc-domain:example.com',
                  startDate: '2026-06-01',
                  endDate: '2026-07-26',
                },
              },
              meta: { requestId: 'req_01', surface: 'partner', version: '1.0' },
            },
          },
        },
      }),
      getSiteIndexingDiagnostics: defineHttpOperation({
        id: 'partner.sites.indexing.diagnostics.get',
        method: 'GET',
        path: '/sites/{siteId}/indexing/diagnostics',
        visibility: 'public',
        semantics: { kind: 'query', sideEffects: 'none', idempotent: true, retry: 'idempotent', readConsistency: 'primary' },
        auth: {
          credentials: ['user_key', 'partner_key'],
          scopes: ['indexing:read'],
          ownership: [
            { credential: 'user_key', rule: 'authorized_site' },
            { credential: 'partner_key', rule: 'authorized_site' },
          ],
        },
        request: {
          params: z.strictObject({ siteId: realtimeSchemas.publicSiteId }),
          query: indexingDiagnosticsQuery,
          headers: requestHeaders,
          body: null,
        },
        responses: { 200: indexingDiagnosticsResponse },
        errors: partnerSiteErrors,
        errorResponse: errorEnvelopeSchemas(partnerSiteErrors, realtimeSchemas.publicRequestId),
        resources: { reads: [{ type: 'site.indexing', idFrom: 'params.siteId' }], changes: [] },
        lifecycle: { introduced: '1.0.0' },
        docs: {
          summary: 'Get indexing diagnostics',
          description: 'Returns indexing issue groups and optional URL samples.',
          tags: ['Indexing'],
          examples: {
            request: { params: { siteId: 's_01' }, query: {} },
            response: {
              data: {
                summary: { totalUrls: 0, indexed: 0, indexedPercent: 0 },
                issues: [],
                meta: { siteUrl: 'sc-domain:example.com' },
              },
              meta: { requestId: 'req_01', surface: 'partner', version: '1.0' },
            },
          },
        },
      }),
      getSiteSitemaps: defineHttpOperation({
        id: 'partner.sites.sitemaps.get',
        method: 'GET',
        path: '/sites/{siteId}/sitemaps',
        visibility: 'public',
        semantics: { kind: 'query', sideEffects: 'none', idempotent: true, retry: 'idempotent', readConsistency: 'primary' },
        auth: {
          credentials: ['user_key', 'partner_key'],
          scopes: ['sitemaps:read'],
          ownership: [
            { credential: 'user_key', rule: 'authorized_site' },
            { credential: 'partner_key', rule: 'authorized_site' },
          ],
        },
        request: {
          params: z.strictObject({ siteId: realtimeSchemas.publicSiteId }),
          query: null,
          headers: requestHeaders,
          body: null,
        },
        responses: { 200: sitemapsResponse },
        errors: partnerSiteErrors,
        errorResponse: errorEnvelopeSchemas(partnerSiteErrors, realtimeSchemas.publicRequestId),
        resources: { reads: [{ type: 'site.sitemaps', idFrom: 'params.siteId' }], changes: [] },
        lifecycle: { introduced: '1.0.0' },
        docs: {
          summary: 'Get sitemap snapshot',
          description: 'Returns registered sitemaps and their aggregate and per-sitemap history.',
          tags: ['Sitemaps'],
          examples: {
            request: { params: { siteId: 's_01' } },
            response: {
              data: {
                sitemaps: [],
                history: [],
                perSitemapHistory: {},
                generation: null,
                meta: {
                  siteUrl: 'sc-domain:example.com',
                  gscPropertyUrl: 'sc-domain:example.com',
                  syncStatus: 'synced',
                  sitemapScope: { excludedCount: 0, duplicateCount: 0 },
                },
              },
              meta: { requestId: 'req_01', surface: 'partner', version: '1.0' },
            },
          },
        },
      }),
      getSiteSitemapChanges: defineHttpOperation({
        id: 'partner.sites.sitemaps.changes.get',
        method: 'GET',
        path: '/sites/{siteId}/sitemaps/changes',
        visibility: 'public',
        semantics: { kind: 'query', sideEffects: 'none', idempotent: true, retry: 'idempotent', readConsistency: 'primary' },
        auth: {
          credentials: ['user_key', 'partner_key'],
          scopes: ['sitemaps:read'],
          ownership: [
            { credential: 'user_key', rule: 'authorized_site' },
            { credential: 'partner_key', rule: 'authorized_site' },
          ],
        },
        request: {
          params: z.strictObject({ siteId: realtimeSchemas.publicSiteId }),
          query: sitemapChangesQuery,
          headers: requestHeaders,
          body: null,
        },
        responses: { 200: sitemapChangesResponse },
        errors: partnerSiteErrors,
        errorResponse: errorEnvelopeSchemas(partnerSiteErrors, realtimeSchemas.publicRequestId),
        resources: { reads: [{ type: 'site.sitemaps', idFrom: 'params.siteId' }], changes: [] },
        lifecycle: { introduced: '1.0.0' },
        docs: {
          summary: 'Get sitemap URL changes',
          description: 'Returns recently added and removed sitemap URLs for the requested window.',
          tags: ['Sitemaps'],
          examples: {
            request: { params: { siteId: 's_01' }, query: { days: 28 } },
            response: {
              data: {
                added: [],
                removed: [],
                updated: [],
                generation: null,
                summary: { totalAdded: 0, totalRemoved: 0, totalUpdated: 0, period: { days: 28 } },
                completeness: { _tag: 'complete', scannedUrls: 0 },
              },
              meta: { requestId: 'req_01', surface: 'partner', version: '1.0' },
            },
          },
        },
      }),
      getSiteAnalysis: defineHttpOperation({
        id: 'partner.sites.analysis.get',
        method: 'GET',
        path: '/sites/{siteId}/analysis',
        visibility: 'public',
        semantics: { kind: 'query', sideEffects: 'none', idempotent: true, retry: 'idempotent', readConsistency: 'primary' },
        auth: {
          credentials: ['user_key', 'partner_key'],
          scopes: ['analytics:execute'],
          ownership: [
            { credential: 'user_key', rule: 'authorized_site' },
            { credential: 'partner_key', rule: 'authorized_site' },
          ],
        },
        request: {
          params: z.strictObject({ siteId: realtimeSchemas.publicSiteId }),
          query: analysisQuery,
          headers: requestHeaders,
          body: null,
        },
        responses: { 200: analysisResponse },
        errors: partnerSiteErrors,
        errorResponse: errorEnvelopeSchemas(partnerSiteErrors, realtimeSchemas.publicRequestId),
        resources: { reads: [{ type: 'site.analytics', idFrom: 'params.siteId' }], changes: [] },
        lifecycle: { introduced: '1.0.0' },
        docs: {
          summary: 'Run an analysis preset',
          description: 'Runs one validated analysis preset for an analytics window.',
          tags: ['Analysis'],
          examples: {
            request: { params: { siteId: 's_01' }, query: { preset: 'opportunity', startDate: '2026-06-01', endDate: '2026-06-30' } },
            response: {
              data: {
                preset: 'opportunity',
                keywords: [],
                totalCount: 0,
                meta: { siteUrl: 'sc-domain:example.com', params: { startDate: '2026-06-01', endDate: '2026-06-30' } },
              },
              meta: { requestId: 'req_01', surface: 'partner', version: '1.0' },
            },
          },
        },
      }),
      getSiteAnalysisBundle: defineHttpOperation({
        id: 'partner.sites.analysis.bundle.get',
        method: 'GET',
        path: '/sites/{siteId}/analysis/bundle',
        visibility: 'public',
        semantics: { kind: 'query', sideEffects: 'none', idempotent: true, retry: 'idempotent', readConsistency: 'primary' },
        auth: {
          credentials: ['user_key', 'partner_key'],
          scopes: ['analytics:execute'],
          ownership: [
            { credential: 'user_key', rule: 'authorized_site' },
            { credential: 'partner_key', rule: 'authorized_site' },
          ],
        },
        request: {
          params: z.strictObject({ siteId: realtimeSchemas.publicSiteId }),
          query: analysisBundleQuery,
          headers: requestHeaders,
          body: null,
        },
        responses: { 200: analysisBundleResponse },
        errors: partnerSiteErrors,
        errorResponse: errorEnvelopeSchemas(partnerSiteErrors, realtimeSchemas.publicRequestId),
        resources: { reads: [{ type: 'site.analytics', idFrom: 'params.siteId' }], changes: [] },
        lifecycle: { introduced: '1.0.0' },
        docs: {
          summary: 'Run an analysis bundle',
          description: 'Runs several validated presets against one shared analytics pool.',
          tags: ['Analysis'],
          examples: {
            request: { params: { siteId: 's_01' }, query: { presets: ['opportunity'], startDate: '2026-06-01', endDate: '2026-06-30' } },
            response: {
              data: {
                bundle: {},
                meta: { siteUrl: 'sc-domain:example.com', params: { startDate: '2026-06-01', endDate: '2026-06-30' } },
              },
              meta: { requestId: 'req_01', surface: 'partner', version: '1.0' },
            },
          },
        },
      }),
      deleteSite: defineHttpOperation({
        id: 'partner.sites.delete',
        method: 'DELETE',
        path: '/sites/{siteId}',
        visibility: 'public',
        semantics: { kind: 'mutation', sideEffects: 'state', idempotent: true, retry: 'idempotent', readConsistency: null },
        auth: {
          credentials: ['user_key', 'partner_key'],
          scopes: ['sites:write'],
          ownership: [
            { credential: 'user_key', rule: 'authorized_site' },
            { credential: 'partner_key', rule: 'authorized_site' },
          ],
        },
        request: {
          params: z.strictObject({ siteId: realtimeSchemas.publicSiteId }),
          query: null,
          headers: requestHeaders,
          body: null,
        },
        responses: { 200: siteDeletionResponse },
        errors: partnerSiteErrors,
        errorResponse: errorEnvelopeSchemas(partnerSiteErrors, realtimeSchemas.publicRequestId),
        resources: {
          reads: [{ type: 'site.registration', idFrom: 'params.siteId' }],
          changes: [
            { type: 'site.registration', idFrom: 'params.siteId' },
            { type: 'site.lifecycle', idFrom: 'params.siteId' },
          ],
        },
        lifecycle: { introduced: '1.0.0' },
        docs: {
          summary: 'Delete a site registration',
          description: 'Removes the site registration and queued work while retaining the user data store.',
          tags: ['Sites'],
          examples: {
            request: { params: { siteId: 's_01' } },
            response: { data: { deleted: true, siteId: 's_01', siteUrl: 'example.com' }, meta: { requestId: 'req_01', surface: 'partner', version: '1.0' } },
          },
        },
      }),
      getCanonicalMismatches: defineHttpOperation({
        id: 'partner.sites.canonical.mismatches.get',
        method: 'GET',
        path: '/sites/{siteId}/canonical-mismatches',
        visibility: 'public',
        semantics: { kind: 'query', sideEffects: 'none', idempotent: true, retry: 'idempotent', readConsistency: 'primary' },
        auth: {
          credentials: ['user_key', 'partner_key'],
          scopes: ['indexing:read'],
          ownership: [
            { credential: 'user_key', rule: 'authorized_site' },
            { credential: 'partner_key', rule: 'authorized_site' },
          ],
        },
        request: {
          params: z.strictObject({ siteId: realtimeSchemas.publicSiteId }),
          query: null,
          headers: requestHeaders,
          body: null,
        },
        responses: { 200: canonicalMismatchesResponse },
        errors: partnerSiteErrors,
        errorResponse: errorEnvelopeSchemas(partnerSiteErrors, realtimeSchemas.publicRequestId),
        resources: { reads: [{ type: 'site.indexing', idFrom: 'params.siteId' }], changes: [] },
        lifecycle: { introduced: '1.1.0' },
        docs: {
          summary: 'List canonical mismatches',
          description: 'Returns sitemap-scoped URLs whose Google-chosen canonical diverges from the declared canonical, with consolidation targets and trend.',
          tags: ['Indexing'],
          examples: {
            request: { params: { siteId: 's_01' } },
            response: {
              data: { mismatches: [], totalCount: 0, consolidationTargets: [], trend: [], meta: { siteUrl: 'sc-domain:example.com', syncStatus: 'synced' } },
              meta: { requestId: 'req_01', surface: 'partner', version: '1.0' },
            },
          },
        },
      }),
      inspectSiteUrls: defineHttpOperation({
        id: 'partner.sites.indexing.inspect.create',
        method: 'POST',
        path: '/sites/{siteId}/indexing/inspect',
        visibility: 'public',
        semantics: { kind: 'mutation', sideEffects: 'state', idempotent: false, retry: 'never', readConsistency: null },
        auth: {
          credentials: ['user_key', 'partner_key'],
          scopes: ['indexing:write'],
          ownership: [
            { credential: 'user_key', rule: 'authorized_site' },
            { credential: 'partner_key', rule: 'authorized_site' },
          ],
        },
        request: {
          params: z.strictObject({ siteId: realtimeSchemas.publicSiteId }),
          query: null,
          headers: requestHeaders,
          body: indexingInspectRequest,
        },
        responses: { 200: indexingInspectionResponse },
        errors: partnerSiteErrors,
        errorResponse: errorEnvelopeSchemas(partnerSiteErrors, realtimeSchemas.publicRequestId),
        resources: {
          reads: [{ type: 'site.indexing', idFrom: 'params.siteId' }],
          changes: [{ type: 'site.indexing', idFrom: 'params.siteId' }],
        },
        lifecycle: { introduced: '1.1.0' },
        docs: {
          summary: 'Inspect URLs on demand',
          description: 'Runs live URL inspections against the daily per-site quota; URLs outside the site domain and over-quota URLs are reported as skipped. Exhausted quota fails with rate_limited.',
          tags: ['Indexing'],
          examples: {
            request: { params: { siteId: 's_01' }, body: { urls: ['https://example.com/'] } },
            response: {
              data: { siteId: 's_01', rateLimit: { reserved: 1, remaining: 199, limit: 200 }, results: [], errors: [], skipped: [] },
              meta: { requestId: 'req_01', surface: 'partner', version: '1.0' },
            },
          },
        },
      }),
      recoverSitePermission: defineHttpOperation({
        id: 'partner.sites.permission.recover',
        method: 'POST',
        path: '/sites/{siteId}/permission/recover',
        visibility: 'public',
        semantics: { kind: 'mutation', sideEffects: 'state', idempotent: true, retry: 'idempotent', readConsistency: null },
        auth: {
          credentials: ['user_key', 'partner_key'],
          scopes: ['sites:write'],
          ownership: [
            { credential: 'user_key', rule: 'authorized_site' },
            { credential: 'partner_key', rule: 'authorized_site' },
          ],
        },
        request: {
          params: z.strictObject({ siteId: realtimeSchemas.publicSiteId }),
          query: null,
          headers: requestHeaders,
          body: null,
        },
        responses: { 200: permissionRecoveryResponse },
        errors: partnerSiteErrors,
        errorResponse: errorEnvelopeSchemas(partnerSiteErrors, realtimeSchemas.publicRequestId),
        resources: {
          reads: [{ type: 'site.auth', idFrom: 'params.siteId' }],
          changes: [
            { type: 'site.auth', idFrom: 'params.siteId' },
            { type: 'site.lifecycle', idFrom: 'params.siteId' },
          ],
        },
        lifecycle: { introduced: '1.1.0' },
        docs: {
          summary: 'Re-check and recover site permission',
          description: 'Force-rechecks Google Search Console access for a permission-lost site; on recovery resets sync state and queues fresh sync jobs.',
          tags: ['Sites'],
          examples: {
            request: { params: { siteId: 's_01' } },
            response: {
              data: { success: true, permissionLevel: 'siteFullUser', jobsQueued: 3, message: 'Permission restored (siteFullUser). Queued 3 sync jobs.' },
              meta: { requestId: 'req_01', surface: 'partner', version: '1.0' },
            },
          },
        },
      }),
      queryKeywordSparklines: defineHttpOperation({
        id: 'partner.sites.keyword.sparklines.query',
        method: 'POST',
        path: '/sites/{siteId}/keyword-sparklines',
        visibility: 'public',
        semantics: { kind: 'query', sideEffects: 'none', idempotent: true, retry: 'idempotent', readConsistency: 'primary' },
        auth: {
          credentials: ['user_key', 'partner_key'],
          scopes: ['analytics:read'],
          ownership: [
            { credential: 'user_key', rule: 'authorized_site' },
            { credential: 'partner_key', rule: 'authorized_site' },
          ],
        },
        request: {
          params: z.strictObject({ siteId: realtimeSchemas.publicSiteId }),
          query: null,
          headers: requestHeaders,
          body: keywordSparklinesRequest,
        },
        responses: { 200: keywordSparklinesResponse },
        errors: partnerSiteErrors,
        errorResponse: errorEnvelopeSchemas(partnerSiteErrors, realtimeSchemas.publicRequestId),
        resources: { reads: [{ type: 'site.analytics', idFrom: 'params.siteId' }], changes: [] },
        lifecycle: { introduced: '1.1.0' },
        docs: {
          summary: 'Query keyword sparklines',
          description: 'Returns per-keyword daily click series for up to 20 keywords over the requested window.',
          tags: ['Analytics'],
          examples: {
            request: { params: { siteId: 's_01' }, body: { keywords: ['nuxt seo'], startDate: '2026-06-01', endDate: '2026-06-28' } },
            response: {
              data: { sparklines: { 'nuxt seo': [0, 1, 2] } },
              meta: { requestId: 'req_01', surface: 'partner', version: '1.0' },
            },
          },
        },
      }),
      getQueryTrend: defineHttpOperation({
        id: 'partner.sites.query.trend.get',
        method: 'GET',
        path: '/sites/{siteId}/query-trend',
        visibility: 'public',
        semantics: { kind: 'query', sideEffects: 'none', idempotent: true, retry: 'idempotent', readConsistency: 'primary' },
        auth: {
          credentials: ['user_key', 'partner_key'],
          scopes: ['analytics:read'],
          ownership: [
            { credential: 'user_key', rule: 'authorized_site' },
            { credential: 'partner_key', rule: 'authorized_site' },
          ],
        },
        request: {
          params: z.strictObject({ siteId: realtimeSchemas.publicSiteId }),
          query: trendQuery,
          headers: requestHeaders,
          body: null,
        },
        responses: { 200: queryTrendResponse },
        errors: partnerSiteErrors,
        errorResponse: errorEnvelopeSchemas(partnerSiteErrors, realtimeSchemas.publicRequestId),
        resources: { reads: [{ type: 'site.analytics', idFrom: 'params.siteId' }], changes: [] },
        lifecycle: { introduced: '1.1.0' },
        docs: {
          summary: 'Get unique-query trend',
          description: 'Returns the daily unique-query count series for a window, with an optional previous-period total for comparison.',
          tags: ['Analytics'],
          examples: {
            request: { params: { siteId: 's_01' }, query: { startDate: '2026-06-01', endDate: '2026-06-28' } },
            response: {
              data: { daily: [], total: 0, meta: { siteUrl: 'sc-domain:example.com', syncStatus: 'synced' } },
              meta: { requestId: 'req_01', surface: 'partner', version: '1.0' },
            },
          },
        },
      }),
      getPageTrend: defineHttpOperation({
        id: 'partner.sites.page.trend.get',
        method: 'GET',
        path: '/sites/{siteId}/page-trend',
        visibility: 'public',
        semantics: { kind: 'query', sideEffects: 'none', idempotent: true, retry: 'idempotent', readConsistency: 'primary' },
        auth: {
          credentials: ['user_key', 'partner_key'],
          scopes: ['analytics:read'],
          ownership: [
            { credential: 'user_key', rule: 'authorized_site' },
            { credential: 'partner_key', rule: 'authorized_site' },
          ],
        },
        request: {
          params: z.strictObject({ siteId: realtimeSchemas.publicSiteId }),
          query: trendQuery,
          headers: requestHeaders,
          body: null,
        },
        responses: { 200: pageTrendResponse },
        errors: partnerSiteErrors,
        errorResponse: errorEnvelopeSchemas(partnerSiteErrors, realtimeSchemas.publicRequestId),
        resources: { reads: [{ type: 'site.analytics', idFrom: 'params.siteId' }], changes: [] },
        lifecycle: { introduced: '1.1.0' },
        docs: {
          summary: 'Get unique-page trend',
          description: 'Returns the daily unique-page count series for a window, with an optional previous-period total for comparison.',
          tags: ['Analytics'],
          examples: {
            request: { params: { siteId: 's_01' }, query: { startDate: '2026-06-01', endDate: '2026-06-28' } },
            response: {
              data: { daily: [], total: 0, meta: { siteUrl: 'sc-domain:example.com', syncStatus: 'synced' } },
              meta: { requestId: 'req_01', surface: 'partner', version: '1.0' },
            },
          },
        },
      }),
      getContentVelocity: defineHttpOperation({
        id: 'partner.sites.content.velocity.get',
        method: 'GET',
        path: '/sites/{siteId}/content-velocity',
        visibility: 'public',
        semantics: { kind: 'query', sideEffects: 'none', idempotent: true, retry: 'idempotent', readConsistency: 'primary' },
        auth: {
          credentials: ['user_key', 'partner_key'],
          scopes: ['analytics:read'],
          ownership: [
            { credential: 'user_key', rule: 'authorized_site' },
            { credential: 'partner_key', rule: 'authorized_site' },
          ],
        },
        request: {
          params: z.strictObject({ siteId: realtimeSchemas.publicSiteId }),
          query: contentVelocityQuery,
          headers: requestHeaders,
          body: null,
        },
        responses: { 200: contentVelocityResponse },
        errors: partnerSiteErrors,
        errorResponse: errorEnvelopeSchemas(partnerSiteErrors, realtimeSchemas.publicRequestId),
        resources: { reads: [{ type: 'site.analytics', idFrom: 'params.siteId' }], changes: [] },
        lifecycle: { introduced: '1.2.0' },
        docs: {
          summary: 'Get content velocity',
          description: 'Returns the weekly new-keyword series over the requested window with a summary trend.',
          tags: ['Analytics'],
          examples: {
            request: { params: { siteId: 's_01' }, query: { days: 90 } },
            response: {
              data: { weekly: [], summary: { totalNewKeywords: 0, avgPerWeek: 0, trend: 'stable' }, meta: { siteUrl: 'sc-domain:example.com', syncStatus: 'synced' } },
              meta: { requestId: 'req_01', surface: 'partner', version: '1.0' },
            },
          },
        },
      }),
      getCtrCurve: defineHttpOperation({
        id: 'partner.sites.ctr.curve.get',
        method: 'GET',
        path: '/sites/{siteId}/ctr-curve',
        visibility: 'public',
        semantics: { kind: 'query', sideEffects: 'none', idempotent: true, retry: 'idempotent', readConsistency: 'primary' },
        auth: {
          credentials: ['user_key', 'partner_key'],
          scopes: ['analytics:read'],
          ownership: [
            { credential: 'user_key', rule: 'authorized_site' },
            { credential: 'partner_key', rule: 'authorized_site' },
          ],
        },
        request: {
          params: z.strictObject({ siteId: realtimeSchemas.publicSiteId }),
          query: dateRangeQuery,
          headers: requestHeaders,
          body: null,
        },
        responses: { 200: ctrCurveResponse },
        errors: partnerSiteErrors,
        errorResponse: errorEnvelopeSchemas(partnerSiteErrors, realtimeSchemas.publicRequestId),
        resources: { reads: [{ type: 'site.analytics', idFrom: 'params.siteId' }], changes: [] },
        lifecycle: { introduced: '1.2.0' },
        docs: {
          summary: 'Get CTR curve and outliers',
          description: 'Returns the position-bucketed CTR curve plus over/under-performing query outliers for the window.',
          tags: ['Analytics'],
          examples: {
            request: { params: { siteId: 's_01' }, query: { startDate: '2026-06-01', endDate: '2026-06-28' } },
            response: {
              data: { curve: [], overperforming: [], underperforming: [], meta: { siteUrl: 'sc-domain:example.com', syncStatus: 'synced' } },
              meta: { requestId: 'req_01', surface: 'partner', version: '1.0' },
            },
          },
        },
      }),
      getDarkTraffic: defineHttpOperation({
        id: 'partner.sites.dark.traffic.get',
        method: 'GET',
        path: '/sites/{siteId}/dark-traffic',
        visibility: 'public',
        semantics: { kind: 'query', sideEffects: 'none', idempotent: true, retry: 'idempotent', readConsistency: 'primary' },
        auth: {
          credentials: ['user_key', 'partner_key'],
          scopes: ['analytics:read'],
          ownership: [
            { credential: 'user_key', rule: 'authorized_site' },
            { credential: 'partner_key', rule: 'authorized_site' },
          ],
        },
        request: {
          params: z.strictObject({ siteId: realtimeSchemas.publicSiteId }),
          query: dateRangeQuery,
          headers: requestHeaders,
          body: null,
        },
        responses: { 200: darkTrafficResponse },
        errors: partnerSiteErrors,
        errorResponse: errorEnvelopeSchemas(partnerSiteErrors, realtimeSchemas.publicRequestId),
        resources: { reads: [{ type: 'site.analytics', idFrom: 'params.siteId' }], changes: [] },
        lifecycle: { introduced: '1.2.0' },
        docs: {
          summary: 'Get dark traffic breakdown',
          description: 'Returns clicks not attributable to any tracked keyword, in total and per page, for the window.',
          tags: ['Analytics'],
          examples: {
            request: { params: { siteId: 's_01' }, query: { startDate: '2026-06-01', endDate: '2026-06-28' } },
            response: {
              data: { summary: { totalClicks: 0, attributedClicks: 0, darkClicks: 0, darkPercent: 0, totalImpressions: 0, attributedImpressions: 0 }, pages: [], meta: { siteUrl: 'sc-domain:example.com', syncStatus: 'synced' } },
              meta: { requestId: 'req_01', surface: 'partner', version: '1.0' },
            },
          },
        },
      }),
      getDeviceGap: defineHttpOperation({
        id: 'partner.sites.device.gap.get',
        method: 'GET',
        path: '/sites/{siteId}/device-gap',
        visibility: 'public',
        semantics: { kind: 'query', sideEffects: 'none', idempotent: true, retry: 'idempotent', readConsistency: 'primary' },
        auth: {
          credentials: ['user_key', 'partner_key'],
          scopes: ['analytics:read'],
          ownership: [
            { credential: 'user_key', rule: 'authorized_site' },
            { credential: 'partner_key', rule: 'authorized_site' },
          ],
        },
        request: {
          params: z.strictObject({ siteId: realtimeSchemas.publicSiteId }),
          query: dateRangeQuery,
          headers: requestHeaders,
          body: null,
        },
        responses: { 200: deviceGapResponse },
        errors: partnerSiteErrors,
        errorResponse: errorEnvelopeSchemas(partnerSiteErrors, realtimeSchemas.publicRequestId),
        resources: { reads: [{ type: 'site.analytics', idFrom: 'params.siteId' }], changes: [] },
        lifecycle: { introduced: '1.2.0' },
        docs: {
          summary: 'Get desktop/mobile gap',
          description: 'Returns per-day desktop vs mobile CTR/position metrics with gap trends for the window.',
          tags: ['Analytics'],
          examples: {
            request: { params: { siteId: 's_01' }, query: { startDate: '2026-06-01', endDate: '2026-06-28' } },
            response: {
              data: { daily: [], summary: null, meta: { siteUrl: 'sc-domain:example.com', syncStatus: 'synced' } },
              meta: { requestId: 'req_01', surface: 'partner', version: '1.0' },
            },
          },
        },
      }),
      getKeywordBreadth: defineHttpOperation({
        id: 'partner.sites.keyword.breadth.get',
        method: 'GET',
        path: '/sites/{siteId}/keyword-breadth',
        visibility: 'public',
        semantics: { kind: 'query', sideEffects: 'none', idempotent: true, retry: 'idempotent', readConsistency: 'primary' },
        auth: {
          credentials: ['user_key', 'partner_key'],
          scopes: ['analytics:read'],
          ownership: [
            { credential: 'user_key', rule: 'authorized_site' },
            { credential: 'partner_key', rule: 'authorized_site' },
          ],
        },
        request: {
          params: z.strictObject({ siteId: realtimeSchemas.publicSiteId }),
          query: dateRangeQuery,
          headers: requestHeaders,
          body: null,
        },
        responses: { 200: keywordBreadthResponse },
        errors: partnerSiteErrors,
        errorResponse: errorEnvelopeSchemas(partnerSiteErrors, realtimeSchemas.publicRequestId),
        resources: { reads: [{ type: 'site.analytics', idFrom: 'params.siteId' }], changes: [] },
        lifecycle: { introduced: '1.2.0' },
        docs: {
          summary: 'Get keyword breadth',
          description: 'Returns the pages-per-keyword-count distribution with fragile and authority page lists for the window.',
          tags: ['Analytics'],
          examples: {
            request: { params: { siteId: 's_01' }, query: { startDate: '2026-06-01', endDate: '2026-06-28' } },
            response: {
              data: { distribution: [], fragilePages: [], authorityPages: [], summary: { totalPages: 0, avgKeywordsPerPage: 0, fragileCount: 0, authorityCount: 0 }, meta: { siteUrl: 'sc-domain:example.com', syncStatus: 'synced' } },
              meta: { requestId: 'req_01', surface: 'partner', version: '1.0' },
            },
          },
        },
      }),
      getPositionDistribution: defineHttpOperation({
        id: 'partner.sites.position.distribution.get',
        method: 'GET',
        path: '/sites/{siteId}/position-distribution',
        visibility: 'public',
        semantics: { kind: 'query', sideEffects: 'none', idempotent: true, retry: 'idempotent', readConsistency: 'primary' },
        auth: {
          credentials: ['user_key', 'partner_key'],
          scopes: ['analytics:read'],
          ownership: [
            { credential: 'user_key', rule: 'authorized_site' },
            { credential: 'partner_key', rule: 'authorized_site' },
          ],
        },
        request: {
          params: z.strictObject({ siteId: realtimeSchemas.publicSiteId }),
          query: dateRangeQuery,
          headers: requestHeaders,
          body: null,
        },
        responses: { 200: positionDistributionResponse },
        errors: partnerSiteErrors,
        errorResponse: errorEnvelopeSchemas(partnerSiteErrors, realtimeSchemas.publicRequestId),
        resources: { reads: [{ type: 'site.analytics', idFrom: 'params.siteId' }], changes: [] },
        lifecycle: { introduced: '1.2.0' },
        docs: {
          summary: 'Get position distribution',
          description: 'Returns the per-day keyword counts bucketed by average position for the window.',
          tags: ['Analytics'],
          examples: {
            request: { params: { siteId: 's_01' }, query: { startDate: '2026-06-01', endDate: '2026-06-28' } },
            response: {
              data: { distribution: [], meta: { siteUrl: 'sc-domain:example.com', syncStatus: 'synced' } },
              meta: { requestId: 'req_01', surface: 'partner', version: '1.0' },
            },
          },
        },
      }),
      getTopAssociation: defineHttpOperation({
        id: 'partner.sites.top.association.get',
        method: 'GET',
        path: '/sites/{siteId}/top-association',
        visibility: 'public',
        semantics: { kind: 'query', sideEffects: 'none', idempotent: true, retry: 'idempotent', readConsistency: 'primary' },
        auth: {
          credentials: ['user_key', 'partner_key'],
          scopes: ['analytics:read'],
          ownership: [
            { credential: 'user_key', rule: 'authorized_site' },
            { credential: 'partner_key', rule: 'authorized_site' },
          ],
        },
        request: {
          params: z.strictObject({ siteId: realtimeSchemas.publicSiteId }),
          query: topAssociationQuery,
          headers: requestHeaders,
          body: null,
        },
        responses: { 200: topAssociationResponse },
        errors: partnerSiteErrors,
        errorResponse: errorEnvelopeSchemas(partnerSiteErrors, realtimeSchemas.publicRequestId),
        resources: { reads: [{ type: 'site.analytics', idFrom: 'params.siteId' }], changes: [] },
        lifecycle: { introduced: '1.2.0' },
        docs: {
          summary: 'Get top association',
          description: 'Returns the single best-performing page for a keyword, or keyword for a page, over the window.',
          tags: ['Analytics'],
          examples: {
            request: { params: { siteId: 's_01' }, query: { type: 'topKeyword', identifier: '/docs', startDate: '2026-06-01', endDate: '2026-06-28' } },
            response: {
              data: { value: null },
              meta: { requestId: 'req_01', surface: 'partner', version: '1.0' },
            },
          },
        },
      }),
      getIndexPercent: defineHttpOperation({
        id: 'partner.sites.index.percent.get',
        method: 'GET',
        path: '/sites/{siteId}/index-percent',
        visibility: 'public',
        semantics: { kind: 'query', sideEffects: 'none', idempotent: true, retry: 'idempotent', readConsistency: 'primary' },
        auth: {
          credentials: ['user_key', 'partner_key'],
          scopes: ['indexing:read'],
          ownership: [
            { credential: 'user_key', rule: 'authorized_site' },
            { credential: 'partner_key', rule: 'authorized_site' },
          ],
        },
        request: {
          params: z.strictObject({ siteId: realtimeSchemas.publicSiteId }),
          query: indexPercentQuery,
          headers: requestHeaders,
          body: null,
        },
        responses: { 200: indexPercentResponse },
        errors: partnerSiteErrors,
        errorResponse: errorEnvelopeSchemas(partnerSiteErrors, realtimeSchemas.publicRequestId),
        resources: {
          reads: [
            { type: 'site.indexing', idFrom: 'params.siteId' },
            { type: 'site.sitemaps', idFrom: 'params.siteId' },
          ],
          changes: [],
        },
        lifecycle: { introduced: '1.2.0' },
        docs: {
          summary: 'Get sitemap index-percent',
          description: 'Returns the sitemap visibility trend, invisible URLs, orphan pages, and per-sitemap counts.',
          tags: ['Indexing'],
          examples: {
            request: { params: { siteId: 's_01' }, query: { invisibleLimit: 100 } },
            response: {
              data: { trend: [], invisibleUrls: [], invisibleCount: 0, orphanPages: [], orphanCount: 0, sitemaps: [], summary: { currentPercent: 0, totalSitemapUrls: 0, visibleUrls: 0, change7d: null, change28d: null, dataDate: '2026-06-28' }, meta: { siteUrl: 'sc-domain:example.com', syncStatus: 'synced', newestDateSynced: null } },
              meta: { requestId: 'req_01', surface: 'partner', version: '1.0' },
            },
          },
        },
      }),
      createSitemapAction: defineHttpOperation({
        id: 'partner.sites.sitemaps.action.create',
        method: 'POST',
        path: '/sites/{siteId}/sitemaps/actions',
        visibility: 'public',
        semantics: { kind: 'mutation', sideEffects: 'state', idempotent: false, retry: 'never', readConsistency: null },
        auth: {
          credentials: ['user_key', 'partner_key'],
          scopes: ['sitemaps:write'],
          ownership: [
            { credential: 'user_key', rule: 'authorized_site' },
            { credential: 'partner_key', rule: 'authorized_site' },
          ],
        },
        request: {
          params: z.strictObject({ siteId: realtimeSchemas.publicSiteId }),
          query: null,
          headers: requestHeaders,
          body: sitemapActionRequest,
        },
        responses: { 200: sitemapActionResponse },
        errors: partnerSiteErrors,
        errorResponse: errorEnvelopeSchemas(partnerSiteErrors, realtimeSchemas.publicRequestId),
        resources: {
          reads: [{ type: 'site.sitemaps', idFrom: 'params.siteId' }],
          changes: [{ type: 'site.sitemaps', idFrom: 'params.siteId' }],
        },
        lifecycle: { introduced: '1.3.0' },
        docs: {
          summary: 'Run a sitemap action',
          description: 'Submits, deletes, refreshes, or auto-discovers a site\'s sitemap; the response shape depends on the requested action.',
          tags: ['Sitemaps'],
          examples: {
            request: { params: { siteId: 's_01' }, body: { action: 'refresh' } },
            response: {
              data: { success: true, action: 'refreshed', sitemapCount: 0, changed: false },
              meta: { requestId: 'req_01', surface: 'partner', version: '1.0' },
            },
          },
        },
      }),
      querySitemapMembership: defineHttpOperation({
        id: 'partner.sites.sitemaps.membership.query',
        method: 'POST',
        path: '/sites/{siteId}/sitemaps/membership',
        visibility: 'public',
        semantics: { kind: 'query', sideEffects: 'none', idempotent: true, retry: 'idempotent', readConsistency: 'primary' },
        auth: {
          credentials: ['user_key', 'partner_key'],
          scopes: ['sitemaps:read'],
          ownership: [
            { credential: 'user_key', rule: 'authorized_site' },
            { credential: 'partner_key', rule: 'authorized_site' },
          ],
        },
        request: {
          params: z.strictObject({ siteId: realtimeSchemas.publicSiteId }),
          query: null,
          headers: requestHeaders,
          body: sitemapMembershipRequest,
        },
        responses: { 200: sitemapMembershipResponse },
        errors: partnerSiteErrors,
        errorResponse: errorEnvelopeSchemas(partnerSiteErrors, realtimeSchemas.publicRequestId),
        resources: { reads: [{ type: 'site.sitemaps', idFrom: 'params.siteId' }], changes: [] },
        lifecycle: { introduced: '1.3.0' },
        docs: {
          summary: 'Query sitemap membership',
          description: 'Returns generation-pinned present, absent, or unknown evidence for each exact requested URL.',
          tags: ['Sitemaps'],
          examples: {
            request: { params: { siteId: 's_01' }, body: { urls: ['https://example.com/'] } },
            response: {
              data: { generation: null, evidence: [{ _tag: 'unknown', url: 'https://example.com/', reason: 'no_generation' }], meta: { requested: 1, checked: 0, matched: 0 } },
              meta: { requestId: 'req_01', surface: 'partner', version: '1.0' },
            },
          },
        },
      }),
      listSitemapUrls: defineHttpOperation({
        id: 'partner.sites.sitemaps.urls.get',
        method: 'GET',
        path: '/sites/{siteId}/sitemaps/urls',
        visibility: 'public',
        semantics: { kind: 'query', sideEffects: 'none', idempotent: true, retry: 'idempotent', readConsistency: 'primary' },
        auth: {
          credentials: ['user_key', 'partner_key'],
          scopes: ['sitemaps:read'],
          ownership: [
            { credential: 'user_key', rule: 'authorized_site' },
            { credential: 'partner_key', rule: 'authorized_site' },
          ],
        },
        request: {
          params: z.strictObject({ siteId: realtimeSchemas.publicSiteId }),
          query: sitemapUrlsQuery,
          headers: requestHeaders,
          body: null,
        },
        responses: { 200: sitemapUrlsResponse },
        errors: partnerSiteErrors,
        errorResponse: errorEnvelopeSchemas(partnerSiteErrors, realtimeSchemas.publicRequestId),
        resources: { reads: [{ type: 'site.sitemaps', idFrom: 'params.siteId' }], changes: [] },
        lifecycle: { introduced: '2.0.0' },
        docs: {
          summary: 'List sitemap URLs',
          description: 'Returns an exact generation-pinned cursor page of sitemap membership and lastmod evidence.',
          tags: ['Sitemaps'],
          examples: {
            request: { params: { siteId: 's_01' }, query: { limit: 500 } },
            response: {
              data: {
                generation: {
                  id: 'site-01JZ',
                  observedAt: 1753746000000,
                  publishedAt: 1753746000100,
                  completeness: { _tag: 'complete' },
                  membershipHistoryAvailableFrom: 1753746000000,
                  legacyImport: { _tag: 'none' },
                },
                items: [],
                page: { nextCursor: null, limit: 500 },
              },
              meta: { requestId: 'req_01', surface: 'partner', version: '1.0' },
            },
          },
        },
      }),
      getSitemapExport: defineHttpOperation({
        id: 'partner.sites.sitemaps.export.get',
        method: 'GET',
        path: '/sites/{siteId}/sitemaps/export',
        visibility: 'public',
        semantics: { kind: 'query', sideEffects: 'none', idempotent: true, retry: 'idempotent', readConsistency: 'primary' },
        auth: {
          credentials: ['user_key', 'partner_key'],
          scopes: ['sitemaps:read'],
          ownership: [
            { credential: 'user_key', rule: 'authorized_site' },
            { credential: 'partner_key', rule: 'authorized_site' },
          ],
        },
        request: {
          params: z.strictObject({ siteId: realtimeSchemas.publicSiteId }),
          query: sitemapExportQuery,
          headers: requestHeaders,
          body: null,
        },
        responses: { 200: sitemapExportResponse },
        errors: partnerSiteErrors,
        errorResponse: errorEnvelopeSchemas(partnerSiteErrors, realtimeSchemas.publicRequestId),
        resources: { reads: [{ type: 'site.sitemaps', idFrom: 'params.siteId' }], changes: [] },
        lifecycle: { introduced: '2.0.0' },
        docs: {
          summary: 'Get sitemap bulk export',
          description: 'Returns a generation-pinned expiring URL for the full NDJSON sitemap projection.',
          tags: ['Sitemaps'],
          examples: {
            request: { params: { siteId: 's_01' } },
            response: {
              data: {
                generation: {
                  id: 'site-01JZ',
                  observedAt: 1753746000000,
                  publishedAt: 1753746000100,
                  completeness: { _tag: 'complete' },
                  membershipHistoryAvailableFrom: 1753746000000,
                  legacyImport: { _tag: 'none' },
                },
                export: { _tag: 'unavailable', reason: 'export_unavailable' },
              },
              meta: { requestId: 'req_01', surface: 'partner', version: '1.0' },
            },
          },
        },
      }),
      createTeam: defineHttpOperation({
        id: 'partner.teams.create',
        method: 'POST',
        path: '/teams',
        visibility: 'public',
        semantics: { kind: 'mutation', sideEffects: 'state', idempotent: false, retry: 'never', readConsistency: null },
        auth: {
          credentials: ['partner_key'],
          scopes: ['teams:write'],
          ownership: [{ credential: 'partner_key', rule: 'partner_tenant' }],
        },
        request: { params: null, query: null, headers: requestHeaders, body: createTeamRequest },
        responses: { 200: teamCreatedResponse },
        errors: partnerUserErrors,
        errorResponse: errorEnvelopeSchemas(partnerUserErrors, realtimeSchemas.publicRequestId),
        resources: { reads: [], changes: [{ type: 'partner.team', idFrom: 'principal.id' }] },
        lifecycle: { introduced: '1.3.0' },
        docs: {
          summary: 'Create a team',
          description: 'Creates a team owned by a user linked to the authenticated partner tenant.',
          tags: ['Teams'],
          examples: {
            request: { body: { ownerUserId: 'u_01', name: 'Acme Team' } },
            response: {
              data: { team: { id: 't_01', ownerId: 1, name: 'Acme Team', personalTeam: false, createdAt: 0, updatedAt: 0 } },
              meta: { requestId: 'req_01', surface: 'partner', version: '1.0' },
            },
          },
        },
      }),
      renameTeam: defineHttpOperation({
        id: 'partner.teams.rename',
        method: 'PATCH',
        path: '/teams/{teamId}',
        visibility: 'public',
        semantics: { kind: 'mutation', sideEffects: 'state', idempotent: true, retry: 'idempotent', readConsistency: null },
        auth: {
          credentials: ['partner_key'],
          scopes: ['teams:write'],
          ownership: [{ credential: 'partner_key', rule: 'partner_tenant' }],
        },
        request: {
          params: z.strictObject({ teamId: realtimeSchemas.publicTeamId }),
          query: null,
          headers: requestHeaders,
          body: renameTeamRequest,
        },
        responses: { 200: teamRenamedResponse },
        errors: partnerUserErrors,
        errorResponse: errorEnvelopeSchemas(partnerUserErrors, realtimeSchemas.publicRequestId),
        resources: {
          reads: [{ type: 'partner.team', idFrom: 'params.teamId' }],
          changes: [{ type: 'partner.team', idFrom: 'params.teamId' }],
        },
        lifecycle: { introduced: '1.3.0' },
        docs: {
          summary: 'Rename a team',
          description: 'Renames a team owned by the authenticated partner tenant.',
          tags: ['Teams'],
          examples: {
            request: { params: { teamId: 't_01' }, body: { name: 'New name' } },
            response: { data: { ok: true, name: 'New name' }, meta: { requestId: 'req_01', surface: 'partner', version: '1.0' } },
          },
        },
      }),
      deleteTeam: defineHttpOperation({
        id: 'partner.teams.delete',
        method: 'DELETE',
        path: '/teams/{teamId}',
        visibility: 'public',
        semantics: { kind: 'mutation', sideEffects: 'state', idempotent: true, retry: 'idempotent', readConsistency: null },
        auth: {
          credentials: ['partner_key'],
          scopes: ['teams:write'],
          ownership: [{ credential: 'partner_key', rule: 'partner_tenant' }],
        },
        request: {
          params: z.strictObject({ teamId: realtimeSchemas.publicTeamId }),
          query: null,
          headers: requestHeaders,
          body: null,
        },
        responses: { 200: teamDeletedResponse },
        errors: partnerUserErrors,
        errorResponse: errorEnvelopeSchemas(partnerUserErrors, realtimeSchemas.publicRequestId),
        resources: {
          reads: [{ type: 'partner.team', idFrom: 'params.teamId' }],
          changes: [{ type: 'partner.team', idFrom: 'params.teamId' }],
        },
        lifecycle: { introduced: '1.3.0' },
        docs: {
          summary: 'Delete a team',
          description: 'Deletes a team owned by the authenticated partner tenant.',
          tags: ['Teams'],
          examples: {
            request: { params: { teamId: 't_01' } },
            response: { data: { ok: true }, meta: { requestId: 'req_01', surface: 'partner', version: '1.0' } },
          },
        },
      }),
      listTeamMembers: defineHttpOperation({
        id: 'partner.teams.members.list',
        method: 'GET',
        path: '/teams/{teamId}/members',
        visibility: 'public',
        semantics: { kind: 'query', sideEffects: 'none', idempotent: true, retry: 'idempotent', readConsistency: 'primary' },
        auth: {
          credentials: ['partner_key'],
          scopes: ['teams:read'],
          ownership: [{ credential: 'partner_key', rule: 'partner_tenant' }],
        },
        request: {
          params: z.strictObject({ teamId: realtimeSchemas.publicTeamId }),
          query: null,
          headers: requestHeaders,
          body: null,
        },
        responses: { 200: teamMembersResponse },
        errors: partnerUserErrors,
        errorResponse: errorEnvelopeSchemas(partnerUserErrors, realtimeSchemas.publicRequestId),
        resources: { reads: [{ type: 'partner.team', idFrom: 'params.teamId' }], changes: [] },
        lifecycle: { introduced: '1.3.0' },
        docs: {
          summary: 'List team members',
          description: 'Lists the members of a team owned by the authenticated partner tenant.',
          tags: ['Teams'],
          examples: {
            request: { params: { teamId: 't_01' } },
            response: { data: { members: [] }, meta: { requestId: 'req_01', surface: 'partner', version: '1.0' } },
          },
        },
      }),
      addTeamMember: defineHttpOperation({
        id: 'partner.teams.members.add',
        method: 'POST',
        path: '/teams/{teamId}/members',
        visibility: 'public',
        semantics: { kind: 'mutation', sideEffects: 'state', idempotent: true, retry: 'idempotent', readConsistency: null },
        auth: {
          credentials: ['partner_key'],
          scopes: ['teams:write'],
          ownership: [{ credential: 'partner_key', rule: 'partner_tenant' }],
        },
        request: {
          params: z.strictObject({ teamId: realtimeSchemas.publicTeamId }),
          query: null,
          headers: requestHeaders,
          body: addTeamMemberRequest,
        },
        responses: { 200: teamMemberAddedResponse },
        errors: partnerUserErrors,
        errorResponse: errorEnvelopeSchemas(partnerUserErrors, realtimeSchemas.publicRequestId),
        resources: {
          reads: [{ type: 'partner.team', idFrom: 'params.teamId' }],
          changes: [{ type: 'partner.team', idFrom: 'params.teamId' }],
        },
        lifecycle: { introduced: '1.3.0' },
        docs: {
          summary: 'Add a team member',
          description: 'Adds a user to a team owned by the authenticated partner tenant, or reports it was already a member.',
          tags: ['Teams'],
          examples: {
            request: { params: { teamId: 't_01' }, body: { userId: 'u_02', role: 'editor' } },
            response: { data: { ok: true, role: 'editor' }, meta: { requestId: 'req_01', surface: 'partner', version: '1.0' } },
          },
        },
      }),
      updateTeamMemberRole: defineHttpOperation({
        id: 'partner.teams.members.role.update',
        method: 'PATCH',
        path: '/teams/{teamId}/members/{userId}',
        visibility: 'public',
        semantics: { kind: 'mutation', sideEffects: 'state', idempotent: true, retry: 'idempotent', readConsistency: null },
        auth: {
          credentials: ['partner_key'],
          scopes: ['teams:write'],
          ownership: [{ credential: 'partner_key', rule: 'partner_tenant' }],
        },
        request: {
          params: z.strictObject({ teamId: realtimeSchemas.publicTeamId, userId: realtimeSchemas.publicUserId }),
          query: null,
          headers: requestHeaders,
          body: updateTeamMemberRoleRequest,
        },
        responses: { 200: teamMemberRoleResponse },
        errors: partnerUserErrors,
        errorResponse: errorEnvelopeSchemas(partnerUserErrors, realtimeSchemas.publicRequestId),
        resources: {
          reads: [
            { type: 'partner.team', idFrom: 'params.teamId' },
            { type: 'partner.user', idFrom: 'params.userId' },
          ],
          changes: [
            { type: 'partner.team', idFrom: 'params.teamId' },
            { type: 'partner.user', idFrom: 'params.userId' },
          ],
        },
        lifecycle: { introduced: '1.3.0' },
        docs: {
          summary: 'Update a team member role',
          description: 'Updates the role of an existing member of a team owned by the authenticated partner tenant.',
          tags: ['Teams'],
          examples: {
            request: { params: { teamId: 't_01', userId: 'u_02' }, body: { role: 'admin' } },
            response: { data: { ok: true, role: 'admin' }, meta: { requestId: 'req_01', surface: 'partner', version: '1.0' } },
          },
        },
      }),
      removeTeamMember: defineHttpOperation({
        id: 'partner.teams.members.remove',
        method: 'DELETE',
        path: '/teams/{teamId}/members/{userId}',
        visibility: 'public',
        semantics: { kind: 'mutation', sideEffects: 'state', idempotent: true, retry: 'idempotent', readConsistency: null },
        auth: {
          credentials: ['partner_key'],
          scopes: ['teams:write'],
          ownership: [{ credential: 'partner_key', rule: 'partner_tenant' }],
        },
        request: {
          params: z.strictObject({ teamId: realtimeSchemas.publicTeamId, userId: realtimeSchemas.publicUserId }),
          query: null,
          headers: requestHeaders,
          body: null,
        },
        responses: { 200: teamMemberRemovedResponse },
        errors: partnerUserErrors,
        errorResponse: errorEnvelopeSchemas(partnerUserErrors, realtimeSchemas.publicRequestId),
        resources: {
          reads: [
            { type: 'partner.team', idFrom: 'params.teamId' },
            { type: 'partner.user', idFrom: 'params.userId' },
          ],
          changes: [
            { type: 'partner.team', idFrom: 'params.teamId' },
            { type: 'partner.user', idFrom: 'params.userId' },
          ],
        },
        lifecycle: { introduced: '1.3.0' },
        docs: {
          summary: 'Remove a team member',
          description: 'Removes a member from a team owned by the authenticated partner tenant.',
          tags: ['Teams'],
          examples: {
            request: { params: { teamId: 't_01', userId: 'u_02' } },
            response: { data: { ok: true }, meta: { requestId: 'req_01', surface: 'partner', version: '1.0' } },
          },
        },
      }),
      updateSiteTeam: defineHttpOperation({
        id: 'partner.sites.team.update',
        method: 'PATCH',
        path: '/sites/{siteId}/team',
        visibility: 'public',
        semantics: { kind: 'mutation', sideEffects: 'state', idempotent: true, retry: 'idempotent', readConsistency: null },
        auth: {
          credentials: ['partner_key'],
          scopes: ['sites:write'],
          ownership: [{ credential: 'partner_key', rule: 'authorized_site' }],
        },
        request: {
          params: z.strictObject({ siteId: realtimeSchemas.publicSiteId }),
          query: null,
          headers: requestHeaders,
          body: bindSiteTeamRequest,
        },
        responses: { 200: siteTeamBindingResponse },
        errors: partnerSiteErrors,
        errorResponse: errorEnvelopeSchemas(partnerSiteErrors, realtimeSchemas.publicRequestId),
        resources: {
          reads: [{ type: 'site.registration', idFrom: 'params.siteId' }],
          changes: [{ type: 'site.registration', idFrom: 'params.siteId' }],
        },
        lifecycle: { introduced: '1.3.0' },
        docs: {
          summary: 'Bind a site to a team',
          description: 'Binds or unbinds (teamId: null) a partner-owned site to a partner-owned team.',
          tags: ['Teams'],
          examples: {
            request: { params: { siteId: 's_01' }, body: { teamId: 't_01' } },
            response: { data: { ok: true, teamId: 't_01' }, meta: { requestId: 'req_01', surface: 'partner', version: '1.0' } },
          },
        },
      }),
      getTeamCatalog: defineHttpOperation({
        id: 'partner.teams.catalog.get',
        method: 'GET',
        path: '/teams/{teamId}/catalog',
        visibility: 'public',
        semantics: { kind: 'query', sideEffects: 'none', idempotent: true, retry: 'idempotent', readConsistency: 'primary' },
        auth: {
          credentials: ['partner_key'],
          scopes: ['teams:read'],
          ownership: [{ credential: 'partner_key', rule: 'partner_tenant' }],
        },
        request: {
          params: z.strictObject({ teamId: realtimeSchemas.publicTeamId }),
          query: null,
          headers: requestHeaders,
          body: null,
        },
        responses: { 200: teamCatalogResponse },
        errors: partnerUserErrors,
        errorResponse: errorEnvelopeSchemas(partnerUserErrors, realtimeSchemas.publicRequestId),
        resources: { reads: [{ type: 'partner.team', idFrom: 'params.teamId' }], changes: [] },
        lifecycle: { introduced: '1.3.0' },
        docs: {
          summary: 'Get a team catalog',
          description: 'Returns the Iceberg catalog reference bound to a partner-owned team, if any.',
          tags: ['Teams'],
          examples: {
            request: { params: { teamId: 't_01' } },
            response: {
              data: { teamId: 't_01', catalogUri: null, warehouse: null, bucket: null, namespace: null, provisioningState: null, keyEncoding: null, catalogTablesReady: false, readsEnabled: false },
              meta: { requestId: 'req_01', surface: 'partner', version: '1.0' },
            },
          },
        },
      }),
      bindTeamCatalog: defineHttpOperation({
        id: 'partner.teams.catalog.bind',
        method: 'POST',
        path: '/teams/{teamId}/catalog',
        visibility: 'public',
        semantics: { kind: 'mutation', sideEffects: 'state', idempotent: true, retry: 'idempotent', readConsistency: null },
        auth: {
          credentials: ['partner_key'],
          scopes: ['teams:write'],
          ownership: [{ credential: 'partner_key', rule: 'partner_tenant' }],
        },
        request: {
          params: z.strictObject({ teamId: realtimeSchemas.publicTeamId }),
          query: null,
          headers: requestHeaders,
          body: bindTeamCatalogRequest,
        },
        responses: { 200: teamCatalogBindResponse },
        errors: partnerUserErrors,
        errorResponse: errorEnvelopeSchemas(partnerUserErrors, realtimeSchemas.publicRequestId),
        resources: {
          reads: [{ type: 'partner.team', idFrom: 'params.teamId' }],
          changes: [{ type: 'partner.team', idFrom: 'params.teamId' }],
        },
        lifecycle: { introduced: '1.3.0' },
        docs: {
          summary: 'Bind a team catalog',
          description: 'Binds an Iceberg catalog (URI, warehouse, and optional bucket/namespace) to a partner-owned team.',
          tags: ['Teams'],
          examples: {
            request: { params: { teamId: 't_01' }, body: { catalogUri: 'gs://bucket/catalog', warehouse: 'primary', namespace: 'ns1', bucket: 'bucket1' } },
            response: {
              data: { teamId: 't_01', status: 'ready', catalogUri: 'gs://bucket/catalog', warehouse: 'primary', bucket: 'bucket1', namespace: 'ns1' },
              meta: { requestId: 'req_01', surface: 'partner', version: '1.0' },
            },
          },
        },
      }),
      getSiteIntIdCrosswalk: defineHttpOperation({
        id: 'partner.users.sites.crosswalk.get',
        method: 'GET',
        path: '/users/{userId}/sites/crosswalk',
        visibility: 'public',
        semantics: { kind: 'query', sideEffects: 'none', idempotent: true, retry: 'idempotent', readConsistency: 'primary' },
        auth: {
          credentials: ['user_key', 'partner_key'],
          scopes: ['sites:read'],
          ownership: [
            { credential: 'user_key', rule: 'self' },
            { credential: 'partner_key', rule: 'linked_user' },
          ],
        },
        request: {
          params: z.strictObject({ userId: realtimeSchemas.publicUserId }),
          query: null,
          headers: requestHeaders,
          body: null,
        },
        responses: { 200: siteIntIdCrosswalkResponse },
        errors: partnerUserErrors,
        errorResponse: errorEnvelopeSchemas(partnerUserErrors, realtimeSchemas.publicRequestId),
        resources: {
          reads: [
            { type: 'partner.user', idFrom: 'params.userId' },
            { type: 'user.sites', idFrom: 'params.userId' },
          ],
          changes: [],
        },
        lifecycle: { introduced: '1.3.0' },
        docs: {
          summary: 'Get the site int-id crosswalk',
          description: 'Maps a user\'s public site IDs to their internal integer IDs, for partners that need the legacy numeric identifier.',
          tags: ['Sites'],
          examples: {
            request: { params: { userId: 'u_01' } },
            response: { data: { crosswalk: {}, sites: [] }, meta: { requestId: 'req_01', surface: 'partner', version: '1.0' } },
          },
        },
      }),
      deleteUser: defineHttpOperation({
        id: 'partner.users.delete',
        method: 'DELETE',
        path: '/users/{userId}',
        visibility: 'public',
        semantics: { kind: 'mutation', sideEffects: 'state', idempotent: true, retry: 'idempotent', readConsistency: null },
        auth: {
          credentials: ['partner_key'],
          scopes: ['users:write'],
          ownership: [{ credential: 'partner_key', rule: 'linked_user' }],
        },
        request: {
          params: z.strictObject({ userId: realtimeSchemas.publicUserId }),
          query: null,
          headers: requestHeaders,
          body: null,
        },
        responses: { 200: deletePartnerUserResponse },
        errors: partnerUserErrors,
        errorResponse: errorEnvelopeSchemas(partnerUserErrors, realtimeSchemas.publicRequestId),
        resources: {
          reads: [{ type: 'partner.user', idFrom: 'params.userId' }],
          changes: [
            { type: 'partner.user', idFrom: 'params.userId' },
            { type: 'user.sites', idFrom: 'params.userId' },
          ],
        },
        lifecycle: { introduced: '1.3.0' },
        docs: {
          summary: 'Delete a partner user',
          description: 'Queues cascade deletion of a partner-linked user and their sites.',
          tags: ['Users'],
          examples: {
            request: { params: { userId: 'u_01' } },
            response: { data: { ok: true, queued: true, userId: 1, publicId: 'u_01' }, meta: { requestId: 'req_01', surface: 'partner', version: '1.0' } },
          },
        },
      }),
      createVerificationToken: defineHttpOperation({
        id: 'partner.users.verification.token.create',
        method: 'POST',
        path: '/users/{userId}/verification-token',
        visibility: 'public',
        semantics: { kind: 'query', sideEffects: 'none', idempotent: true, retry: 'idempotent', readConsistency: 'primary' },
        auth: {
          credentials: ['user_key', 'partner_key'],
          scopes: ['sites:write'],
          ownership: [
            { credential: 'user_key', rule: 'self' },
            { credential: 'partner_key', rule: 'linked_user' },
          ],
        },
        request: {
          params: z.strictObject({ userId: realtimeSchemas.publicUserId }),
          query: null,
          headers: requestHeaders,
          body: verificationTokenRequest,
        },
        responses: { 200: verificationTokenResponse },
        errors: partnerUserErrors,
        errorResponse: errorEnvelopeSchemas(partnerUserErrors, realtimeSchemas.publicRequestId),
        resources: {
          reads: [
            { type: 'partner.user', idFrom: 'params.userId' },
            { type: 'user.sites', idFrom: 'params.userId' },
          ],
          changes: [],
        },
        lifecycle: { introduced: '1.3.0' },
        docs: {
          summary: 'Create a site verification token',
          description: 'Mints a Search Console site-ownership verification token (meta tag or DNS record) for a not-yet-registered site.',
          tags: ['Sites'],
          examples: {
            request: { params: { userId: 'u_01' }, body: { siteUrl: 'https://example.com', method: 'DNS_TXT' } },
            response: {
              data: { siteUrl: 'https://example.com', site: { type: 'INET_DOMAIN', identifier: 'example.com' }, method: 'DNS_TXT', token: 'abc123', metaContent: null, dnsRecord: { type: 'TXT', host: '_gsc.example.com', value: 'abc123' } },
              meta: { requestId: 'req_01', surface: 'partner', version: '1.0' },
            },
          },
        },
      }),
      addAndVerifySite: defineHttpOperation({
        id: 'partner.users.sites.verify.create',
        method: 'POST',
        path: '/users/{userId}/sites/verify',
        visibility: 'public',
        semantics: { kind: 'mutation', sideEffects: 'state', idempotent: true, retry: 'idempotent', readConsistency: null },
        auth: {
          credentials: ['user_key', 'partner_key'],
          scopes: ['sites:write'],
          ownership: [
            { credential: 'user_key', rule: 'self' },
            { credential: 'partner_key', rule: 'linked_user' },
          ],
        },
        request: {
          params: z.strictObject({ userId: realtimeSchemas.publicUserId }),
          query: null,
          headers: requestHeaders,
          body: addAndVerifySiteRequest,
        },
        responses: { 200: addAndVerifySiteResponse },
        errors: partnerUserErrors,
        errorResponse: errorEnvelopeSchemas(partnerUserErrors, realtimeSchemas.publicRequestId),
        resources: {
          reads: [{ type: 'partner.user', idFrom: 'params.userId' }],
          changes: [{ type: 'user.sites', idFrom: 'params.userId' }],
        },
        lifecycle: { introduced: '1.3.0' },
        docs: {
          summary: 'Add and verify a site',
          description: 'Verifies Search Console ownership of a site for a user via the given method and records the verified ownership.',
          tags: ['Sites'],
          examples: {
            request: { params: { userId: 'u_01' }, body: { siteUrl: 'https://example.com', method: 'DNS_TXT' } },
            response: {
              data: { siteUrl: 'https://example.com', site: { type: 'INET_DOMAIN', identifier: 'example.com' }, method: 'DNS_TXT', verified: true, owners: ['owner@example.com'] },
              meta: { requestId: 'req_01', surface: 'partner', version: '1.0' },
            },
          },
        },
      }),
      queryCrossSource: defineHttpOperation({
        id: 'partner.sites.cross.source.query',
        method: 'POST',
        path: '/sites/{siteId}/cross-source',
        visibility: 'public',
        semantics: { kind: 'query', sideEffects: 'none', idempotent: true, retry: 'idempotent', readConsistency: 'primary' },
        auth: {
          credentials: ['partner_key'],
          scopes: ['analytics:read'],
          ownership: [{ credential: 'partner_key', rule: 'authorized_site' }],
        },
        request: {
          params: z.strictObject({ siteId: realtimeSchemas.publicSiteId }),
          query: null,
          headers: requestHeaders,
          body: crossSourceRequest,
        },
        responses: { 200: crossSourceResponse },
        errors: partnerSiteErrors,
        errorResponse: errorEnvelopeSchemas(partnerSiteErrors, realtimeSchemas.publicRequestId),
        resources: { reads: [{ type: 'site.analytics', idFrom: 'params.siteId' }], changes: [] },
        lifecycle: { introduced: '1.3.0' },
        docs: {
          summary: 'Query cross-source analysis',
          description: 'Runs one predefined cross-source query joining crawl, CWV, and GSC signals for a site.',
          tags: ['Analytics'],
          examples: {
            request: { params: { siteId: 's_01' }, body: { queryKey: 'crawl-error-losing-impressions', rangeDays: 28, limit: 50 } },
            response: {
              data: { sources: ['crawl', 'gsc'], rows: [] },
              meta: { requestId: 'req_01', surface: 'partner', version: '1.0' },
            },
          },
        },
      }),
      enrichKeywords: defineHttpOperation({
        id: 'partner.keywords.enrich.query',
        method: 'POST',
        path: '/keywords/enrich',
        visibility: 'public',
        semantics: { kind: 'query', sideEffects: 'none', idempotent: true, retry: 'idempotent', readConsistency: 'primary' },
        auth: {
          credentials: ['user_key', 'partner_key'],
          scopes: ['analytics:read'],
          ownership: [
            { credential: 'user_key', rule: 'self' },
            { credential: 'partner_key', rule: 'partner_tenant' },
          ],
        },
        request: { params: null, query: null, headers: requestHeaders, body: keywordEnrichmentRequest },
        responses: { 200: keywordEnrichmentResponse },
        errors: partnerUserErrors,
        errorResponse: errorEnvelopeSchemas(partnerUserErrors, realtimeSchemas.publicRequestId),
        resources: { reads: [], changes: [] },
        lifecycle: { introduced: '1.3.0' },
        docs: {
          summary: 'Enrich keywords with metrics',
          description: 'Returns difficulty, search volume, and CPC estimates for up to 500 keywords.',
          tags: ['Analytics'],
          examples: {
            request: { body: { keywords: ['nuxt seo'] } },
            response: {
              data: { metrics: { 'nuxt seo': { difficulty: 40, searchVolume: 100, cpc: 1.2 } } },
              meta: { requestId: 'req_01', surface: 'partner', version: '1.0' },
            },
          },
        },
      }),
    },
  })

  const analytics = defineHttpSurface({
    name: 'analytics',
    prefix: '/api/analytics/v1',
    version: GSCDUMP_HTTP_V1_VERSION,
    operations: {
      queryRows: defineHttpOperation({
        id: 'analytics.rows.query',
        method: 'POST',
        path: '/sites/{siteId}/rows',
        visibility: 'public',
        semantics: {
          kind: 'query',
          sideEffects: 'none',
          idempotent: true,
          retry: 'idempotent',
          readConsistency: 'primary',
        },
        auth: {
          credentials: ['user_key', 'partner_key'],
          scopes: ['analytics:execute'],
          ownership: [
            { credential: 'user_key', rule: 'authorized_site' },
            { credential: 'partner_key', rule: 'authorized_site' },
          ],
        },
        request: {
          params: z.strictObject({ siteId: realtimeSchemas.publicSiteId }),
          query: null,
          headers: requestHeaders,
          body: analyticsRowsRequest,
        },
        responses: { 200: analyticsRowsResponse },
        errors: analyticsRowsErrors,
        errorResponse: errorEnvelopeSchemas(
          analyticsRowsErrors,
          realtimeSchemas.publicRequestId,
        ),
        resources: {
          reads: [{ type: 'site.analytics', idFrom: 'params.siteId' }],
          changes: [],
        },
        lifecycle: { introduced: '1.0.0' },
        docs: {
          summary: 'Query analytics rows',
          description: 'Executes an idempotent primary-consistent analytics row query.',
          tags: ['Analytics rows'],
          examples: {
            request: {
              params: { siteId: 's_01' },
              body: { dimensions: ['query'], metrics: ['clicks', 'impressions'], rowLimit: 100 },
            },
            response: {
              data: { rows: [] },
              meta: {
                requestId: 'req_01',
                surface: 'analytics',
                version: '1.0',
                sourceName: 'primary',
                sourceKind: 'sql',
                queryMs: 12,
              },
            },
          },
        },
      }),
      queryReport: defineHttpOperation({
        id: 'analytics.reports.query',
        method: 'POST',
        path: '/sites/{siteId}/reports',
        visibility: 'public',
        semantics: {
          kind: 'query',
          sideEffects: 'none',
          idempotent: true,
          retry: 'idempotent',
          readConsistency: 'primary',
        },
        auth: {
          credentials: ['user_key', 'partner_key'],
          scopes: ['analytics:execute'],
          ownership: [
            { credential: 'user_key', rule: 'authorized_site' },
            { credential: 'partner_key', rule: 'authorized_site' },
          ],
        },
        request: {
          params: z.strictObject({ siteId: realtimeSchemas.publicSiteId }),
          query: null,
          headers: requestHeaders,
          body: analyticsReportRequest,
        },
        responses: { 200: analyticsReportResponse },
        errors: analyticsRowsErrors,
        errorResponse: errorEnvelopeSchemas(
          analyticsRowsErrors,
          realtimeSchemas.publicRequestId,
        ),
        resources: {
          reads: [{ type: 'site.analytics', idFrom: 'params.siteId' }],
          changes: [],
        },
        lifecycle: { introduced: '1.0.0' },
        docs: {
          summary: 'Query an analytics report',
          description: 'Returns the hosted analytics list report with totals, comparison fields, and sync metadata.',
          tags: ['Analytics reports'],
          examples: {
            request: {
              params: { siteId: 's_01' },
              body: { state: { dimensions: ['query'], searchType: 'web' } },
            },
            response: {
              data: {
                rows: [],
                totalCount: 0,
                totals: { clicks: 0, impressions: 0, ctr: 0, position: 0 },
                meta: {
                  siteUrl: 'sc-domain:example.com',
                  syncStatus: 'synced',
                  newestDateSynced: null,
                  oldestDateSynced: null,
                  dataDelay: '0 days',
                },
              },
              meta: {
                requestId: 'req_01',
                surface: 'analytics',
                version: '1.0',
                sourceName: 'hosted-report',
                sourceKind: 'sql',
                queryMs: 12,
              },
            },
          },
        },
      }),
      queryReportDetail: defineHttpOperation({
        id: 'analytics.reports.detail.query',
        method: 'POST',
        path: '/sites/{siteId}/reports/detail',
        visibility: 'public',
        semantics: {
          kind: 'query',
          sideEffects: 'none',
          idempotent: true,
          retry: 'idempotent',
          readConsistency: 'primary',
        },
        auth: {
          credentials: ['user_key', 'partner_key'],
          scopes: ['analytics:execute'],
          ownership: [
            { credential: 'user_key', rule: 'authorized_site' },
            { credential: 'partner_key', rule: 'authorized_site' },
          ],
        },
        request: {
          params: z.strictObject({ siteId: realtimeSchemas.publicSiteId }),
          query: null,
          headers: requestHeaders,
          body: analyticsReportDetailRequest,
        },
        responses: { 200: analyticsReportDetailResponse },
        errors: analyticsRowsErrors,
        errorResponse: errorEnvelopeSchemas(
          analyticsRowsErrors,
          realtimeSchemas.publicRequestId,
        ),
        resources: {
          reads: [{ type: 'site.analytics', idFrom: 'params.siteId' }],
          changes: [],
        },
        lifecycle: { introduced: '1.0.0' },
        docs: {
          summary: 'Query analytics report detail',
          description: 'Returns the hosted analytics timeseries report with current and comparison totals.',
          tags: ['Analytics reports'],
          examples: {
            request: {
              params: { siteId: 's_01' },
              body: { state: { dimensions: ['date'], searchType: 'web' } },
            },
            response: {
              data: {
                daily: [],
                totals: { clicks: 0, impressions: 0, ctr: 0, position: 0 },
                meta: {
                  siteUrl: 'sc-domain:example.com',
                  syncStatus: 'synced',
                  newestDateSynced: null,
                  oldestDateSynced: null,
                  dataDelay: '0 days',
                },
              },
              meta: {
                requestId: 'req_01',
                surface: 'analytics',
                version: '1.0',
                sourceName: 'hosted-report',
                sourceKind: 'sql',
                queryMs: 12,
              },
            },
          },
        },
      }),
    },
  })

  const realtime = defineHttpSurface({
    name: 'realtime',
    prefix: '/api/realtime/v1',
    version: GSCDUMP_HTTP_V1_VERSION,
    operations: {
      getStreamHead: defineHttpOperation({
        id: 'realtime.stream.head.get',
        method: 'GET',
        path: '/stream/head',
        visibility: 'public',
        semantics: {
          kind: 'query',
          sideEffects: 'none',
          idempotent: true,
          retry: 'idempotent',
          readConsistency: 'primary',
        },
        auth: {
          credentials: ['user_key', 'partner_key'],
          scopes: ['realtime:connect'],
          ownership: [
            { credential: 'user_key', rule: 'principal_stream' },
            { credential: 'partner_key', rule: 'principal_stream' },
          ],
        },
        request: { params: null, query: null, headers: requestHeaders, body: null },
        responses: { 200: headResponse },
        errors: realtimeErrors,
        errorResponse: errorEnvelopeSchemas(
          realtimeErrors,
          realtimeSchemas.publicRequestId,
        ),
        resources: { reads: [], changes: [] },
        lifecycle: { introduced: '1.0.0' },
        docs: {
          summary: 'Get the inferred stream head',
          description: 'Returns the current durable head for the credential\'s one exact stream.',
          tags: ['Realtime'],
          examples: {
            request: {},
            response: {
              data: {
                head: { streamId: 'user:u_01', sequence: '142' },
              },
              meta: { requestId: 'req_01', surface: 'realtime', version: '1.0' },
            },
          },
        },
      }),
      createTicket: defineHttpOperation({
        id: 'realtime.tickets.create',
        method: 'POST',
        path: '/tickets',
        visibility: 'public',
        semantics: {
          kind: 'mutation',
          sideEffects: 'state',
          idempotent: false,
          retry: 'never',
          readConsistency: null,
        },
        auth: {
          credentials: ['user_key', 'partner_key'],
          scopes: ['realtime:connect'],
          ownership: [
            { credential: 'user_key', rule: 'principal_stream' },
            { credential: 'partner_key', rule: 'principal_stream' },
          ],
        },
        request: { params: null, query: null, headers: requestHeaders, body: realtimeSchemas.ticketRequest },
        responses: { 201: ticketResponse },
        errors: realtimeErrors,
        errorResponse: errorEnvelopeSchemas(
          realtimeErrors,
          realtimeSchemas.publicRequestId,
        ),
        resources: { reads: [], changes: [] },
        lifecycle: { introduced: '1.0.0' },
        docs: {
          summary: 'Create a realtime ticket',
          description: 'Creates a short-lived single-use ticket for the credential\'s inferred stream.',
          tags: ['Realtime'],
          examples: {
            request: { body: { origin: 'https://nuxtseo.com' } },
            response: {
              data: {
                socketUrl: 'wss://gscdump.com/ws/v1',
                protocol: GSCDUMP_REALTIME_SUBPROTOCOL,
                protocolVersion: GSCDUMP_REALTIME_PROTOCOL_VERSION,
                ticket: 'gscdump.ticket.v1.cGF5bG9hZA.c2lnbmF0dXJl',
                expiresAt: '2026-07-14T08:01:00.000Z',
                head: { streamId: 'user:u_01', sequence: '142' },
                maxConnectionSeconds: GSCDUMP_REALTIME_MAX_CONNECTION_SECONDS,
              },
              meta: { requestId: 'req_01', surface: 'realtime', version: '1.0' },
            },
          },
        },
      }),
    },
  })

  return {
    constants: {
      httpVersion: GSCDUMP_HTTP_V1_VERSION,
      realtimeProtocolVersion: GSCDUMP_REALTIME_PROTOCOL_VERSION,
      realtimeSubprotocol: GSCDUMP_REALTIME_SUBPROTOCOL,
      realtimeTicketPrefix: GSCDUMP_REALTIME_TICKET_PREFIX,
      realtimeTicketIssuer: GSCDUMP_REALTIME_TICKET_ISSUER,
      realtimeTicketAudience: GSCDUMP_REALTIME_TICKET_AUDIENCE,
      ping: GSCDUMP_REALTIME_PING,
      pong: GSCDUMP_REALTIME_PONG,
      ticketTtlSeconds: GSCDUMP_REALTIME_TICKET_TTL_SECONDS,
      maxConnectionSeconds: GSCDUMP_REALTIME_MAX_CONNECTION_SECONDS,
      ticketPolicy: GSCDUMP_REALTIME_TICKET_POLICY,
      connectionPolicy: GSCDUMP_REALTIME_CONNECTION_POLICY,
      replayPolicy: GSCDUMP_REALTIME_REPLAY_POLICY,
      limits: GSCDUMP_REALTIME_LIMITS,
      ackPolicy: GSCDUMP_REALTIME_ACK_POLICY,
      closeCodes: GSCDUMP_REALTIME_CLOSE_CODES,
      eventSemantics: REALTIME_V1_EVENT_SEMANTICS,
    },
    schemas: {
      requestMetadata,
      requestHeaders,
      responseMeta,
      errorEnvelope,
      analyticsReportDetailRequest,
      analyticsReportDetailResponse,
      analyticsReportRequest,
      analyticsReportResponse,
      analyticsRowsRequest,
      analyticsRowsResponse,
      analysisBundleQuery,
      analysisBundleResponse,
      analysisQuery,
      analysisResponse,
      availableSitesQuery,
      availableSitesResponse,
      indexingDiagnosticsQuery,
      indexingDiagnosticsResponse,
      indexingSummaryQuery,
      indexingSummaryResponse,
      indexingTransitionsQuery,
      indexingTransitionsResponse,
      indexingUrlsQuery,
      indexingUrlsResponse,
      keywordEnrichmentRequest,
      keywordEnrichmentResponse,
      lifecycleResponse,
      registerSiteRequest,
      sitemapChangesQuery,
      sitemapChangesResponse,
      sitemapsResponse,
      siteDeletionResponse,
      siteRegistrationResponse,
      streamHeadResponse: headResponse,
      ticketResponse,
      userRegistrationResponse,
      userTokenUpdateResponse,
      ...realtimeSchemas,
    },
    surfaces: { partner, analytics, realtime },
  }
}

export type GscdumpV1Protocol = ReturnType<typeof createGscdumpV1Protocol>
export type GscdumpV1Operation = HttpV1ProtocolOperation<GscdumpV1Protocol>
export type GscdumpV1OperationId = GscdumpV1Operation['id']
export type GscdumpV1ErrorEnvelope = z.infer<GscdumpV1Protocol['schemas']['errorEnvelope']['client']>
export type GscdumpV1RequestMetadata = z.infer<GscdumpV1Protocol['schemas']['requestMetadata']>
export type AnalyticsRowsV1Request = z.infer<GscdumpV1Protocol['schemas']['analyticsRowsRequest']>
export type AnalyticsRowsV1Response = z.infer<GscdumpV1Protocol['schemas']['analyticsRowsResponse']['client']>
export type AnalyticsReportV1Request = z.infer<GscdumpV1Protocol['schemas']['analyticsReportRequest']>
export type AnalyticsReportV1Response = z.infer<GscdumpV1Protocol['schemas']['analyticsReportResponse']['client']>
export type AnalyticsReportDetailV1Request = z.infer<GscdumpV1Protocol['schemas']['analyticsReportDetailRequest']>
export type AnalyticsReportDetailV1Response = z.infer<GscdumpV1Protocol['schemas']['analyticsReportDetailResponse']['client']>
export type PartnerAnalysisV1Response = z.infer<GscdumpV1Protocol['schemas']['analysisResponse']['client']>
export type PartnerAnalysisBundleV1Response = z.infer<GscdumpV1Protocol['schemas']['analysisBundleResponse']['client']>
export type PartnerAvailableSitesV1Response = z.infer<GscdumpV1Protocol['schemas']['availableSitesResponse']['client']>
export type PartnerIndexingV1Response = z.infer<GscdumpV1Protocol['schemas']['indexingSummaryResponse']['client']>
export type PartnerIndexingUrlsV1Response = z.infer<GscdumpV1Protocol['schemas']['indexingUrlsResponse']['client']>
export type PartnerIndexingTransitionsV1Response = z.infer<GscdumpV1Protocol['schemas']['indexingTransitionsResponse']['client']>
export type PartnerIndexingDiagnosticsV1Response = z.infer<GscdumpV1Protocol['schemas']['indexingDiagnosticsResponse']['client']>
export type PartnerSitemapsV1Response = z.infer<GscdumpV1Protocol['schemas']['sitemapsResponse']['client']>
export type PartnerSitemapChangesV1Response = z.infer<GscdumpV1Protocol['schemas']['sitemapChangesResponse']['client']>
export type PartnerSiteRegistrationV1Response = z.infer<GscdumpV1Protocol['schemas']['siteRegistrationResponse']['client']>
export type PartnerSiteDeletionV1Response = z.infer<GscdumpV1Protocol['schemas']['siteDeletionResponse']['client']>
export type PartnerUserLifecycleV1Response = z.infer<GscdumpV1Protocol['schemas']['lifecycleResponse']['client']>

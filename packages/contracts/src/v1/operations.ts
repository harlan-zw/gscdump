import type { HttpV1ErrorCode } from './http'
import type { RealtimeV1Schemas } from './realtime'
import { z } from 'zod'
import {
  accountNextActions,
  accountStatuses,
  analyticsNextActions,
  analyticsStatuses,
  indexingNextActions,
  indexingStatuses,
  lifecycleErrorCodes,
  propertyNextActions,
  propertyStatuses,
  querySourceModes,
  sitemapNextActions,
  sitemapStatuses,
} from '../onboarding'
import {
  builderStateSchema,
  gscComparisonFilterSchema,
  gscdumpAnalysisBundleResponseSchema,
  gscdumpAnalysisPresetSchema,
  gscdumpAnalysisResponseSchema,
  gscdumpAvailableSiteSchema,
  gscdumpDataDetailResponseSchema,
  gscdumpDataResponseSchema,
  gscdumpIndexingDiagnosticsResponseSchema,
  gscdumpIndexingResponseSchema,
  gscdumpSitemapChangesResponseSchema,
  gscdumpSitemapsResponseSchema,
  gscdumpSiteRegistrationSchema,
  gscdumpUserRegistrationSchema,
  indexingUrlsResponseSchema,
  registerPartnerSiteSchema,
  registerPartnerUserSchema,
  searchTypeSchema,
  updatePartnerUserTokensSchema,
} from '../schemas'
import {
  defineHttpOperation,
  defineHttpSurface,
  defineResponseObject,
  defineSuccessResponse,
  HTTP_V1_ERROR_CODES,
} from './http'
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

export const GSCDUMP_HTTP_V1_VERSION = '1.0' as const

interface NormalizedFilterV1 {
  _filters: Array<{
    dimension: string
    operator: string
    expression: string
    expression2?: string
  }>
  _nestedGroups?: NormalizedFilterV1[]
  _groupType?: 'and' | 'or'
}

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

// The nested producer/client pair is intentionally inferred from one field definition.
// eslint-disable-next-line ts/explicit-function-return-type
function lifecycleResponseSchemas(ids: RealtimeV1Schemas) {
  const progress = defineResponseObject({
    completed: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(),
    total: z.number().int().nonnegative(),
    percent: z.number().min(0).max(100),
  })
  const latestError = defineResponseObject({
    code: z.enum(lifecycleErrorCodes),
    message: z.string(),
    retryable: z.boolean(),
  })
  const account = defineResponseObject({
    status: z.enum(accountStatuses),
    grantedScopes: z.array(z.string()),
    missingScopes: z.array(z.string()),
    nextAction: z.enum(accountNextActions),
  })
  const property = defineResponseObject({
    status: z.enum(propertyStatuses),
    nextAction: z.enum(propertyNextActions),
  })
  const syncedRange = defineResponseObject({
    oldest: z.iso.date().nullable(),
    newest: z.iso.date().nullable(),
  })
  const analytics = defineResponseObject(
    {
      status: z.enum(analyticsStatuses),
      progress: progress.producer,
      queryable: z.boolean(),
      sourceMode: z.enum(querySourceModes),
      syncedRange: syncedRange.producer,
      nextAction: z.enum(analyticsNextActions),
    },
    {
      status: z.enum(analyticsStatuses),
      progress: progress.client,
      queryable: z.boolean(),
      sourceMode: z.enum(querySourceModes),
      syncedRange: syncedRange.client,
      nextAction: z.enum(analyticsNextActions),
    },
  )
  const sitemaps = defineResponseObject({
    status: z.enum(sitemapStatuses),
    discoveredCount: z.number().int().nonnegative(),
    nextAction: z.enum(sitemapNextActions),
  })
  const indexing = defineResponseObject(
    {
      status: z.enum(indexingStatuses),
      eligible: z.boolean(),
      reason: z.string().nullable(),
      progress: progress.producer,
      nextAction: z.enum(indexingNextActions),
    },
    {
      status: z.enum(indexingStatuses),
      eligible: z.boolean(),
      reason: z.string().nullable(),
      progress: progress.client,
      nextAction: z.enum(indexingNextActions),
    },
  )
  const site = defineResponseObject(
    {
      siteId: ids.publicSiteId,
      externalSiteId: z.string().nullable(),
      requestedUrl: z.string().min(1),
      gscPropertyUrl: z.string().nullable(),
      permissionLevel: z.string().nullable(),
      property: property.producer,
      analytics: analytics.producer,
      sitemaps: sitemaps.producer,
      indexing: indexing.producer,
      latestError: latestError.producer.nullable(),
      updatedAt: z.iso.datetime(),
    },
    {
      siteId: ids.publicSiteId,
      externalSiteId: z.string().nullable(),
      requestedUrl: z.string().min(1),
      gscPropertyUrl: z.string().nullable(),
      permissionLevel: z.string().nullable(),
      property: property.client,
      analytics: analytics.client,
      sitemaps: sitemaps.client,
      indexing: indexing.client,
      latestError: latestError.client.nullable(),
      updatedAt: z.iso.datetime(),
    },
  )
  return defineResponseObject(
    {
      userId: ids.publicUserId,
      partnerId: ids.publicPartnerId.nullable(),
      currentTeamId: ids.publicTeamId.nullable(),
      account: account.producer,
      sites: z.array(site.producer),
    },
    {
      userId: ids.publicUserId,
      partnerId: ids.publicPartnerId.nullable(),
      currentTeamId: ids.publicTeamId.nullable(),
      account: account.client,
      sites: z.array(site.client),
    },
  )
}

// The exact inferred return is the source for all exported schema-derived DTO types.
// eslint-disable-next-line ts/explicit-function-return-type
export function createGscdumpV1Protocol() {
  const realtimeSchemas = createRealtimeV1Schemas()
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

  const lifecycleData = lifecycleResponseSchemas(realtimeSchemas)
  const lifecycleResponse = defineSuccessResponse(lifecycleData, partnerResponseMeta)

  const dimensions = ['page', 'query', 'queryCanonical', 'country', 'device', 'date', 'searchAppearance', 'hour'] as const
  const metrics = ['clicks', 'impressions', 'ctr', 'position'] as const
  const filterDimension = z.enum([...dimensions, ...metrics, 'searchType'])
  const singleExpressionFilterOperators = [
    'equals',
    'notEquals',
    'contains',
    'notContains',
    'includingRegex',
    'excludingRegex',
    'gte',
    'gt',
    'lte',
    'lt',
    'metricGte',
    'metricGt',
    'metricLte',
    'metricLt',
    'topLevel',
  ] as const
  const normalizedFilterLeaf = z.union([
    z.strictObject({
      dimension: filterDimension,
      operator: z.enum(singleExpressionFilterOperators),
      expression: z.string(),
    }),
    z.strictObject({
      dimension: filterDimension,
      operator: z.enum(['between', 'metricBetween']),
      expression: z.string(),
      expression2: z.string(),
    }),
  ])
  const normalizedFilter: z.ZodType<NormalizedFilterV1> = z.lazy(() => z.union([
    z.strictObject({
      _filters: z.array(normalizedFilterLeaf).min(1),
      _nestedGroups: z.array(normalizedFilter).optional(),
      _groupType: z.enum(['and', 'or']).optional(),
    }),
    z.strictObject({
      _filters: z.array(normalizedFilterLeaf).max(0),
      _nestedGroups: z.array(normalizedFilter).min(1),
      _groupType: z.enum(['and', 'or']).optional(),
    }),
  ]))
  const analyticsRowsRequest = z.strictObject({
    dimensions: z.array(z.enum(dimensions)).min(1),
    metrics: z.array(z.enum(metrics)).optional(),
    filter: normalizedFilter.optional(),
    prefilter: normalizedFilter.optional(),
    orderBy: z.strictObject({
      column: z.enum([...metrics, 'date']),
      dir: z.enum(['asc', 'desc']),
    }).optional(),
    rowLimit: z.number().int().positive().max(25_000).optional(),
    startRow: z.number().int().nonnegative().optional(),
    dataState: z.enum(['final', 'all', 'hourly_all']).optional(),
    aggregationType: z.enum(['auto', 'byPage', 'byProperty', 'byNewsShowcasePanel']).optional(),
    searchType: z.enum(['web', 'image', 'video', 'news', 'discover', 'googleNews']).optional(),
  })
  const analyticsRowData = defineResponseObject({
    rows: z.array(z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()]))),
  })
  const analyticsMeta = defineResponseObject({
    requestId: realtimeSchemas.publicRequestId,
    surface: z.literal('analytics'),
    version: z.literal(GSCDUMP_HTTP_V1_VERSION),
    sourceName: z.string().min(1),
    sourceKind: z.enum(['row', 'sql']),
    queryMs: z.number().nonnegative(),
  })
  const analyticsRowsResponse = defineSuccessResponse(analyticsRowData, analyticsMeta)

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
  const indexingDiagnosticsResponse = defineSuccessResponse(defineResponseObject(gscdumpIndexingDiagnosticsResponseSchema.shape), partnerResponseMeta)
  const sitemapsResponse = defineSuccessResponse(defineResponseObject(gscdumpSitemapsResponseSchema.shape), partnerResponseMeta)
  const sitemapChangesResponse = defineSuccessResponse(defineResponseObject({
    ...gscdumpSitemapChangesResponseSchema.shape,
    summary: gscdumpSitemapChangesResponseSchema.shape.summary.unwrap(),
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
  const ticketData = defineResponseObject(
    ticketDataProducerShape,
    { ...ticketDataProducerShape, head: responseStreamHead.client },
  )
  const ticketResponse = defineSuccessResponse(ticketData, realtimeResponseMeta)

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
                meta: { siteUrl: 'sc-domain:example.com', gscPropertyUrl: 'sc-domain:example.com', syncStatus: 'synced' },
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
            response: { data: { added: [], removed: [], summary: { totalAdded: 0, totalRemoved: 0, period: { days: 28 } } }, meta: { requestId: 'req_01', surface: 'partner', version: '1.0' } },
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
      indexingUrlsQuery,
      indexingUrlsResponse,
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
export type PartnerIndexingDiagnosticsV1Response = z.infer<GscdumpV1Protocol['schemas']['indexingDiagnosticsResponse']['client']>
export type PartnerSitemapsV1Response = z.infer<GscdumpV1Protocol['schemas']['sitemapsResponse']['client']>
export type PartnerSitemapChangesV1Response = z.infer<GscdumpV1Protocol['schemas']['sitemapChangesResponse']['client']>
export type PartnerSiteRegistrationV1Response = z.infer<GscdumpV1Protocol['schemas']['siteRegistrationResponse']['client']>
export type PartnerSiteDeletionV1Response = z.infer<GscdumpV1Protocol['schemas']['siteDeletionResponse']['client']>
export type PartnerUserLifecycleV1Response = z.infer<GscdumpV1Protocol['schemas']['lifecycleResponse']['client']>
export type RealtimeTicketV1Response = z.infer<GscdumpV1Protocol['schemas']['ticketResponse']['client']>

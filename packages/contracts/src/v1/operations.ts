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
      analyticsRowsRequest,
      analyticsRowsResponse,
      lifecycleResponse,
      streamHeadResponse: headResponse,
      ticketResponse,
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
export type PartnerUserLifecycleV1Response = z.infer<GscdumpV1Protocol['schemas']['lifecycleResponse']['client']>
export type RealtimeTicketV1Response = z.infer<GscdumpV1Protocol['schemas']['ticketResponse']['client']>

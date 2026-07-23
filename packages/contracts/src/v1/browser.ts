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
import { defineResponseObject, defineSuccessResponse } from './http-core'
import { createRealtimeV1Schemas } from './realtime'
import { GSCDUMP_HTTP_V1_VERSION } from './version'

export interface NormalizedFilterV1 {
  _filters: Array<{
    dimension: string
    operator: string
    expression: string
    expression2?: string
  }>
  _nestedGroups?: NormalizedFilterV1[]
  _groupType?: 'and' | 'or'
}

export const GSCDUMP_V1_ANALYTICS_DIMENSIONS = [
  'page',
  'query',
  'queryCanonical',
  'country',
  'device',
  'date',
  'searchAppearance',
  'hour',
] as const

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

// The exact inferred return keeps query definitions tied to their runtime schemas.
// eslint-disable-next-line ts/explicit-function-return-type
export function createGscdumpV1BrowserSchemas(
  realtimeSchemas: RealtimeV1Schemas = createRealtimeV1Schemas(),
) {
  const partnerResponseMeta = defineResponseObject({
    requestId: realtimeSchemas.publicRequestId,
    surface: z.literal('partner'),
    version: z.literal(GSCDUMP_HTTP_V1_VERSION),
  })
  const lifecycleResponse = defineSuccessResponse(
    lifecycleResponseSchemas(realtimeSchemas),
    partnerResponseMeta,
  )

  const dimensions = GSCDUMP_V1_ANALYTICS_DIMENSIONS
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

  return {
    analyticsRowsRequest,
    analyticsRowsResponse: defineSuccessResponse(analyticsRowData, analyticsMeta),
    lifecycleResponse,
    ticketRequest: realtimeSchemas.ticketRequest,
    ticketResponse: realtimeSchemas.ticketResponseClient,
  }
}
